
let http = require('http');

let { diff_main } = require('./diff.js')
let braid_text = require("braid-text");
let braid_fetch = require('braid-http').fetch

let port = 10000
let cookie = null
let pin_urls = []
let pindex_urls = []
let proxy_base = `./proxy_base`

let argv = process.argv.slice(2)
while (argv.length) {
    let a = argv.shift()
    if (a.match(/^\d+$/)) {
        port = parseInt(a)
    } else if (a === '-pin') {
        let b = argv.shift()
        if (b === 'index') {
            pindex_urls.push(argv.shift())
        } else {
            pin_urls.push(b)
        }
    } else {
        cookie = a
        console.log(`cookie = ${cookie}`)
    }
}
console.log({ pin_urls, pindex_urls })

process.on("unhandledRejection", (x) => console.log(`unhandledRejection: ${x.stack}`))
process.on("uncaughtException", (x) => console.log(`uncaughtException: ${x.stack}`))

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
    braid_text.serve(req, res, { key: url })
});

server.listen(port, () => {
    console.log(`Proxy server started on port ${port}`);
    console.log('This proxy is only accessible from localhost');
});

for (let url of pin_urls) proxy_url(url)
pindex_urls.forEach(async url => {
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

////////////////////////////////

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
                            partial = require("path").join(partial, 'index.html')

                        await require("fs").promises.writeFile(partial, save)
                        break
                    }
                }
            }
        }))
    }

    // normalize url by removing any trailing /index.html/index.html/
    let normalized_url = url.replace(/(\/index\.html|\/)+$/, '')
    let wasnt_normal = normalized_url != url
    url = normalized_url

    if (!proxy_url.cache) proxy_url.cache = {}
    if (proxy_url.cache[url]) return
    proxy_url.cache[url] = true

    let path = url.replace(/^https?:\/\//, '')
    let fullpath = require("path").join(proxy_base, path)

    // if we're accessing /blah/index.html, it will be normalized to /blah,
    // but we still want to create a directory out of blah in this case
    if (wasnt_normal && !(await is_dir(fullpath))) ensure_path(fullpath)

    let last_text = ''

    console.log(`proxy_url: ${url}`)

    let peer = Math.random().toString(36).slice(2)

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
        x.subscribe(update => {
            // console.log(`update: ${JSON.stringify(update, null, 4)}`)
            if (update.version.length == 0) return;

            braid_text.put(url, { ...update, peer })
        })
    })

    // try a HEAD without subscribe to get the version
    braid_fetch_wrapper(url, {
        method: 'HEAD',
        headers: { Accept: 'text/plain' },
        retry: true,
    }).then(async head_res => {
        let parents = head_res.headers.get('version') ?
            JSON.parse(`[${head_res.headers.get('version')}]`) :
            null

        // now get everything since then, and send it back..
        braid_text.get(url, {
            parents,
            merge_type: 'dt',
            peer,
            subscribe: async ({ version, parents, body, patches }) => {
                if (version.length == 0) return;

                // console.log(`local got: ${JSON.stringify({ version, parents, body, patches }, null, 4)}`)
                // console.log(`cookie = ${cookie}`)

                await braid_fetch_wrapper(url, {
                    headers: {
                        "Merge-Type": "dt",
                        "Content-Type": 'text/plain',
                        ...(cookie ? { "Cookie": cookie } : {}),
                    },
                    method: "PUT",
                    retry: true,
                    version, parents, body, patches,
                    peer
                })
            },
        })
    })

    await ensure_path(require("path").dirname(fullpath))

    async function get_fullpath() {
        let p = fullpath
        while (await is_dir(p)) p = require("path").join(p, 'index.html')
        return p
    }

    let simpleton = simpleton_client(url, {
        apply_remote_update: async ({ state, patches }) => {
            return await (chain = chain.then(async () => {
                console.log(`writing file ${await get_fullpath()}`)

                if (state !== undefined) last_text = state
                else last_text = apply_patches(last_text, patches)
                await require('fs').promises.writeFile(await get_fullpath(), last_text)
                return last_text
            }))
        },
        generate_local_diff_update: async (_) => {
            return await (chain = chain.then(async () => {
                let text = await require('fs').promises.readFile(await get_fullpath(), { encoding: 'utf8' })
                var patches = diff(last_text, text)
                last_text = text
                return patches.length ? { patches, new_state: last_text } : null
            }))
        }
    })

    if (!proxy_url.path_to_func) proxy_url.path_to_func = {}
    proxy_url.path_to_func[path] = () => simpleton.changed()

    if (!proxy_url.chokidar) {
        proxy_url.chokidar = true
        require('chokidar').watch(proxy_base).on('change', (path) => {
            path = require('path').relative(proxy_base, path)
            console.log(`path changed: ${path}`)

            path = path.replace(/(\/index\.html|\/)+$/, '')
            console.log(`normalized path: ${path}`)

            proxy_url.path_to_func[path]()
        });
    }
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

function apply_patches(originalString, patches) {
    let offset = 0;
    for (let p of patches) {
        p.range[0] += offset;
        p.range[1] += offset;
        offset -= p.range[1] - p.range[0];
        offset += p.content.length;
    }

    let result = originalString;

    for (let p of patches) {
        let range = p.range;
        result =
            result.substring(0, range[0]) +
            p.content +
            result.substring(range[1]);
    }

    return result;
}

function simpleton_client(url, { apply_remote_update, generate_local_diff_update, content_type }) {
    var peer = Math.random().toString(36).slice(2)
    var current_version = []
    var prev_state = ""
    var char_counter = -1
    var chain = Promise.resolve()
    var queued_changes = 0

    braid_text.get(url, {
        peer,
        subscribe: (update) => {
            chain = chain.then(async () => {
                // Only accept the update if its parents == our current version
                update.parents.sort()
                if (current_version.length === update.parents.length
                    && current_version.every((v, i) => v === update.parents[i])) {
                    current_version = update.version.sort()
                    update.state = update.body

                    if (update.patches) {
                        for (let p of update.patches) p.range = p.range.match(/\d+/g).map((x) => 1 * x)
                        update.patches.sort((a, b) => a.range[0] - b.range[0])

                        // convert from code-points to js-indicies
                        let c = 0
                        let i = 0
                        for (let p of update.patches) {
                            while (c < p.range[0]) {
                                i += get_char_size(prev_state, i)
                                c++
                            }
                            p.range[0] = i

                            while (c < p.range[1]) {
                                i += get_char_size(prev_state, i)
                                c++
                            }
                            p.range[1] = i
                        }
                    }

                    prev_state = await apply_remote_update(update)
                }
            })
        }
    })

    return {
        changed: () => {
            if (queued_changes) return
            queued_changes++
            chain = chain.then(async () => {
                queued_changes--
                var update = await generate_local_diff_update(prev_state)
                if (!update) return   // Stop if there wasn't a change!
                var { patches, new_state } = update

                // convert from js-indicies to code-points
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

                var version = [peer + "-" + char_counter]

                var parents = current_version
                current_version = version
                prev_state = new_state

                braid_text.put(url, { version, parents, patches, peer })
            })
        }
    }
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