var { spawn } = require('child_process');
var path = require('path');
var fs = require('fs');
var braid_text = require("braid-text")
var braid_blob = require("braid-blob");
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
braid_blob.meta_folder = `${__dirname}/test_braid_blob_meta`
fs.rmSync(braid_blob.db_folder, { recursive: true, force: true });
fs.rmSync(braid_blob.meta_folder, { recursive: true, force: true });

var scriptPath = path.resolve(__dirname, '../index.js');

var syncBasePath = path.resolve(__dirname, 'test_http');
fs.rmSync(syncBasePath, { recursive: true, force: true });

// Store server reference for cleanup
var failed_once = false
server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    braid_text.free_cors(res)
    if (req.method === 'OPTIONS') return res.end()

    if (req.url.includes('readonly')) {
        res.setHeader('Editable', 'false')
        if (req.method.startsWith('P') && req.headers.cookie !== 'PASS') {
            res.statusCode = 401
            return res.end('')
        }
    }

    if (req.url.startsWith('/blobs/failonce')) {
        if (null === await braid_blob.get(req.url))
            await braid_blob.put(req.url, 'init', {version: ['1']})
        if (req.method.startsWith('P') && !failed_once) {
            failed_once = true
            res.statusCode = 409
            return res.end('')
        }
    }

    if (req.url.startsWith('/blobs/')) {
        braid_blob.serve(req, res)
    } else {
        if (!(await braid_text.get(req.url, {})).version.length) {
            await braid_text.put(req.url, {body: 'This is a fresh blank document, ready for you to edit.' })
        }
        braid_text.serve(req, res)
    }
}).listen(config.braid_text_port, 'localhost', () =>
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
    var child = spawnNodeScript();
    await new Promise(resolve => setTimeout(resolve, 100));
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Modify the config file
    var configPath = path.join(syncBasePath, '.braidfs', 'config');
    var configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    configData.port = config.braidfs_port;
    configData.reconnect_delay_ms = 10;
    fs.writeFileSync(configPath, JSON.stringify(configData));
    
    // Spawn the node script again with the modified config
    var child = spawnNodeScript(['run']);
    await new Promise(resolve => setTimeout(resolve, 100));

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

    // Check syncing a readonly file..
    spawnNodeScript(['sync', `http://localhost:${config.braid_text_port}/blobs/readonly`]);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Try modifying the blob "externally"
    await braid_fetch(`http://localhost:${config.braid_text_port}/blobs/readonly`, {
        method: 'PUT',
        body: 'poof',
        version: ["7"],
        headers: { cookie: 'PASS' }
    })
    await new Promise(resolve => setTimeout(resolve, 100))

    // Check that it is readonly on disk..
    var fullpath = path.join(syncBasePath, `localhost:${config.braid_text_port}/blobs/readonly`)
    if (!(await file_exists(fullpath))) return fail('file should have been there')
    if (!(await is_read_only(fullpath))) return fail('was supposed to be readonly')

    // Verify the current content
    if (fs.readFileSync(fullpath, 'utf8') !== 'poof') return fail('blobs/readonly content not what we wanted')

    // Try modifying the blob "internally"
    await set_read_only(fullpath, false)
    fs.writeFileSync(fullpath, 'hey');
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify the current content reverted
    if (fs.readFileSync(fullpath, 'utf8') !== 'poof') return fail('blobs/readonly content not what we wanted')

    // shutdown
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100))

    // Try modifying the blob "internally" again
    fs.writeFileSync(path.join(syncBasePath, `localhost:${config.braid_text_port}/blobs/z`), 'hope');
    await new Promise(resolve => setTimeout(resolve, 100))

    // restart braidfs
    var child = spawnNodeScript(['run']);
    await new Promise(resolve => setTimeout(resolve, 200));

    // Check if the change propagated back to the server
    var response = await fetch(`http://localhost:${config.braid_text_port}/blobs/z`);
    var serverContent = await response.text();
    console.log(`serverContent = ${serverContent}`)
    if (serverContent !== 'hope') return fail('second server blob/z content not what we wanted')

    // Check syncing a file that fails to upload once..
    spawnNodeScript(['sync', `http://localhost:${config.braid_text_port}/blobs/failonce`]);
    await new Promise(resolve => setTimeout(resolve, 200));

    fs.writeFileSync(path.join(syncBasePath, `localhost:${config.braid_text_port}/blobs/failonce`), 'hope2');

    await new Promise(resolve => setTimeout(resolve, 200))

    // Check if the change propagated back to the server
    var response = await fetch(`http://localhost:${config.braid_text_port}/blobs/failonce`);
    var serverContent = await response.text();
    console.log(`serverContent = ${serverContent}`)
    if (serverContent !== 'hope2') return fail('failonce did not get set..')

    // Check syncing another readonly file..
    spawnNodeScript(['sync', `http://localhost:${config.braid_text_port}/readonly`]);
    await new Promise(resolve => setTimeout(resolve, 100));

    // ..that it is readonly on disk..
    var fullpath = path.join(syncBasePath, `localhost:${config.braid_text_port}/readonly`)
    if (!(await file_exists(fullpath))) return fail('file should have been there')
    if (!(await is_read_only(fullpath))) return fail('was supposed to be readonly')

    console.log('TESTS PASSED!')
    cleanup()
})()

async function file_exists(fullpath) {
    try {
        return await require('fs').promises.stat(fullpath)
    } catch (e) {}
}

async function is_read_only(fullpath) {
    const stat = await require('fs').promises.stat(fullpath)
    return require('os').platform() === "win32" ?
        !!(stat.mode & 0x1) :
        !(stat.mode & 0o200)
}

async function set_read_only(fullpath, read_only) {
    // console.log(`set_read_only(${fullpath}, ${read_only})`)

    if (require('os').platform() === "win32") {
        await new Promise((resolve, reject) => {
            require("child_process").exec(`fsutil file setattr readonly "${fullpath}" ${!!read_only}`, (error) => error ? reject(error) : resolve())
        })
    } else {
        let mode = (await require('fs').promises.stat(fullpath)).mode
        if (read_only) mode &= ~0o222
        else mode |= 0o200
        await require('fs').promises.chmod(fullpath, mode)
    }
}
