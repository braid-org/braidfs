#!/usr/bin/env node

let http = require('http');
let { diff_main } = require('./diff.js')
let braid_text = require("braid-text");
let braid_fetch = require('braid-http').fetch

process.on("unhandledRejection", (x) => console.log(`unhandledRejection: ${x.stack}`))
process.on("uncaughtException", (x) => console.log(`uncaughtException: ${x.stack}`))

let braidfs_config_dir = require('path').join(require('os').homedir(), '.braidfs')

let braidfs_config_file = require('path').join(braidfs_config_dir, 'config.json')
if (!require('fs').existsSync(braidfs_config_file)) {
    require('fs').writeFileSync(braidfs_config_file, JSON.stringify({
        port: 10000,
        sync_urls: [],
        sync_index_urls: [],
        proxy_base: require('path').join(require('os').homedir(), 'http'),
        proxy_base_last_versions: require('path').join(braidfs_config_dir, 'proxy_base_last_versions'),
        braid_text_db: require('path').join(braidfs_config_dir, 'braid-text-db'),
    }, null, 4))
}

let config = JSON.parse(require('fs').readFileSync(braidfs_config_file, 'utf8'))

// process command line args (override config)
let argv = process.argv.slice(2)
while (argv.length) {
    let a = argv.shift()
    if (a.match(/^\d+$/)) {
        config.port = parseInt(a)
    } else if (a === 'sync') {
        let b = argv.shift()
        if (b === 'index') {
            config.sync_index_urls.push(argv.shift())
        } else {
            config.sync_urls.push(b)
        }
    }
}

braid_text.db_folder = config.braid_text_db

require('fs').mkdirSync(config.proxy_base, { recursive: true })
require('fs').mkdirSync(config.proxy_base_last_versions, { recursive: true })

console.log({ sync_urls: config.sync_urls, sync_index_urls: config.sync_index_urls })
for (let url of config.sync_urls) proxy_url(url)
config.sync_index_urls.forEach(async url => {
    let prefix = new URL(url).origin
    while (true) {
        let urls = await (await fetch(url)).json()
        for (let url of urls) proxy_url(prefix + url)
        await new Promise(done => setTimeout(done, 1000 * 60 * 60))
    }
})

braid_text.list().then(x => {
    for (let xx of x) proxy_url(xx)
})

const server = http.createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`);

    if (req.url === '/favicon.ico') return;

    // Security check: Allow only localhost access
    const clientIp = req.socket.remoteAddress;
    if (clientIp !== '127.0.0.1' && clientIp !== '::1') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access denied: This proxy is only accessible from localhost');
        return;
    }

    // Free the CORS
    free_the_cors(req, res);
    if (req.method === 'OPTIONS') return;

    if (req.url.endsWith("?editor")) {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        require("fs").createReadStream("./editor.html").pipe(res)
        return
    }

    if (req.url === '/pages') {
        var pages = await braid_text.list()
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Expose-Headers": "*"
        })
        res.end(JSON.stringify(pages))
        return
    }

    let url = req.url.slice(1)

    proxy_url(url)

    // Now serve the collaborative text!
    braid_text.serve(req, res, { key: normalize_url(url) })
});

server.listen(config.port, () => {
    console.log(`Proxy server started on port ${config.port}`);
    console.log('This proxy is only accessible from localhost');
});

////////////////////////////////

function normalize_url(url) {
    return url.replace(/(\/index|\/)+$/, '')
}

async function proxy_url(url) {
    let chain = proxy_url.chain || (proxy_url.chain = Promise.resolve())

    async function ensure_path(path) {
        // ensure that the path leading to our file exists..
        await (chain = chain.then(async () => {
            try {
                await require("fs").promises.mkdir(path, { recursive: true })
            } catch (e) {
                let parts = path.split(require("path").sep)
                for (let i = 1; i <= parts.length; i++) {
                    let partial = require("path").join(...parts.slice(0, i))

                    if (!(await is_dir(partial))) {
                        let save = await require("fs").promises.readFile(partial)

                        await require("fs").promises.unlink(partial)
                        await require("fs").promises.mkdir(path, { recursive: true })

                        while (await is_dir(partial))
                            partial = require("path").join(partial, 'index')

                        await require("fs").promises.writeFile(partial, save)
                        break
                    }
                }
            }
        }))
    }

    // normalize url by removing any trailing /index/index/
    let normalized_url = normalize_url(url)
    let wasnt_normal = normalized_url != url
    url = normalized_url

    if (!proxy_url.cache) proxy_url.cache = {}
    if (proxy_url.cache[url]) return
    proxy_url.cache[url] = true

    console.log(`proxy_url: ${url}`)

    let path = url.replace(/^https?:\/\//, '')
    let fullpath = require("path").join(config.proxy_base, path)

    // if we're accessing /blah/index, it will be normalized to /blah,
    // but we still want to create a directory out of blah in this case
    if (wasnt_normal && !(await is_dir(fullpath))) await ensure_path(fullpath)

    await ensure_path(require("path").dirname(fullpath))

    async function get_fullpath() {
        let p = fullpath
        while (await is_dir(p)) p = require("path").join(p, 'index')
        return p
    }

    let peer = Math.random().toString(36).slice(2)
    var char_counter = -1
    let file_last_version = null
    let file_last_text = null
    let file_needs_reading = true
    let file_needs_writing = null
    let file_loop_pump_lock = 0

    function signal_file_needs_reading() {
        file_needs_reading = true
        file_loop_pump()
    }

    function signal_file_needs_writing() {
        file_needs_writing = true
        file_loop_pump()
    }

    async function send_out(stuff) {
        await braid_fetch_wrapper(url, {
            headers: {
                "Merge-Type": "dt",
                "Content-Type": 'text/plain',
                ...config?.domains?.[(new URL(url)).hostname]?.auth_headers,
            },
            method: "PUT",
            retry: true,
            ...stuff
        })
    }

    file_loop_pump()
    async function file_loop_pump() {
        if (file_loop_pump_lock) return
        file_loop_pump_lock++

        if (file_last_version === null) {
            try {
                file_last_version = JSON.parse(await require('fs').promises.readFile(require('path').join(config.proxy_base_last_versions, braid_text.encode_filename(url)), { encoding: 'utf8' }))
                file_last_text = (await braid_text.get(url, { version: file_last_version })).body
                file_needs_writing = !v_eq(file_last_version, (await braid_text.get(url, {})).version)
            } catch (e) {
                file_last_version = []
                file_last_text = ''
                file_needs_writing = true
            }
        }

        while (file_needs_reading || file_needs_writing) {
            if (file_needs_reading) {
                file_needs_reading = false

                let text = ''
                try { text = await require('fs').promises.readFile(await get_fullpath(), { encoding: 'utf8' }) } catch (e) { }

                var patches = diff(file_last_text, text)
                if (patches.length) {
                    // convert from js-indicies to code-points
                    char_counter += patches_to_code_points(patches, file_last_text)

                    file_last_text = text

                    var version = [peer + "-" + char_counter]
                    var parents = file_last_version
                    file_last_version = version

                    send_out({ version, parents, patches, peer })

                    await braid_text.put(url, { version, parents, patches, peer })

                    await require('fs').promises.writeFile(require('path').join(config.proxy_base_last_versions, braid_text.encode_filename(url)), JSON.stringify(file_last_version))
                }
            }
            if (file_needs_writing) {
                file_needs_writing = false

                console.log(`writing file ${await get_fullpath()}`)

                let { version, body } = await braid_text.get(url, {})
                if (!v_eq(version, file_last_version)) {
                    file_last_version = version
                    file_last_text = body
                    await require('fs').promises.writeFile(await get_fullpath(), file_last_text)
                    await require('fs').promises.writeFile(require('path').join(config.proxy_base_last_versions, braid_text.encode_filename(url)), JSON.stringify(file_last_version))
                }
            }
        }
        file_loop_pump_lock--
    }

    braid_fetch_wrapper(url, {
        headers: {
            "Merge-Type": "dt",
            Accept: 'text/plain'
        },
        subscribe: true,
        retry: true,
        parents: async () => {
            let cur = await braid_text.get(url, {})
            if (cur.version.length) return cur.version
        },
        peer
    }).then(x => {
        x.subscribe(async update => {
            // console.log(`update: ${JSON.stringify(update, null, 4)}`)
            if (update.version.length == 0) return;

            await braid_text.put(url, { ...update, peer })

            signal_file_needs_writing()
        })
    })

    if (!proxy_url.path_to_func) proxy_url.path_to_func = {}
    proxy_url.path_to_func[path] = signal_file_needs_reading

    if (!proxy_url.chokidar) {
        proxy_url.chokidar = true
        require('chokidar').watch(config.proxy_base).on('change', (path) => {
            path = require('path').relative(config.proxy_base, path)
            console.log(`path changed: ${path}`)

            path = normalize_url(path)
            // console.log(`normalized path: ${path}`)

            proxy_url.path_to_func[path]()
        });
    }

    // try a HEAD without subscribe to get the version
    let parents = null
    try {
        let head_res = await braid_fetch_wrapper(url, {
            method: 'HEAD',
            headers: { Accept: 'text/plain' },
            retry: true,
        })
        parents = head_res.headers.get('version') ?
            JSON.parse(`[${head_res.headers.get('version')}]`) :
            null
    } catch (e) {
        console.log('HEAD failed: ', e)
    }

    // now get everything since then, and send it back..
    braid_text.get(url, {
        parents,
        merge_type: 'dt',
        peer,
        subscribe: async ({ version, parents, body, patches }) => {
            if (version.length == 0) return;

            // console.log(`local got: ${JSON.stringify({ version, parents, body, patches }, null, 4)}`)

            signal_file_needs_writing()

            send_out({ version, parents, body, patches, peer })
        },
    })
}

async function is_dir(p) {
    try {
        return (await require("fs").promises.stat(p)).isDirectory()
    } catch (e) { }
}

function diff(before, after) {
    let diff = diff_main(before, after);
    let patches = [];
    let offset = 0;
    for (let d of diff) {
        let p = null;
        if (d[0] == 1) p = { range: [offset, offset], content: d[1] };
        else if (d[0] == -1) {
            p = { range: [offset, offset + d[1].length], content: "" };
            offset += d[1].length;
        } else offset += d[1].length;
        if (p) {
            p.unit = "text";
            patches.push(p);
        }
    }
    return patches;
}

function free_the_cors(req, res) {
    res.setHeader('Range-Request-Allow-Methods', 'PATCH, PUT');
    res.setHeader('Range-Request-Allow-Units', 'json');
    res.setHeader("Patches", "OK");
    var free_the_cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS, HEAD, GET, PUT, UNSUBSCRIBE",
        "Access-Control-Allow-Headers": "subscribe, client, version, parents, merge-type, content-type, content-range, patches, cache-control, peer"
    };
    Object.entries(free_the_cors).forEach(x => res.setHeader(x[0], x[1]));
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
    }
}

function patches_to_code_points(patches, prev_state) {
    let char_counter = 0
    let c = 0
    let i = 0
    for (let p of patches) {
        while (i < p.range[0]) {
            i += get_char_size(prev_state, i)
            c++
        }
        p.range[0] = c

        while (i < p.range[1]) {
            i += get_char_size(prev_state, i)
            c++
        }
        p.range[1] = c

        char_counter += p.range[1] - p.range[0]
        char_counter += count_code_points(p.content)

        p.unit = "text"
        p.range = `[${p.range[0]}:${p.range[1]}]`
    }
    return char_counter
}

function get_char_size(s, i) {
    const charCode = s.charCodeAt(i)
    return (charCode >= 0xd800 && charCode <= 0xdbff) ? 2 : 1
}

function count_code_points(str) {
    let code_points = 0
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) >= 0xd800 && str.charCodeAt(i) <= 0xdbff) i++
        code_points++
    }
    return code_points
}

async function braid_fetch_wrapper(url, params) {
    if (!params.retry) throw "wtf"
    var waitTime = 10
    if (params.subscribe) {
        var subscribe_handler = null
        connect()
        async function connect() {
            if (params.signal?.aborted) return
            try {
                var c = await braid_fetch(url, { ...params, parents: await params.parents?.() })
                c.subscribe((...args) => subscribe_handler?.(...args), on_error)
                waitTime = 10
            } catch (e) {
                on_error(e)
            }
        }
        function on_error(e) {
            console.log(`eee[url:${url}] = ` + e.stack)
            setTimeout(connect, waitTime)
            waitTime = Math.min(waitTime * 2, 3000)
        }
        return { subscribe: handler => { subscribe_handler = handler } }
    } else {
        return new Promise((done) => {
            send()
            async function send() {
                try {
                    var res = await braid_fetch(url, params)
                    if (res.status !== 200) throw "status not 200: " + res.status
                    done(res)
                } catch (e) {
                    setTimeout(send, waitTime)
                    waitTime = Math.min(waitTime * 2, 3000)
                }
            }
        })
    }
}

function v_eq(v1, v2) {
    return v1.length == v2.length && v1.every((x, i) => x == v2[i])
}
