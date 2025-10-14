var { spawn } = require('child_process');
var path = require('path');
var fs = require('fs');
var braid_text = require("braid-text")
var braid_blob = require("braid-blob");
var { version } = require('os');
var braid_fetch = require('braid-http').fetch

// Keep track of all spawned processes
var childProcesses = new Set();
var server = null;

// Cleanup function
function cleanup() {
    console.log('\nCleaning up...');
    
    // Kill all child processes
    childProcesses.forEach(child => {
        if (!child.killed) {
            console.log(`Killing child process ${child.pid}`);
            // Try SIGTERM first, then SIGKILL if needed
            child.kill('SIGTERM');
            setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
            }, 1000);
        }
    });
    
    // Close the server if it exists
    if (server) {
        console.log('Closing HTTP server...');
        server.close();
    }
    
    // Give a moment for cleanup then exit
    setTimeout(() => {
        process.exit(0);
    }, 200);
}

// Register cleanup handlers for various exit scenarios
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT');
    cleanup();
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM');
    cleanup();
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    cleanup();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    cleanup();
});

// Also cleanup on normal exit
process.on('exit', () => {
    // Synchronous cleanup only here
    childProcesses.forEach(child => {
        if (!child.killed) {
            try {
                child.kill('SIGKILL');
            } catch (e) {
                // Ignore errors during final cleanup
            }
        }
    });
});

var config = {
    braidfs_port: 60111,
    braid_text_port: 60112
}

braid_text.db_folder = `${__dirname}/test_braid_text_db`
fs.rmSync(braid_text.db_folder, { recursive: true, force: true });

braid_blob.db_folder = `${__dirname}/test_braid_blob_db`
fs.rmSync(braid_blob.db_folder, { recursive: true, force: true });

var scriptPath = path.resolve(__dirname, '../index.js');

var syncBasePath = path.resolve(__dirname, 'test_http');
fs.rmSync(syncBasePath, { recursive: true, force: true });

// Store server reference for cleanup
server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    braid_text.free_cors(res)
    if (req.method === 'OPTIONS') return res.end()

    if (req.url.startsWith('/blobs/slow') && req.headers.subscribe) {
        res.statusCode = 209
        res.write('\n\n')
    } else if (req.url.startsWith('/blobs/')) {
        braid_blob.serve(req, res)
    } else {
        if (!(await braid_text.get(req.url, {})).version.length) {
            await braid_text.put(req.url, {body: 'This is a fresh blank document, ready for you to edit.' })
        }
        braid_text.serve(req, res)
    }
}).listen(config.braid_text_port, () =>
    console.log(`server started on port ${config.braid_text_port}`))

// Modified spawn function to track child processes
var spawnNodeScript = (params = []) => {
    var child = spawn('node', [scriptPath, '--sync-base', syncBasePath, ...params], {
        stdio: ['inherit', 'pipe', 'pipe']
    });
    
    // Add to tracking set
    childProcesses.add(child);
    
    // Remove from set when process exits
    child.on('exit', () => {
        childProcesses.delete(child);
    });
    
    // Forward stdout
    child.stdout.on('data', (data) => {
        process.stdout.write(data);
    });
    
    // Forward stderr
    child.stderr.on('data', (data) => {
        process.stderr.write(data);
    });

    return child;
};

// Modified bash command spawner to track processes
var spawnBashCommand = async (command, args = [], stdinContent = null) => {
    var { spawn: spawnSync } = require('child_process');
    var scriptShPath = path.resolve(__dirname, '../index.sh');
    var env = { ...process.env, BRAIDFS_BASE_DIR: syncBasePath };
    
    var child = spawnSync('bash', [scriptShPath, command, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // Add to tracking set
    childProcesses.add(child);
    
    // Write to stdin if content provided
    if (stdinContent !== null) {
        child.stdin.write(stdinContent);
    }
    child.stdin.end();
    
    // Collect output
    let output = '';
    let error = '';
    
    child.stdout.on('data', (data) => {
        output += data.toString();
    });
    
    child.stderr.on('data', (data) => {
        error += data.toString();
    });
    
    // Wait for command to complete
    var exitCode = await new Promise((resolve) => {
        child.on('close', (code) => {
            childProcesses.delete(child); // Remove when done
            resolve(code);
        });
    });
    
    return { output, error, exitCode };
};

function fail(why) {
    console.log(`FAILING: ${why}`)
    cleanup(); // Use cleanup instead of direct exit
}

void (async () => {
    // First spawn to create the config
    var initialChild = spawnNodeScript();
    await new Promise(resolve => setTimeout(resolve, 100));
    initialChild.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Modify the config file
    var configPath = path.join(syncBasePath, '.braidfs', 'config');
    var configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    configData.port = config.braidfs_port;
    fs.writeFileSync(configPath, JSON.stringify(configData));
    
    // Spawn the node script again with the modified config
    spawnNodeScript(['run']);
    await new Promise(resolve => setTimeout(resolve, 100));

    if (true) {
        // Sync something..
        spawnNodeScript(['sync', `http://localhost:${config.braid_text_port}/z`]);
        await new Promise(resolve => setTimeout(resolve, 300));

        // Now test the "editing" command
        
        // Read the current content of the z file
        var zFilePath = path.join(syncBasePath, `localhost:${config.braid_text_port}`, 'z');
        console.log(`zFilePath = ${zFilePath}`)
        var currentContent = fs.readFileSync(zFilePath, 'utf8');
        console.log(`currentContent = ${currentContent}`)

        // Run editing command
        var editingResult = await spawnBashCommand('editing', [zFilePath], currentContent);
        console.log(`editingResult.output = ${editingResult.output}`)
        
        var newContent = 'This document has been edited via braidfs!';
        var parentVersion = editingResult.output
        
        // Run edited command
        var editedResult = await spawnBashCommand('edited', [zFilePath, parentVersion], newContent);
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify the file was updated
        var updatedContent = fs.readFileSync(zFilePath, 'utf8');
        console.log(`updatedContent = ${updatedContent}`)
        if (newContent !== updatedContent) return fail('new content not what we wanted')
        
        // Check if the change propagated back to the braid-text server
        var response = await fetch(`http://localhost:${config.braid_text_port}/z`);
        var serverContent = await response.text();
        if (newContent !== serverContent) return fail('server z content not what we wanted')

        // Try syncing a blob
        spawnNodeScript(['sync', `http://localhost:${config.braid_text_port}/blobs/z`]);
        await new Promise(resolve => setTimeout(resolve, 100));

        // Try modifying the blob "externally"
        await braid_fetch(`http://localhost:${config.braid_text_port}/blobs/z`, {
            method: 'PUT',
            body: 'yo!',
            version: ["5"]
        })
        await new Promise(resolve => setTimeout(resolve, 100))

        // Verify the current content of the blobs/z file
        var blobszFilePath = path.join(syncBasePath, `localhost:${config.braid_text_port}`, 'blobs/z');
        var currentContent = fs.readFileSync(blobszFilePath, 'utf8');
        if (currentContent !== 'yo!') return fail('blobs/z content not what we wanted')

        // Try modifying the blob "internally"
        fs.writeFileSync(path.join(syncBasePath, `localhost:${config.braid_text_port}/blobs/z`), 'YO!');
        await new Promise(resolve => setTimeout(resolve, 100))

        // Check if the change propagated back to the server
        var response = await fetch(`http://localhost:${config.braid_text_port}/blobs/z`);
        var serverContent = await response.text();
        console.log(`serverContent = ${serverContent}`)
        if (serverContent !== 'YO!') return fail('server blob/z content not what we wanted')
    }

    // Try getting the binary read-file code to run before it gets the first subscription response
    spawnNodeScript(['sync', `http://localhost:${config.braid_text_port}/blobs/slow`]);
    await new Promise(resolve => setTimeout(resolve, 100));

    fs.writeFileSync(path.join(syncBasePath, `localhost:${config.braid_text_port}/blobs/slow`), 'boop');
    await new Promise(resolve => setTimeout(resolve, 300));

    // Check if the change propagated back to the server
    var response = await fetch(`http://localhost:${config.braid_text_port}/blobs/slow`);
    var serverContent = await response.text();
    console.log(`serverContent = ${serverContent}`)
    if (serverContent !== 'boop') return fail('server blob/slow content not what we wanted')

    console.log('TESTS PASSED!')
    cleanup()
})()
