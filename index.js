#!/usr/bin/env node

console.log(`braidfs version: ${require(`${__dirname}/package.json`).version}`)

let { diff_main } = require(`${__dirname}/diff.js`)
let braid_text = require("braid-text")
let braid_fetch = require('braid-http').fetch

process.on("unhandledRejection", (x) => console.log(`unhandledRejection: ${x.stack}`))
process.on("uncaughtException", (x) => console.log(`uncaughtException: ${x.stack}`))

let proxy_base = `${require('os').homedir()}/http`
let braidfs_config_dir =`${proxy_base}/.braidfs`
let braidfs_config_file = `${braidfs_config_dir}/config`
let proxy_base_meta = `${braidfs_config_dir}/proxy_base_meta`
braid_text.db_folder = `${braidfs_config_dir}/braid-text-db`
let trash = `${braidfs_config_dir}/trash`

let config = null
let path_to_func = {}

if (require('fs').existsSync(proxy_base)) {
    try {
        config = JSON.parse(require('fs').readFileSync(braidfs_config_file, 'utf8'))
    } catch (e) {
        return console.log(`Cannot parse the configuration file at: ${braidfs_config_file}`)
    }
} else {
    config = {
        port: 10000,
        sync: {},
        domains: { 'example.com': { auth_headers: { Cookie: "secret_pass" } } }
    }
    require('fs').mkdirSync(braidfs_config_dir, { recursive: true })
    require('fs').writeFileSync(braidfs_config_file, JSON.stringify(config, null, 4))
}

require('fs').mkdirSync(proxy_base_meta, { recursive: true })
require('fs').mkdirSync(trash, { recursive: true })

// process command line args
let argv = process.argv.slice(2)
if (argv.length === 1 && argv[0] === 'serve') {
    return main()
} else if (argv.length && argv.length % 2 == 0 && argv.every((x, i) => i % 2 != 0 || x.match(/^(sync|unsync)$/))) {
    let operations = []
    for (let i = 0; i < argv.length; i += 2) {
        let operation = argv[i]
        let url = argv[i + 1]
        if (!url.match(/^https?:\/\//)) {
            if (url.startsWith('/')) url = require('path').relative(proxy_base, url)
            url = `https://${url}`
        }
        console.log(`${operation}ing ${url}`)
        operations.push({ operation, url })
    }
    return Promise.all(operations.map(({ operation, url }) => 
        braid_fetch(`http://localhost:${config.port}/.braidfs/config`, {
            method: 'PUT',
            patches: [{
                unit: 'json',
                range: `sync[${JSON.stringify(url)}]`,
                content: operation === 'sync' ? 'true' : ''
            }]
        }).then(() => console.log(`${operation}ed: ${url}`))
    )).then(() => console.log('All operations completed successfully.'))
    .catch(() => {
        return console.log(`The braidfs server does not appear to be running.
You can run it with:
> braidfs serve${process.platform === 'darwin' ? `
or in the background with:
> launchctl submit -l org.braid.braidfs -- braidfs serve` :
''}`)
    })
} else {
    return console.log(`Usage:
    braidfs serve
    braidfs sync <URL>
    braidfs unsync <URL>${process.platform === 'darwin' ? `
To run server in background:
    launchctl submit -l org.braid.braidfs -- braidfs serve` :
''}`)
}

async function main() {
    require('http').createServer(async (req, res) => {
        console.log(`${req.method} ${req.url}`)

        if (req.url === '/favicon.ico') return

        if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            return res.end('Access denied: only accessible from localhost')
        }

        // Free the CORS
        free_the_cors(req, res)
        if (req.method === 'OPTIONS') return

        let url = req.url.slice(1)
        let is_external_link = url.match(/^https?:\/\//)

        if (!is_external_link && url !== '.braidfs/config' && url != '.braidfs/errors') {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            return res.end('nothing to see here')
        }

        if (is_external_link && !config.sync[url]) {
            config.sync[url] = true
            await braid_text.put('.braidfs/config', {
                parents: (await braid_text.get('.braidfs/config', {})).version,
                patches: [{
                    unit: 'json',
                    range: `sync[${JSON.stringify(url)}]`,
                    content: 'true'
                }]
            })
        }

        let p = await proxy_url(url)

        res.setHeader('Editable', !p.file_read_only)
        if (req.method == "PUT" || req.method == "POST" || req.method == "PATCH") {
            if (p.file_read_only) {
                res.statusCode = 403 // Forbidden status code
                return res.end('access denied')
            }
        }

        braid_text.serve(req, res, { key: normalize_url(url) })
    }).listen(config.port, () => {
        console.log(`server started on port ${config.port}`)
        if (!config.allow_remote_access) console.log('!! only accessible from localhost !!')

        proxy_url('.braidfs/config').then(() => {
            let peer = Math.random().toString(36).slice(2)
            braid_text.get('.braidfs/config', {
                subscribe: async update => {
                    let prev_syncs = Object.keys(config.sync)

                    let x = await braid_text.get('.braidfs/config')
                    try {
                        config = JSON.parse(x)

                        // did anything get deleted?
                        for (let url of prev_syncs) if (!config.sync[url]) unproxy_url(url)

                        for (let url of Object.keys(config.sync)) proxy_url(url)
                    } catch (e) {
                        if (x !== '') console.log(`warning: config file is currently invalid.`)
                        return
                    }
                },
                peer
            })
        })
        proxy_url('.braidfs/errors')

        console.log({ sync: config.sync })
        for (let url of Object.keys(config.sync)) proxy_url(url)

        require('chokidar').watch(proxy_base).on('change', chokidar_handler).on('add', chokidar_handler)
        async function chokidar_handler(fullpath) {
            path = require('path').relative(proxy_base, fullpath)

            // Skip any temp files with a # in the name
            if (path.includes('#')) return

            // Skip stuff in .braidfs/ except for config and errors
            if (path.startsWith('.braidfs')) {
                if (!path.match(/^\.braidfs\/(config|errors)$/)) return
            }

            console.log(`file event: ${path}`)

            let update_func = await path_to_func[normalize_url(path)]
            if (update_func) update_func()
            else {
                // throw this unrecognized file into the trash,
                let dest = `${trash}/${braid_text.encode_filename(path)}_${Math.random().toString(36).slice(2)}`
                console.log(`moving untracked file ${fullpath} to ${dest}`)
                await require('fs').promises.rename(fullpath, dest)

                // and log an error
                let x = await braid_text.get('.braidfs/errors', {})
                let len = [...x.body].length
                await braid_text.put('.braidfs/errors', {
                    parents: x.version,
                    patches: [{
                        unit: 'text',
                        range: `[${len}:${len}]`,
                        content: `error: unsynced file ${fullpath}; moved to ${dest}\n`
                    }]
                })
            }
        }
    }).on('error', e => {
        if (e.code === 'EADDRINUSE') return console.log(`server already running on port ${config.port}`)
        throw e
    })
}

function unproxy_url(url) {
    if (!proxy_url.cache?.[url]) return

    console.log(`unproxy_url: ${url}`)

    delete proxy_url.cache[url]
    unproxy_url.cache[url] = unproxy_url.cache[url]()
}

async function proxy_url(url) {
    // normalize url by removing any trailing /index/index/
    let normalized_url = normalize_url(url)
    let wasnt_normal = normalized_url != url
    url = normalized_url

    let is_external_link = url.match(/^https?:\/\//)
    let path = is_external_link ? url.replace(/^https?:\/\//, '') : url
    let fullpath = `${proxy_base}/${path}`
    let meta_path = `${proxy_base_meta}/${braid_text.encode_filename(url)}`

    let set_path_to_func
    if (!path_to_func[path]) path_to_func[path] = new Promise(done => set_path_to_func = done)

    if (!proxy_url.cache) proxy_url.cache = {}
    if (!proxy_url.chain) proxy_url.chain = Promise.resolve()
    if (!proxy_url.cache[url]) proxy_url.cache[url] = proxy_url.chain = proxy_url.chain.then(async () => {
        let freed = false
        let aborts = new Set()
        let braid_text_get_options = null
        let wait_count = 0
        let wait_promise, wait_promise_done
        let start_something = () => {
            if (freed) return
            if (!wait_count) wait_promise = new Promise(done => wait_promise_done = done)
            return ++wait_count
        }
        let finish_something = () => {
            wait_count--
            if (!wait_count) wait_promise_done()
        }
        if (!unproxy_url.cache) unproxy_url.cache = {}
        let old_unproxy = unproxy_url.cache[url]
        unproxy_url.cache[url] = async () => {
            freed = true
            delete path_to_func[path]
            for (let a of aborts) a.abort()
            await wait_promise
            if (braid_text_get_options) await braid_text.forget(url, braid_text_get_options)
            await braid_text.delete(url)
            await require('fs').promises.unlink(meta_path)
            await require('fs').promises.unlink(await get_fullpath())
        }
        await old_unproxy

        let self = {}

        console.log(`proxy_url: ${url}`)

        if (!start_something()) return

        // if we're accessing /blah/index, it will be normalized to /blah,
        // but we still want to create a directory out of blah in this case
        if (wasnt_normal && !(await is_dir(fullpath))) await ensure_path(fullpath)

        await ensure_path(require("path").dirname(fullpath))

        finish_something()

        async function get_fullpath() {
            let p = fullpath
            while (await is_dir(p)) p = require("path").join(p, 'index')
            return p
        }

        let peer = Math.random().toString(36).slice(2)
        var char_counter = -1
        let file_last_version = null
        let file_last_digest = null
        let file_last_text = null
        self.file_read_only = null
        let file_needs_reading = true
        let file_needs_writing = null
        let file_loop_pump_lock = 0

        function signal_file_needs_reading() {
            if (freed) return
            file_needs_reading = true
            file_loop_pump()
        }

        function signal_file_needs_writing() {
            if (freed) return
            file_needs_writing = true
            file_loop_pump()
        }

        async function send_out(stuff) {
            if (!start_something()) return
            if (is_external_link) {
                try {
                    let a = new AbortController()
                    aborts.add(a)
                    await braid_fetch(url, {
                        signal: a.signal,
                        headers: {
                            "Merge-Type": "dt",
                            "Content-Type": 'text/plain',
                            ...config.domains?.[(new URL(url)).hostname]?.auth_headers,
                        },
                        method: "PUT",
                        retry: true,
                        ...stuff
                    })
                    aborts.delete(a)
                } catch (e) {
                    if (e?.name !== "AbortError") crash(e)
                }
            }
            finish_something()
        }

        set_path_to_func(signal_file_needs_reading)

        file_loop_pump()
        async function file_loop_pump() {
            if (file_loop_pump_lock) return
            file_loop_pump_lock++

            if (!start_something()) return

            if (file_last_version === null) {
                if (await require('fs').promises.access(meta_path).then(() => 1, () => 0)) {
                    // meta file exists
                    let meta = JSON.parse(await require('fs').promises.readFile(meta_path, { encoding: 'utf8' }))
                    let _ = ({ version: file_last_version, digest: file_last_digest } = Array.isArray(meta) ? { version: meta } : meta)

                    file_last_text = (await braid_text.get(url, { version: file_last_version })).body
                    file_needs_writing = !v_eq(file_last_version, (await braid_text.get(url, {})).version)

                    // sanity check
                    if (file_last_digest && require('crypto').createHash('sha256').update(file_last_text).digest('base64') != file_last_digest) throw new Error('file_last_text does not match file_last_digest')
                } else if (await require('fs').promises.access(await get_fullpath()).then(() => 1, () => 0)) {
                    // file exists, but not meta file
                    file_last_version = []
                    file_last_text = ''
                } else {
                    // file doesn't exist, nor does meta file
                    file_needs_writing = true
                    file_last_version = []
                    file_last_text = ''
                    await require('fs').promises.writeFile(await get_fullpath(), file_last_text)
                }
            }

            while (file_needs_reading || file_needs_writing) {
                if (file_needs_reading) {
                    file_needs_reading = false

                    if (self.file_read_only === null) try { self.file_read_only = await is_read_only(await get_fullpath()) } catch (e) { }

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

                        await require('fs').promises.writeFile(meta_path, JSON.stringify({ version: file_last_version, digest: require('crypto').createHash('sha256').update(file_last_text).digest('base64') }))
                    }
                }
                if (file_needs_writing) {
                    file_needs_writing = false
                    let { version, body } = await braid_text.get(url, {})
                    if (!v_eq(version, file_last_version)) {

                        console.log(`writing file ${await get_fullpath()}`)

                        try { if (await is_read_only(await get_fullpath())) await set_read_only(await get_fullpath(), false) } catch (e) { }

                        file_last_version = version
                        file_last_text = body
                        await require('fs').promises.writeFile(await get_fullpath(), file_last_text)
                        await require('fs').promises.writeFile(meta_path, JSON.stringify({ version: file_last_version, digest: require('crypto').createHash('sha256').update(file_last_text).digest('base64') }))
                    }

                    if (await is_read_only(await get_fullpath()) !== self.file_read_only) await set_read_only(await get_fullpath(), self.file_read_only)
                }
            }

            finish_something()

            file_loop_pump_lock--
        }

        // try a HEAD without subscribe to get the version
        let parents = null
        if (is_external_link) {
            if (!start_something()) return
            try {
                let a = new AbortController()
                aborts.add(a)
                let head_res = await braid_fetch(url, {
                    signal: a.signal,
                    method: 'HEAD',
                    headers: {
                        Accept: 'text/plain',
                        ...config.domains?.[(new URL(url)).hostname]?.auth_headers,
                    },
                    retry: true,
                })
                aborts.delete(a)
                parents = head_res.headers.get('version') ?
                    JSON.parse(`[${head_res.headers.get('version')}]`) :
                    null
                self.file_read_only = head_res.headers.get('editable') === 'false'
                signal_file_needs_writing()
            } catch (e) {
                console.log('HEAD failed: ', e)
            }

            console.log(`waiting_for_versions: ${parents}`)

            let waiting_for_versions = {}
            for (let p of parents ?? []) {
                let [a, seq] = p.split('-')
                if (seq > (waiting_for_versions[a] ?? -1))
                    waiting_for_versions[a] = seq
            }

            await new Promise(done => {
                let a = new AbortController()
                aborts.add({
                    abort: () => {
                        a.abort()
                        done?.()
                        done = null
                    }
                })
                braid_fetch(url, {
                    signal: a.signal,
                    headers: {
                        "Merge-Type": "dt",
                        Accept: 'text/plain',
                        ...config.domains?.[(new URL(url)).hostname]?.auth_headers,
                    },
                    subscribe: true,
                    retry: true,
                    heartbeats: 120,
                    parents: async () => {
                        let cur = await braid_text.get(url, {})
                        if (cur.version.length) {
                            if (done) {
                                for (let v of cur.version) {
                                    let [a, seq] = v.split('-')
                                    if (waiting_for_versions[a] <= seq) delete waiting_for_versions[a]
                                }
                                if (!Object.keys(waiting_for_versions).length) {
                                    console.log('got everything we were waiting for.')
                                    done()
                                    done = null
                                }
                            }

                            return cur.version
                        }
                    },
                    peer,
                    onRes: (res) => {
                        self.file_read_only = res.headers.get('editable') === 'false'
                        signal_file_needs_writing()
                    }
                }).then(x => {
                    x.subscribe(async update => {
                        if (update.body) update.body = update.body_text
                        if (update.patches) for (let p of update.patches) p.content = p.content_text

                        // console.log(`update: ${JSON.stringify(update, null, 4)}`)
                        if (update.version.length == 0) return;
                        if (update.version.length != 1) throw 'unexpected';

                        if (!start_something()) return

                        await braid_text.put(url, { ...update, peer, merge_type: 'dt' })

                        if (done) {
                            let [a, seq] = update.version[0].split('-')
                            if (waiting_for_versions[a] <= seq) delete waiting_for_versions[a]
                            if (!Object.keys(waiting_for_versions).length) {
                                console.log('got everything we were waiting for..')
                                done()
                                done = null
                            }
                        }

                        signal_file_needs_writing()
                        finish_something()
                    }, e => (e?.name !== "AbortError") && crash(e))
                }).catch(e => (e?.name !== "AbortError") && crash(e))
            })
            finish_something()
        }

        // now get everything since then, and send it back..
        braid_text.get(url, braid_text_get_options = {
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

        return self
    })
    return await proxy_url.cache[url]
}

async function ensure_path(path) {
    try {
        await require("fs").promises.mkdir(path, { recursive: true })
    } catch (e) {
        let parts = path.split(require("path").sep).slice(1)
        for (let i = 1; i <= parts.length; i++) {
            let partial = require("path").sep + require("path").join(...parts.slice(0, i))

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
}

////////////////////////////////

function normalize_url(url) {
    return url.replace(/(\/index|\/)+$/, '')
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

function v_eq(v1, v2) {
    return v1.length === v2?.length && v1.every((x, i) => x == v2[i])
}

async function is_read_only(fullpath) {
    const stats = await require('fs').promises.stat(fullpath)
    return require('os').platform() === "win32" ?
        !!(stats.mode & 0x1) :
        !(stats.mode & 0o200)
}

async function set_read_only(fullpath, read_only) {
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

function crash(e) {
    console.error('' + e.stack)
    process.exit(1)
}
