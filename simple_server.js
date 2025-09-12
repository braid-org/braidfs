var braid_text = require('braid-text'),
    braidify = require('braid-http').http_server,
    fs = require('fs'),
    path = require('path'),
    port = 8888

// Helper function to check if a file is binary based on its extension
function is_binary(filename) {
    const binaryExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.mp3', '.zip', '.tar', '.rar', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.img', '.bmp', '.tiff', '.svg', '.webp', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.wav', '.flac', '.aac', '.ogg', '.wma', '.7z', '.gz', '.bz2', '.xz'];
    return binaryExtensions.includes(path.extname(filename).toLowerCase());
}

var subscriptions = {};

// Create a hash key for subscriptions based on peer and URL
var hash = (req) => JSON.stringify([req.headers.peer, req.url]);

var server = require("http").createServer(braidify(async (req, res) => {
    console.log(`${req.method} ${req.url}`);

    // Enable CORS
    braid_text.free_cors(res);

    // Handle OPTIONS request
    if (req.method === 'OPTIONS') return res.end();

    // Handle binary files (image, video, etc.)
    if (is_binary(req.url)) {
        if (req.method === 'GET') {
            // Handle GET request for binary files
            if (req.subscribe) {
                // Start a subscription for future updates. Also ensure a file exists with an early timestamp.
                res.startSubscription({ onClose: () => delete subscriptions[hash(req)] });
                subscriptions[hash(req)] = res;

                const filename = path.join(__dirname, req.url);
                try {
                    const dir = path.dirname(filename);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    if (!fs.existsSync(filename)) {
                        // Create an empty file and set mtime to early timestamp (e.g., epoch + 1ms)
                        fs.writeFileSync(filename, Buffer.alloc(0));
                        const early = new Date(1);
                        fs.utimesSync(filename, early, early);
                    }
                } catch (e) {
                    console.log(`Error ensuring file on subscribe ${filename}: ${e.message}`);
                }
            } else {
                res.statusCode = 200;
            }

            // Read binary file and send it in response
            const filename = path.join(__dirname, req.url);
            try {
                if (fs.existsSync(filename)) {
                    const stat = fs.statSync(filename);
                    // console.log(stat.mtimeMs)
                    const fileData = fs.readFileSync(filename);
                    // Restore original timestamps to prevent mtime changes from file system read operations
                    fs.utimesSync(filename, stat.atime, stat.mtime);
                    res.setHeader('Last-Modified', new Date(Number(stat.mtimeMs)).toUTCString());
                    res.setHeader('Last-Modified-Ms', String(Number(stat.mtimeMs)));
                    res.sendUpdate({ body: fileData, version: [String(Number(stat.mtimeMs))] });
                } else {
                    // File doesn't exist on server, return empty response
                    // It cannot reach this point if request is subscribed to!
                    res.statusCode = 404;
                    res.end("File not found");
                }
            } catch (err) {
                console.log(`Error reading binary file ${filename}: ${err.message}`);
                res.statusCode = 500;
                res.end("Internal server error");
            }

            if (!req.subscribe) res.end();
        } else if (req.method === 'PUT') {
            // Handle PUT request to update binary files
            let body = [];
            req.on('data', chunk => body.push(chunk));
            req.on('end', () => {
                body = Buffer.concat(body);

                const filename = path.join(__dirname, req.url);
                
                try {
                    // Ensure directory exists
                    const dir = path.dirname(filename);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    
                    // Write the file
                    fs.writeFileSync(filename, body);

                    // Get timestamp from header or use current time
                    const timestamp = req.headers['x-timestamp'] ? Number(req.headers['x-timestamp']) : Date.now();
                    console.log(timestamp)
                    const mtimeSeconds = timestamp / 1000;
                    fs.utimesSync(filename, mtimeSeconds, mtimeSeconds);
                    console.log(fs.statSync(filename).mtimeMs);

                    console.log(`Binary file written: ${filename}`);

                    const stat = fs.statSync(filename);

                    // Notify all subscriptions of the update (except the peer which made the PUT request itself)
                    for (var k in subscriptions) {
                        var [peer, url] = JSON.parse(k);
                        // console.log(req.headers.peer)
                        if (peer !== req.headers.peer && url === req.url) {
                            subscriptions[k].sendUpdate({ body, version: [String(Number(stat.mtimeMs))] });
                        }
                    }

                    res.setHeader('Last-Modified', new Date(Number(stat.mtimeMs)).toUTCString());
                    res.setHeader('Last-Modified-Ms', String(Number(stat.mtimeMs)));
                    res.statusCode = 200;
                    res.end();
                } catch (err) {
                    console.log(`Error writing binary file ${filename}: ${err.message}`);
                    res.statusCode = 500;
                    res.end("Internal server error");
                }
            });
        } // Not needed anymore
        // else if (req.method === 'HEAD') {
        //     // Handle HEAD request to check if binary file exists
        //     const filename = path.join(__dirname, req.url);
        //     if (fs.existsSync(filename)) {
        //         const stat = fs.statSync(filename);
        //         res.setHeader('Last-Modified', new Date(Number(stat.mtimeMs)).toUTCString());
        //         res.setHeader('Last-Modified-Ms', String(Number(stat.mtimeMs)));
        //         res.statusCode = 200;
        //         res.end();
        //     } else {
        //         res.statusCode = 404;
        //         res.end();
        //     }
        // }
    } else {
        // Serve collaborative text documents
        braid_text.serve(req, res);
    }
}));

server.listen(port, () => {
    console.log(`server started on port ${port}`);
});

// curl -X PUT --data-binary @image.png http://localhost:8888/image.png
// curl http://localhost:8888/image.png --output downloaded_image.png
