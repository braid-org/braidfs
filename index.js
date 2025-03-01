#!/usr/bin/env node

console.log(`braidfs version: ${require(`${__dirname}/package.json`).version}`)

var { diff_main } = require(`${__dirname}/diff.js`),
    braid_text = require("braid-text"),
    braid_fetch = require('braid-http').fetch

process.on("unhandledRejection", (x) => console.log(`unhandledRejection: ${x.stack}`))
process.on("uncaughtException", (x) => console.log(`uncaughtException: ${x.stack}`))

var proxy_base = `${require('os').homedir()}/http`,
    braidfs_config_dir = `${proxy_base}/.braidfs`,
    braidfs_config_file = `${braidfs_config_dir}/config`,
    proxy_base_meta = `${braidfs_config_dir}/proxy_base_meta`
braid_text.db_folder = `${braidfs_config_dir}/braid-text-db`
var trash = `${braidfs_config_dir}/trash`
var temp_folder = `${braidfs_config_dir}/temp`

var config = null,
    watcher_misses = 0

if (require('fs').existsSync(proxy_base)) {
    try {
        config = JSON.parse(require('fs').readFileSync(braidfs_config_file, 'utf8'))

        // for 0.0.55 users upgrading to 0.0.56,
        // which changes the config "domains" key to "cookies",
        // and condenses its structure a bit
        if (config.domains) {
            config.cookies = Object.fromEntries(Object.entries(config.domains).map(([k, v]) => {
                if (v.auth_headers?.Cookie) return [k, v.auth_headers.Cookie]
            }).filter(x => x))
            delete config.domains
            require('fs').writeFileSync(braidfs_config_file, JSON.stringify(config, null, 4))
        }
    } catch (e) {
        return console.log(`Cannot parse the configuration file at: ${braidfs_config_file}`)
    }
} else {
    config = {
        sync: {},
        cookies: { 'example.com': 'secret_pass' },
        port: 45678,
        scan_interval_ms: 1000 * 20,
    }
    require('fs').mkdirSync(braidfs_config_dir, { recursive: true })
    require('fs').writeFileSync(braidfs_config_file, JSON.stringify(config, null, 4))
}

require('fs').mkdirSync(proxy_base_meta, { recursive: true })
require('fs').mkdirSync(trash, { recursive: true })
require('fs').mkdirSync(temp_folder, { recursive: true })

// process command line args
let to_run_in_background = process.platform === 'darwin' ? `
To run daemon in background:
    launchctl submit -l org.braid.braidfs -- braidfs run` : ''
let argv = process.argv.slice(2)
if (argv.length === 1 && argv[0].match(/^(run|serve)$/)) {
    return main()
} else if (argv.length && argv.length % 2 == 0 && argv.every((x, i) => i % 2 != 0 || x.match(/^(sync|unsync)$/))) {
    let operations = []
    for (let i = 0; i < argv.length; i += 2) {
        var operation = argv[i],
            url = argv[i + 1]
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
            return console.log(`The braidfs daemon does not appear to be running.
You can run it with:
    braidfs run${to_run_in_background}`)
        })
} else {
    return console.log(`Usage:
    braidfs run
    braidfs sync <URL>
    braidfs unsync <URL>${to_run_in_background}`)
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

        var url = req.url.slice(1)

        if (url !== '.braidfs/config' && url !== '.braidfs/errors') {
            res.writeHead(404, { 'Content-Type': 'text/html' })
            return res.end('Nothing to see here. You can go to <a href=".braidfs/config">.braidfs/config</a> or <a href=".braidfs/errors">.braidfs/errors</a>')
        }

        braid_text.serve(req, res, { key: normalize_url(url) })
    }).listen(config.port, () => {
        console.log(`daemon started on port ${config.port}`)
        if (!config.allow_remote_access) console.log('!! only accessible from localhost !!')

        proxy_url('.braidfs/config').then(() => {
            let peer = Math.random().toString(36).slice(2)
            braid_text.get('.braidfs/config', {
                subscribe: async update => {
                    let prev = config

                    let x = await braid_text.get('.braidfs/config')
                    try {
                        config = JSON.parse(x)

                        // did anything get deleted?
                        var old_syncs = Object.entries(prev.sync).filter(x => x[1]).map(x => normalize_url(x[0]).replace(/^https?:\/\//, ''))
                        var new_syncs = new Set(Object.entries(config.sync).filter(x => x[1]).map(x => normalize_url(x[0]).replace(/^https?:\/\//, '')))
                        for (let url of old_syncs.filter(x => !new_syncs.has(x)))
                            unproxy_url(url)

                        // proxy all the new stuff
                        for (let x of Object.entries(config.sync)) if (x[1]) proxy_url(x[0])

                        // if any auth stuff has changed,
                        // have the appropriate connections reconnect
                        let changed = new Set()
                        // any old domains no longer exist?
                        for (let domain of Object.keys(prev.cookies ?? {}))
                            if (!config.cookies?.[domain]) changed.add(domain)
                        // any new domains not like the old?
                        for (let [domain, v] of Object.entries(config.cookies ?? {}))
                            if (!prev.cookies?.[domain]
                                || JSON.stringify(prev.cookies[domain]) !== JSON.stringify(v))
                                changed.add(domain)
                        // ok, have every domain which has changed reconnect
                        for (let [path, x] of Object.entries(proxy_url.cache))
                            if (changed.has(path.split(/\//)[0].split(/:/)[0]))
                                (await x).reconnect?.()
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
        for (let x of Object.entries(config.sync)) if (x[1]) proxy_url(x[0])

        watch_files()
        setTimeout(scan_files, 1200)
    }).on('error', e => {
        if (e.code === 'EADDRINUSE') return console.log(`port ${config.port} is in use`)
        throw e
    })
}

function on_watcher_miss(message, scan = true) {
    console.log(`watcher miss: ${message}`)
    console.log(`\x1b[33;40m[${++watcher_misses}] watcher misfires\x1b[0m`)
    watch_files()
    if (scan) setTimeout(scan_files, 1200)
}

function skip_file(path) {
    // Files to skip
    return (
        // Paths with a # in the name can't map to real URLs
        path.includes('#')
        // .DS_store
        || path.endsWith('.DS_store')
        // Skip stuff in .braidfs/ except for config and errors
        || (path.startsWith('.braidfs')
            && !path.match(/^\.braidfs\/(config|errors)$/))
    )
}

async function trash_file(fullpath, path) {
    // throw this unrecognized file into the trash,
    let dest = `${trash}/${braid_text.encode_filename(path)}_${Math.random().toString(36).slice(2)}`
    console.log(`moving untracked file ${fullpath} to ${dest}`)
    await require('fs').promises.rename(fullpath, dest)

    // and log an error
    var x = await braid_text.get('.braidfs/errors', {}),
        len = [...x.body].length
    await braid_text.put('.braidfs/errors', {
        parents: x.version,
        patches: [{
            unit: 'text',
            range: `[${len}:${len}]`,
            content: `error: unsynced file ${fullpath}; moved to ${dest}\n`
        }]
    })
}

async function watch_files() {
    if (watch_files.watcher === 42) return
    let w = watch_files.watcher
    watch_files.watcher = 42
    await w?.close()

    console.log('watch files..')
    watch_files.watcher = require('chokidar').watch(proxy_base).
        on('add', x => chokidar_handler(x, 'add')).
        on('change', x => chokidar_handler(x, 'change')).
        on('unlink', x => chokidar_handler(x, 'unlink'))

    async function chokidar_handler(fullpath, event) {
        // Make sure the path is within proxy_base..
        if (!fullpath.startsWith(proxy_base))
            return on_watcher_miss(`path ${fullpath} outside ${proxy_base}`)

        // Make sure the path is to a file, and not a directory
        if (event != 'unlink' && (await require('fs').promises.stat(fullpath)).isDirectory())
            return on_watcher_miss(`expected file, got: ${fullpath}`)

        var path = require('path').relative(proxy_base, fullpath)
        if (skip_file(path)) return
        console.log(`file event: ${path}, event: ${event}`)

        var proxy = await proxy_url.cache[normalize_url(path)]

        if (proxy && event != 'add') proxy.signal_file_needs_reading()
        if (!proxy && event != 'unlink') await trash_file(fullpath, path)
    }
}

async function scan_files() {
    scan_files.do_again = true
    if (scan_files.running) return
    if (scan_files.timeout) clearTimeout(scan_files.timeout)

    scan_files.running = true
    while (scan_files.do_again) {
        scan_files.do_again = false
        console.log(`scan files..`)
        if (await f(proxy_base))
            on_watcher_miss(`scanner picked up a change that the watcher should have gotten`, false)
    }
    scan_files.running = false

    scan_files.timeout = setTimeout(scan_files, config.scan_interval_ms ?? (20 * 1000))

    async function f(fullpath) {
        let stat = await require('fs').promises.stat(fullpath, { bigint: true })
        if (stat.isDirectory()) {
            let found
            for (let file of await require('fs').promises.readdir(fullpath))
                found ||= await f(`${fullpath}/${file}`)
            return found
        } else {
            path = require('path').relative(proxy_base, fullpath)
            if (skip_file(path)) return

            var proxy = await proxy_url.cache[normalize_url(path)]
            if (!proxy) return await trash_file(fullpath, path)

            stat = await require('fs').promises.stat(fullpath, { bigint: true })
            if (!stat_eq(stat, proxy.file_last_stat)) {
                console.log(`scan thinks ${path} has changed`)
                proxy.signal_file_needs_reading()
                return true
            }
        }
    }
}

function unproxy_url(url) {
    url = normalize_url(url).replace(/^https?:\/\//, '')
    if (!proxy_url.cache?.[url]) return

    console.log(`unproxy_url: ${url}`)

    delete proxy_url.cache[url]
    unproxy_url.cache[url] = unproxy_url.cache[url]()
}

async function proxy_url(url) {
    // normalize url by removing any trailing /index/index/
    var normalized_url = normalize_url(url),
        wasnt_normal = normalized_url != url
    url = normalized_url

    var is_external_link = url.match(/^https?:\/\//),
        path = is_external_link ? url.replace(/^https?:\/\//, '') : url,
        fullpath = `${proxy_base}/${path}`,
        meta_path = `${proxy_base_meta}/${braid_text.encode_filename(url)}`

    if (!proxy_url.cache) proxy_url.cache = {}
    if (!proxy_url.chain) proxy_url.chain = Promise.resolve()
    if (!proxy_url.cache[path]) proxy_url.cache[path] = proxy_url.chain = proxy_url.chain.then(async () => {
        var freed = false,
            aborts = new Set(),
            braid_text_get_options = null,
            wait_count = 0
        var wait_promise, wait_promise_done
        var start_something = () => {
            if (freed) return
            if (!wait_count) wait_promise = new Promise(done => wait_promise_done = done)
            return ++wait_count
        }
        var finish_something = () => {
            wait_count--
            if (!wait_count) wait_promise_done()
        }
        if (!unproxy_url.cache) unproxy_url.cache = {}
        var old_unproxy = unproxy_url.cache[path]
        unproxy_url.cache[path] = async () => {
            freed = true
            for (let a of aborts) a.abort()
            await wait_promise
            if (braid_text_get_options) await braid_text.forget(url, braid_text_get_options)

            delete braid_text.cache[url]
            for (let f of await braid_text.get_files_for_key(url)) {
                console.log(`trying to delete ${f}`)
                try { await require('fs').promises.unlink(f) } catch (e) {}
            }

            try { await require('fs').promises.unlink(meta_path) } catch (e) {}
            try { await require('fs').promises.unlink(await get_fullpath()) } catch (e) {}
        }
        await old_unproxy

        var self = {}

        console.log(`proxy_url: ${url}`)

        if (!start_something()) return

        // if we're accessing /blah/index, it will be normalized to /blah,
        // but we still want to create a directory out of blah in this case
        if (wasnt_normal && !(await is_dir(fullpath))) await ensure_path(fullpath)

        await ensure_path(require("path").dirname(fullpath))

        finish_something()

        async function get_fullpath() {
            var p = fullpath
            while (await is_dir(p)) p = require("path").join(p, 'index')
            return p
        }

        var peer = Math.random().toString(36).slice(2),
            char_counter = -1,
            file_last_version = null,
            file_last_digest = null
        self.file_last_text = null
        self.file_last_stat = null
        self.file_read_only = null
        var file_needs_reading = true,
            file_needs_writing = null,
            file_loop_pump_lock = 0

        self.signal_file_needs_reading = () => {
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
            console.log(`send_out ${url} ${JSON.stringify(stuff, null, 4).slice(0, 1000)}`)

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
                            ...(x => x && {Cookie: x})(config.cookies?.[new URL(url).hostname])
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

        file_loop_pump()
        async function file_loop_pump() {
            if (file_loop_pump_lock) return
            file_loop_pump_lock++

            if (!start_something()) return

            await within_file_lock(fullpath, async () => {
                var fullpath = await get_fullpath()

                if (file_last_version === null) {
                    if (await require('fs').promises.access(meta_path).then(
                        () => 1, () => 0)) {
                        // meta file exists
                        let meta = JSON.parse(await require('fs').promises.readFile(meta_path, { encoding: 'utf8' }))
                        let _ = ({ version: file_last_version, digest: file_last_digest } = Array.isArray(meta) ? { version: meta } : meta)

                        self.file_last_text = (await braid_text.get(url, { version: file_last_version })).body
                        file_needs_writing = !v_eq(file_last_version, (await braid_text.get(url, {})).version)

                        // sanity check
                        if (file_last_digest && require('crypto').createHash('sha256').update(self.file_last_text).digest('base64') != file_last_digest) throw new Error('file_last_text does not match file_last_digest')
                    } else if (await require('fs').promises.access(fullpath).then(() => 1, () => 0)) {
                        // file exists, but not meta file
                        file_last_version = []
                        self.file_last_text = ''
                    }
                }

                while (file_needs_reading || file_needs_writing) {
                    if (file_needs_reading) {
                        console.log(`reading file: ${fullpath}`)

                        file_needs_reading = false

                        // check if file is missing, and create it if so..
                        if (!(await file_exists(fullpath))) {
                            console.log(`file not found, creating: ${fullpath}`)
                            
                            file_needs_writing = true
                            file_last_version = []
                            self.file_last_text = ''

                            await require('fs').promises.writeFile(fullpath, self.file_last_text)
                        }

                        if (self.file_read_only === null) try { self.file_read_only = await is_read_only(fullpath) } catch (e) { }

                        let text = await require('fs').promises.readFile(
                            fullpath, { encoding: 'utf8' })

                        var stat = await require('fs').promises.stat(fullpath, { bigint: true })

                        var patches = diff(self.file_last_text, text)
                        if (patches.length) {
                            console.log(`found changes in: ${fullpath}`)

                            // convert from js-indicies to code-points
                            char_counter += patches_to_code_points(patches, self.file_last_text)

                            self.file_last_text = text

                            var version = [peer + "-" + char_counter]
                            var parents = file_last_version
                            file_last_version = version

                            send_out({ version, parents, patches, peer })

                            await braid_text.put(url, { version, parents, patches, peer, merge_type: 'dt' })

                            await require('fs').promises.writeFile(meta_path, JSON.stringify({ version: file_last_version, digest: require('crypto').createHash('sha256').update(self.file_last_text).digest('base64') }))
                        } else {
                            console.log(`no changes found in: ${fullpath}`)
                            if (stat_eq(stat, self.file_last_stat)) {
                                if (Date.now() > (self.file_ignore_until ?? 0))
                                    on_watcher_miss(`expected change to: ${fullpath}`)
                                else console.log(`no changes expected`)
                            } else console.log('found change in file stat')
                        }
                        self.file_last_stat = stat
                        self.file_ignore_until = Date.now() + 1000
                    }
                    if (file_needs_writing) {
                        file_needs_writing = false
                        let { version, body } = await braid_text.get(url, {})
                        if (!v_eq(version, file_last_version)) {
                            // let's do a final check to see if anything has changed
                            // before writing out a new version of the file
                            let text = await require('fs').promises.readFile(fullpath, { encoding: 'utf8' })
                            if (self.file_last_text != text) {
                                // if the text is different, let's read it first..
                                file_needs_reading = true
                                file_needs_writing = true
                                continue
                            }

                            console.log(`writing file ${fullpath}`)

                            try { if (await is_read_only(fullpath)) await set_read_only(fullpath, false) } catch (e) { }

                            file_last_version = version
                            self.file_last_text = body
                            self.file_ignore_until = Date.now() + 1000
                            await require('fs').promises.writeFile(fullpath, self.file_last_text)


                            await require('fs').promises.writeFile(meta_path, JSON.stringify({
                                version: file_last_version,
                                digest: require('crypto').createHash('sha256')
                                    .update(self.file_last_text).digest('base64')
                            }))
                        }

                        if (await is_read_only(fullpath) !== self.file_read_only) {
                            self.file_ignore_until = Date.now() + 1000
                            await set_read_only(fullpath, self.file_read_only)
                        }

                        self.file_last_stat = await require('fs').promises.stat(fullpath, { bigint: true })
                    }
                }
            })

            finish_something()

            file_loop_pump_lock--
        }

        if (is_external_link) connect()
        function connect() {
            let a = new AbortController()
            aborts.add(a)
            self.reconnect = () => {
                console.log(`reconnecting ${url}`)

                aborts.delete(a)
                a.abort()
                connect()
            }

            console.log(`connecting to ${url}`)
            braid_fetch(url, {
                signal: a.signal,
                headers: {
                    "Merge-Type": "dt",
                    Accept: 'text/plain',
                    ...(x => x && {Cookie: x})(config.cookies?.[new URL(url).hostname]),
                },
                subscribe: true,
                retry: {
                    onRes: (res) => {
                        console.log(`connected to ${url}`)
                        console.log(`  editable = ${res.headers.get('editable')}`)

                        self.file_read_only = res.headers.get('editable') === 'false'
                        signal_file_needs_writing()
                    }
                },
                heartbeats: 120,
                parents: async () => {
                    let cur = await braid_text.get(url, {})
                    if (cur.version.length) return cur.version
                },
                peer
            }).then(x => {
                x.subscribe(async update => {
                    console.log(`got external update about ${url}`)

                    if (update.body) update.body = update.body_text
                    if (update.patches) for (let p of update.patches) p.content = p.content_text

                    // console.log(`update: ${JSON.stringify(update, null, 4)}`)
                    if (update.version.length === 0) return
                    if (update.version.length !== 1) throw 'unexpected'

                    if (!start_something()) return

                    await braid_text.put(url, { ...update, peer, merge_type: 'dt' })


                    signal_file_needs_writing()
                    finish_something()
                }, e => (e?.name !== "AbortError") && crash(e))
            }).catch(e => (e?.name !== "AbortError") && crash(e))
        }

        // send them stuff we have but they don't
        if (is_external_link) send_new_stuff()
        async function send_new_stuff() {
            if (!start_something()) return
            try {
                let a = new AbortController()
                aborts.add(a)
                var r = await braid_fetch(url, {
                    signal: a.signal,
                    method: "HEAD",
                    headers: {
                        Accept: 'text/plain',
                        ...(x => x && {Cookie: x})(config.cookies?.[new URL(url).hostname]),
                    },
                    retry: true
                })
                aborts.delete(a)

                if (r.headers.get('editable') === 'false') {
                    console.log('do not send updates for read-only file: ' + url)
                    return
                }

                var chain = Promise.resolve()
                braid_text.get(url, braid_text_get_options = {
                    parents: r.headers.get('version') && JSON.parse(`[${r.headers.get('version')}]`),
                    merge_type: 'dt',
                    peer,
                    subscribe: async (u) => {
                        if (u.version.length) chain = chain.then(() => send_out({...u, peer}))
                    },
                })
            } catch (e) {
                if (e?.name !== "AbortError") crash(e)
            }
            finish_something()            
        }

        // for config and errors file, listen for web changes
        if (!is_external_link) braid_text.get(url, braid_text_get_options = {
            merge_type: 'dt',
            peer,
            subscribe: signal_file_needs_writing,
        })

        return self
    })
    return await proxy_url.cache[url]
}

async function ensure_path(path) {
    var parts = path.split('/').slice(1)
    for (var i = 1; i <= parts.length; i++) {
        var partial = '/' + parts.slice(0, i).join('/')
        await within_file_lock(partial, async () => {
            try {
                let stat = await require("fs").promises.stat(partial)
                if (stat.isDirectory()) return // good

                let temp = `${temp_folder}/${Math.random().toString(36).slice(2)}`
                await require('fs').promises.rename(partial, temp)
                await require("fs").promises.mkdir(partial)
                await require('fs').promises.rename(temp, partial + '/index')
            } catch (e) {
                await require("fs").promises.mkdir(partial)
            }
        })
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
    let diff = diff_main(before, after)
    let patches = []
    let offset = 0
    for (let d of diff) {
        let p = null
        if (d[0] === 1) p = { range: [offset, offset], content: d[1] }
        else if (d[0] === -1) {
            p = { range: [offset, offset + d[1].length], content: "" }
            offset += d[1].length
        } else offset += d[1].length
        if (p) {
            p.unit = "text"
            patches.push(p)
        }
    }
    return patches;
}

function free_the_cors(req, res) {
    res.setHeader('Range-Request-Allow-Methods', 'PATCH, PUT')
    res.setHeader('Range-Request-Allow-Units', 'json')
    res.setHeader("Patches", "OK")
    var free_the_cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS, HEAD, GET, PUT, UNSUBSCRIBE",
        "Access-Control-Allow-Headers": "subscribe, client, version, parents, merge-type, content-type, content-range, patches, cache-control, peer"
    };
    Object.entries(free_the_cors).forEach(x => res.setHeader(x[0], x[1]))
    if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
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

function stat_eq(a, b) {
    return (!a && !b) || (a && b &&
        a.mode === b.mode &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs)
}

async function is_read_only(fullpath) {
    const stat = await require('fs').promises.stat(fullpath)
    return require('os').platform() === "win32" ?
        !!(stat.mode & 0x1) :
        !(stat.mode & 0o200)
}

async function set_read_only(fullpath, read_only) {
    console.log(`set_read_only(${fullpath}, ${read_only})`)

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
    console.error('CRASHING: ' + e + ' ' + e.stack)
    process.exit(1)
}

async function get_file_lock(fullpath) {
    if (!get_file_lock.locks) get_file_lock.locks = {}
    if (!get_file_lock.locks[fullpath]) get_file_lock.locks[fullpath] = Promise.resolve()
    return new Promise(done =>
        get_file_lock.locks[fullpath] = get_file_lock.locks[fullpath].then(() =>
            new Promise(done2 => done(done2))))
}

async function within_file_lock(fullpath, func) {
    var lock = await get_file_lock(fullpath)
    try {
        return await func()
    } finally {
        lock()
    }
}

async function file_exists(fullpath) {
    try {
        let x = await require('fs').promises.stat(fullpath)
        return x.isFile()
    } catch (e) { }
}
