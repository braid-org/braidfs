#!/usr/bin/env node

var { diff_main } = require(`${__dirname}/diff.js`),
    braid_text = require("braid-text"),
    braid_fetch = require('braid-http').fetch

braid_fetch.set_fetch(fetch_http2)

var sync_base = `${require('os').homedir()}/http`,
    braidfs_config_dir = `${sync_base}/.braidfs`,
    braidfs_config_file = `${braidfs_config_dir}/config`,
    sync_base_meta = `${braidfs_config_dir}/proxy_base_meta`
braid_text.db_folder = `${braidfs_config_dir}/braid-text-db`
var trash = `${braidfs_config_dir}/trash`
var temp_folder = `${braidfs_config_dir}/temp`

var config = null,
    watcher_misses = 0,
    reconnect_rate_limiter = new ReconnectRateLimiter(() =>
        config?.reconnect_delay_ms ?? 3000)

if (require('fs').existsSync(sync_base)) {
    try {
        config = require('fs').readFileSync(braidfs_config_file, 'utf8')
    } catch (e) { return console.log(`could not find config file: ${braidfs_config_file}`) }
    try {
        config = JSON.parse(config)
    } catch (e) { return console.log(`could not parse config file: ${braidfs_config_file}`) }

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
} else {
    config = {
        sync: {},
        cookies: { 'example.com': 'secret_pass' },
        port: 45678,
        scan_interval_ms: 1000 * 20,
        reconnect_delay_ms: 1000 * 3
    }
    require('fs').mkdirSync(braidfs_config_dir, { recursive: true })
    require('fs').writeFileSync(braidfs_config_file, JSON.stringify(config, null, 4))
}

require('fs').mkdirSync(sync_base_meta, { recursive: true })
require('fs').mkdirSync(trash, { recursive: true })
require('fs').mkdirSync(temp_folder, { recursive: true })

// Add instructions for how to run in the background on this OS
var to_run_in_background = process.platform === 'darwin' ? `
To run daemon in background:
    launchctl submit -l org.braid.braidfs -- braidfs run` : ''
// ...except this doesn't work yet.  So disable.
to_run_in_background = ''

console.log(`braidfs version: ${require(`${__dirname}/package.json`).version}`)

// process command line args
var argv = process.argv.slice(2)
if (argv.length === 1 && argv[0].match(/^(run|serve)$/)) {
    return main()
} else if (argv.length && argv.length % 2 == 0 && argv.every((x, i) => i % 2 != 0 || x.match(/^(sync|unsync)$/))) {
    return (async () => {
        for (let i = 0; i < argv.length; i += 2) {
            var sync = argv[i] === 'sync',
                url = argv[i + 1]
            if (!url.match(/^https?:\/\//)) {
                if (url.startsWith('/')) url = require('path').relative(sync_base, url)
                url = `https://${url}`
            }
            console.log(`${sync ? '' : 'un'}subscribing ${sync ? 'to' : 'from'} ${url}`)
            try {
                var res = await braid_fetch(`http://localhost:${config.port}/.braidfs/config`, {
                    method: 'PUT',
                    patches: [{
                        unit: 'json',
                        range: `sync[${JSON.stringify(url)}]`,
                        content: sync ? 'true' : ''
                    }]
                })
                if (res.ok) {
                    console.log(`Now ${sync ? '' : 'un'}subscribed ${sync ? 'to' : 'from'} ${url} in ~/http/.braidfs/config`)
                } else {
                    console.log(`failed to ${operation} ${url}`)
                    console.log(`server responded with ${res.status}: ${await res.text()}`)
                    return
                }
            } catch (e) {
                console.log(`The braidfs daemon does not appear to be running.
You can run it with:
    braidfs run${to_run_in_background}`)
                return
            }
        }
    })()
} else {
    return console.log(`Usage:
    braidfs run
    braidfs sync <URL>
    braidfs unsync <URL>${to_run_in_background}`)
}

async function main() {
    process.on("unhandledRejection", (x) => console.log(`unhandledRejection: ${x.stack}`))
    process.on("uncaughtException", (x) => console.log(`uncaughtException: ${x.stack}`))
    require('http').createServer(async (req, res) => {
        try {
            console.log(`${req.method} ${req.url}`)

            if (req.url === '/favicon.ico') return

            if (!['::ffff:127.0.0.1', '127.0.0.1', '::1'].includes(req.socket.remoteAddress)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' })
                return res.end('Access denied: only accessible from localhost')
            }

            // Free the CORS
            free_the_cors(req, res)
            if (req.method === 'OPTIONS') return

            var url = req.url.slice(1)

            var m = url.match(/^\.braidfs\/get_version\/([^\/]*)\/([^\/]*)/)
            if (m) {
                var fullpath = decodeURIComponent(m[1])
                var hash = decodeURIComponent(m[2])

                var path = require('path').relative(sync_base, fullpath)
                var sync = await sync_url.cache[normalize_url(path)]
                var version = sync?.hash_to_version_cache.get(hash)?.version
                if (!version) res.statusCode = 404
                return res.end(JSON.stringify(version))
            }

            var m = url.match(/^\.braidfs\/set_version\/([^\/]*)\/([^\/]*)/)
            if (m) {
                var fullpath = decodeURIComponent(m[1])
                var path = require('path').relative(sync_base, fullpath)
                var sync = await sync_url.cache[normalize_url(path)]

                var parents = JSON.parse(decodeURIComponent(m[2]))
                var parent_text = sync?.version_to_text_cache.get(JSON.stringify(parents)) ?? (await braid_text.get(sync.url, { parents })).body

                var text = await new Promise(done => {
                    const chunks = []
                    req.on('data', chunk => chunks.push(chunk))
                    req.on('end', () => done(Buffer.concat(chunks).toString()))
                })

                var patches = diff(parent_text, text)

                if (patches.length) {
                    sync.local_edit_counter += patches_to_code_points(patches, parent_text)
                    var version = [sync.peer + "-" + (sync.local_edit_counter - 1)]
                    await braid_text.put(sync.url, { version, parents, patches, merge_type: 'dt' })

                    // may be able to do this more efficiently.. we want to make sure we're capturing a file write that is after our version was written.. there may be a way we can avoid calling file_needs_writing here
                    var stat = await new Promise(done => {
                        sync.file_written_cbs.push(done)
                        sync.signal_file_needs_writing()
                    })

                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    return res.end(stat.mtimeMs.toString())
                } else return res.end('null')
            }

            if (url !== '.braidfs/config' && url !== '.braidfs/errors') {
                res.writeHead(404, { 'Content-Type': 'text/html' })
                return res.end('Nothing to see here. You can go to <a href=".braidfs/config">.braidfs/config</a> or <a href=".braidfs/errors">.braidfs/errors</a>')
            }

            braid_text.serve(req, res, { key: normalize_url(url) })
        } catch (e) {
            console.log(`e = ${e.stack}`)
            res.writeHead(500, { 'Error-Message': '' + e })
            res.end('' + e)
        }
    }).listen(config.port, () => {
        console.log(`daemon started on port ${config.port}`)
        if (!config.allow_remote_access) console.log('!! only accessible from localhost !!')

        sync_url('.braidfs/config').then(() => {
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
                            unsync_url(url)

                        // sync all the new stuff
                        for (let x of Object.entries(config.sync)) if (x[1]) sync_url(x[0])

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
                        for (let [path, x] of Object.entries(sync_url.cache))
                            if (changed.has(path.split(/\//)[0].split(/:/)[0]))
                                (await x).reconnect?.()
                    } catch (e) {
                        if (x !== '') console.log(`warning: config file is currently invalid.`)
                        return
                    }
                }
            })
        })
        sync_url('.braidfs/errors')

        console.log({ sync: config.sync })
        for (let x of Object.entries(config.sync)) if (x[1]) sync_url(x[0])

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
    await require('fs').promises.rename(fullpath, dest)

    // and log an error
    await log_error(`error: unsynced file ${fullpath}; moved to ${dest}`)
}

async function log_error(text) {
    console.log(`LOGGING ERROR: ${text}`)

    var x = await braid_text.get('.braidfs/errors', {}),
        len = [...x.body].length
    await braid_text.put('.braidfs/errors', {
        parents: x.version,
        patches: [{
            unit: 'text',
            range: `[${len}:${len}]`,
            content: `${text}\n`
        }]
    })
}

async function watch_files() {
    if (watch_files.watcher === 42) return
    let w = watch_files.watcher
    watch_files.watcher = 42
    await w?.close()

    console.log('watch files..')
    watch_files.watcher = require('chokidar').watch(sync_base).
        on('add', x => chokidar_handler(x, 'add')).
        on('change', x => chokidar_handler(x, 'change')).
        on('unlink', x => chokidar_handler(x, 'unlink'))

    async function chokidar_handler(fullpath, event) {
        // Make sure the path is within sync_base..
        if (!fullpath.startsWith(sync_base))
            return on_watcher_miss(`path ${fullpath} outside ${sync_base}`)

        // See if this is a file we should skip..
        var path = require('path').relative(sync_base, fullpath)
        if (skip_file(path)) return

        // Make sure the path is to a file, and not a directory
        if (event != 'unlink' && (await require('fs').promises.stat(fullpath)).isDirectory())
            return on_watcher_miss(`expected file, got: ${fullpath}`)

        console.log(`file event: ${path}, event: ${event}`)

        var sync = await sync_url.cache[normalize_url(path)]

        if (sync && event != 'add') sync.signal_file_needs_reading()
        if (!sync && event != 'unlink') await trash_file(fullpath, path)
    }
}

async function scan_files() {
    scan_files.do_again = true
    if (scan_files.running) return
    if (scan_files.timeout) clearTimeout(scan_files.timeout)

    scan_files.running = true
    while (scan_files.do_again) {
        scan_files.do_again = false
        var timestamp = new Date().toLocaleTimeString(
            'en-US', {minute: '2-digit', second: '2-digit', hour: '2-digit'}
        )
        console.log(`scan files.. `, timestamp)
        if (await f(sync_base))
            on_watcher_miss(`scanner picked up a change that the watcher should have gotten`, false)
    }
    scan_files.running = false

    scan_files.timeout = setTimeout(scan_files, config.scan_interval_ms ?? (20 * 1000))

    async function f(fullpath) {
        path = require('path').relative(sync_base, fullpath)
        if (skip_file(path)) return

        let stat = await require('fs').promises.stat(fullpath, { bigint: true })
        if (stat.isDirectory()) {
            let found
            for (let file of await require('fs').promises.readdir(fullpath))
                found ||= await f(`${fullpath}/${file}`)
            return found
        } else {
            var sync = await sync_url.cache[normalize_url(path)]
            if (!sync) return await trash_file(fullpath, path)

            stat = await require('fs').promises.stat(fullpath, { bigint: true })
            if (!stat_eq(stat, sync.file_last_stat)) {
                console.log(`scan thinks ${path} has changed`)
                sync.signal_file_needs_reading()
                return true
            }
        }
    }
}

function unsync_url(url) {
    url = normalize_url(url).replace(/^https?:\/\//, '')
    if (!sync_url.cache?.[url]) return

    console.log(`unsync_url: ${url}`)

    delete sync_url.cache[url]
    sync_url.chain = sync_url.chain.then(unsync_url.cache[url])
    delete unsync_url.cache[url]
}

async function sync_url(url) {
    // normalize url by removing any trailing /index/index/
    var normalized_url = normalize_url(url),
        wasnt_normal = normalized_url != url
    url = normalized_url

    var is_external_link = url.match(/^https?:\/\//),
        path = is_external_link ? url.replace(/^https?:\/\//, '') : url,
        fullpath = `${sync_base}/${path}`,
        meta_path = `${sync_base_meta}/${braid_text.encode_filename(url)}`

    if (!sync_url.cache) sync_url.cache = {}
    if (!sync_url.chain) sync_url.chain = Promise.resolve()
    if (!sync_url.cache[path]) {
        var self = {url},
            freed = false,
            aborts = new Set(),
            braid_text_get_options = null
        var wait_promise = Promise.resolve()
        var wait_on = p => {
            wait_promise = wait_promise.then(() => p)
            return p
        }
        var get_fullpath = async () => {
            var p = fullpath
            while (await is_dir(p))
                p = require("path").join(p, 'index')
            return p
        }
        if (!unsync_url.cache) unsync_url.cache = {}
        unsync_url.cache[path] = async () => {
            freed = true
            await self.disconnect?.()
            await wait_promise

            delete braid_text.cache[url]
            for (let f of await braid_text.get_files_for_key(url)) {
                try {
                    console.log(`trying to delete: ${f}`)
                    await require('fs').promises.unlink(f)
                } catch (e) {}
            }

            try {
                console.log(`trying to delete: ${meta_path}`)
                await require('fs').promises.unlink(meta_path)
            } catch (e) {}
            try {
                var fp = await get_fullpath()
                console.log(`trying to delete: ${fp}`)
                await require('fs').promises.unlink(fp)
            } catch (e) {}
        }
        sync_url.cache[path] = sync_url.chain = sync_url.chain.then(init)
    }
    async function init() {
        if (freed) return

        console.log(`sync_url: ${url}`)

        var resource = await braid_text.get_resource(url)
        if (freed) return

        // if we're accessing /blah/index, it will be normalized to /blah,
        // but we still want to create a directory out of blah in this case
        if (wasnt_normal && !(await is_dir(fullpath))) {
            if (freed) return
            await ensure_path(fullpath)
        }
        if (freed) return

        await ensure_path(require("path").dirname(fullpath))
        if (freed) return

        self.peer = Math.random().toString(36).slice(2)
        self.local_edit_counter = 0
        self.fork_point = null
        var file_last_version = null,
            file_last_digest = null
        self.file_last_text = null
        self.file_last_stat = null
        self.file_read_only = null
        var file_needs_reading = true,
            file_needs_writing = null,
            file_loop_pump_lock = 0
        self.file_written_cbs = []

        // store a recent mapping of content-hashes to their versions,
        // to support the command line: braidfs editing filename < file
        self.hash_to_version_cache = new Map()
        self.version_to_text_cache = new Map()
        function add_to_version_cache(text, version) {
            if (self.hash_to_version_cache.size)
                [...self.hash_to_version_cache.values()].pop().time = Date.now()

            var hash = sha256(text)
            var value = self.hash_to_version_cache.get(hash)
            if (value) {
                self.hash_to_version_cache.delete(hash)
                self.version_to_text_cache.delete(JSON.stringify(value.version))
            }
            self.hash_to_version_cache.set(hash, { version })
            self.version_to_text_cache.set(JSON.stringify(version), text)

            var too_old = Date.now() - 30000
            for (var [key, value] of self.hash_to_version_cache) {
                if (value.time > too_old ||
                    self.hash_to_version_cache.size <= 1) break
                self.hash_to_version_cache.delete(key)
                self.version_to_text_cache.delete(JSON.stringify(value.version))
            }
        }

        self.signal_file_needs_reading = () => {
            if (freed) return
            file_needs_reading = true
            file_loop_pump()
        }

        self.signal_file_needs_writing = (just_meta_file) => {
            if (freed) return

            if (!just_meta_file) file_needs_writing = true
            else if (just_meta_file && !file_needs_writing)
                file_needs_writing = 'just_meta_file'

            file_loop_pump()
        }

        await within_fiber(fullpath, async () => {
            if (freed) return
            var fullpath = await get_fullpath()
            if (freed) return
            if (await wait_on(require('fs').promises.access(meta_path).then(
                () => 1, () => 0))) {
                if (freed) return

                // meta file exists
                let meta = JSON.parse(await wait_on(require('fs').promises.readFile(meta_path, { encoding: 'utf8' })))
                if (freed) return
                
                // destructure stuff from the meta file
                !({
                    version: file_last_version,
                    digest: file_last_digest,
                    peer: self.peer,
                    local_edit_counter: self.local_edit_counter,
                    fork_point: self.fork_point
                } = Array.isArray(meta) ? { version: meta } : meta)

                if (!self.peer) self.peer = Math.random().toString(36).slice(2)
                if (!self.local_edit_counter) self.local_edit_counter = 0

                try {
                    self.file_last_text = (await wait_on(braid_text.get(url, { version: file_last_version }))).body
                } catch (e) {
                    if (freed) return
                    // the version from the meta file doesn't exist..
                    if (fullpath === braidfs_config_file) {
                        // in the case of the config file,
                        // we want to load the current file contents,
                        // which we can acheive by setting file_last_version
                        // to the latest
                        console.log(`WARNING: there was an issue with the config file, and it is reverting to the contents at: ${braidfs_config_file}`)
                        var x = await wait_on(braid_text.get(url, {}))
                        if (freed) return
                        file_last_version = x.version
                        self.file_last_text = x.body
                        file_last_digest = sha256(self.file_last_text)
                    } else throw new Error(`sync error: version not found: ${file_last_version}`)
                }
                if (freed) return

                file_needs_writing = !v_eq(file_last_version, (await wait_on(braid_text.get(url, {}))).version)
                if (freed) return

                // sanity check
                if (file_last_digest && sha256(self.file_last_text) != file_last_digest) throw new Error('file_last_text does not match file_last_digest')
            } else if (await wait_on(require('fs').promises.access(fullpath).then(() => 1, () => 0))) {
                if (freed) return
                // file exists, but not meta file
                file_last_version = []
                self.file_last_text = ''
            }
        })
        if (freed) return

        file_loop_pump()
        async function file_loop_pump() {
            if (freed) return
            if (file_loop_pump_lock) return
            file_loop_pump_lock++

            await within_fiber(fullpath, async () => {
                var fullpath = await get_fullpath()
                if (freed) return

                while (file_needs_reading || file_needs_writing) {
                    async function write_meta_file() {
                        if (freed) return
                        await wait_on(require('fs').promises.writeFile(meta_path, JSON.stringify({
                            version: file_last_version,
                            digest: sha256(self.file_last_text),
                            peer: self.peer,
                            local_edit_counter: self.local_edit_counter,
                            fork_point: self.fork_point
                        })))
                    }

                    if (file_needs_reading) {
                        console.log(`reading file: ${fullpath}`)

                        file_needs_reading = false

                        // check if file is missing, and create it if so..
                        if (!(await wait_on(file_exists(fullpath)))) {
                            if (freed) return

                            console.log(`file not found, creating: ${fullpath}`)
                            
                            file_needs_writing = true
                            file_last_version = []
                            self.file_last_text = ''

                            await wait_on(require('fs').promises.writeFile(fullpath, self.file_last_text))
                        }
                        if (freed) return

                        if (self.file_read_only === null) try { self.file_read_only = await wait_on(is_read_only(fullpath)) } catch (e) { }
                        if (freed) return

                        let text = await wait_on(require('fs').promises.readFile(
                            fullpath, { encoding: 'utf8' }))
                        if (freed) return

                        var stat = await wait_on(require('fs').promises.stat(fullpath, { bigint: true }))
                        if (freed) return

                        var patches = diff(self.file_last_text, text)
                        if (patches.length) {
                            console.log(`found changes in: ${fullpath}`)

                            // convert from js-indicies to code-points
                            self.local_edit_counter += patches_to_code_points(patches, self.file_last_text)

                            self.file_last_text = text

                            var version = [self.peer + "-" + (self.local_edit_counter - 1)]
                            var parents = file_last_version
                            file_last_version = version

                            add_to_version_cache(text, version)

                            await wait_on(braid_text.put(url, { version, parents, patches, merge_type: 'dt' }))
                            if (freed) return

                            await write_meta_file()
                            if (freed) return
                        } else {
                            add_to_version_cache(text, file_last_version)

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
                    if (file_needs_writing === 'just_meta_file') {
                        file_needs_writing = false
                        await write_meta_file()
                        if (freed) return
                    } else if (file_needs_writing) {
                        file_needs_writing = false
                        let { version, body } = await wait_on(braid_text.get(url, {}))
                        if (freed) return
                        if (!v_eq(version, file_last_version)) {
                            // let's do a final check to see if anything has changed
                            // before writing out a new version of the file
                            let text = await wait_on(require('fs').promises.readFile(fullpath, { encoding: 'utf8' }))
                            if (freed) return
                            if (self.file_last_text != text) {
                                // if the text is different, let's read it first..
                                file_needs_reading = true
                                file_needs_writing = true
                                continue
                            }

                            console.log(`writing file ${fullpath}`)

                            add_to_version_cache(body, version)

                            try { if (await wait_on(is_read_only(fullpath))) await wait_on(set_read_only(fullpath, false)) } catch (e) { }
                            if (freed) return

                            file_last_version = version
                            self.file_last_text = body
                            self.file_ignore_until = Date.now() + 1000
                            await wait_on(require('fs').promises.writeFile(fullpath, self.file_last_text))
                            if (freed) return
                        }

                        await write_meta_file()
                        if (freed) return

                        if (await wait_on(is_read_only(fullpath)) !== self.file_read_only) {
                            if (freed) return
                            self.file_ignore_until = Date.now() + 1000
                            await wait_on(set_read_only(fullpath, self.file_read_only))
                        }
                        if (freed) return

                        self.file_last_stat = await wait_on(require('fs').promises.stat(fullpath, { bigint: true }))
                        if (freed) return

                        for (var cb of self.file_written_cbs) cb(self.file_last_stat)
                        self.file_written_cbs = []
                    }
                }
            })

            file_loop_pump_lock--
        }

        self.update_fork_point = (version, parents) => {
            self.fork_point = extend_frontier(self.fork_point, version, parents)
            self.signal_file_needs_writing(true)
        }

        function extend_frontier(frontier, version, parents) {
            // special case:
            // if current frontier has all parents,
            //    then we can just remove those
            //    and add version
            var frontier_set = new Set(frontier)
            if (parents.length &&
                parents.every(p => frontier_set.has(p))) {
                parents.forEach(p => frontier_set.delete(p))
                for (var event of version) frontier_set.add(event)
                frontier = [...frontier_set.values()]
            } else {
                // full-proof approach..
                var looking_for = frontier_set
                for (var event of version) looking_for.add(event)

                frontier = []
                var shadow = new Set()

                var bytes = resource.doc.toBytes()
                var [_, events, parentss] = braid_text.dt_parse([...bytes])
                for (var i = events.length - 1; i >= 0 && looking_for.size; i--) {
                    var e = events[i].join('-')
                    if (looking_for.has(e)) {
                        looking_for.delete(e)
                        if (!shadow.has(e)) frontier.push(e)
                        shadow.add(e)
                    }
                    if (shadow.has(e))
                        parentss[i].forEach(p => shadow.add(p.join('-')))
                }
            }
            return frontier.sort()
        }

        var waitTime = 1
        var last_connect_timer = null

        if (is_external_link) connect()
        async function connect() {
            if (freed) return
            if (last_connect_timer) return
            console.log(`connecting to ${url}`)

            var closed = false
            var prev_disconnect = self.disconnect
            self.disconnect = async () => {
                if (closed) return
                closed = true
                reconnect_rate_limiter.on_diss(url)
                for (var a of aborts) a.abort()
                aborts.clear()
                if (braid_text_get_options) await braid_text.forget(url, braid_text_get_options)
                braid_text_get_options = null
            }
            self.reconnect = connect

            await prev_disconnect?.()
            if (freed || closed) return

            async function retry(e) {
                if (freed || closed) return
                var p = self.disconnect()

                console.log(`reconnecting in ${waitTime}s: ${url} after error: ${e}`)
                last_connect_timer = setTimeout(async () => {
                    await p
                    await reconnect_rate_limiter.get_turn(url)
                    last_connect_timer = null
                    connect()
                }, waitTime * 1000)
                waitTime = Math.min(waitTime + 1, 3)
            }

            try {
                var initial_connect_done
                var initial_connect_promise = new Promise(done => initial_connect_done = done)

                async function my_fetch(params) {
                    if (freed || closed) return
                    try {
                        var a = new AbortController()
                        aborts.add(a)
                        return await braid_fetch(url, {
                            ...params,
                            signal: a.signal,
                            headers: {
                                ...params.headers,
                                "Merge-Type": "dt",
                                "Content-Type": 'text/plain',
                                ...(x => x && {Cookie: x})(config.cookies?.[new URL(url).hostname])
                            },
                        })
                    } catch (e) {
                        if (freed || closed) return
                        aborts.delete(a)
                        throw e
                    }
                }
                
                async function send_out(stuff) {
                    if (freed || closed) return

                    console.log(`send_out ${url} ${JSON.stringify(stuff, null, 4).slice(0, 1000)}`)

                    var r = await my_fetch({ method: "PUT", ...stuff,
                        retry: { retryRes: r => r.status !== 401 && r.status !== 403 }})
                    if (freed || closed) return

                    // the server has acknowledged this version,
                    // so add it to the fork point
                    if (r.ok) self.update_fork_point(stuff.version, stuff.parents)

                    // if we're not authorized,
                    if (r.status == 401 || r.status == 403) {
                        // and it's one of our versions (a local edit),
                        if (self.peer === braid_text.decode_version(stuff.version[0])[0]) {
                            // then revert it
                            console.log(`access denied: reverting local edits`)
                            unsync_url(url)
                            sync_url(url)
                        }
                    }
                }

                async function find_fork_point() {
                    if (freed || closed) return
                    console.log(`[find_fork_point] url: ${url}`)

                    // see if remote has the fork point
                    if (self.fork_point) {
                        var r = await my_fetch({
                            method: "HEAD",
                            version: self.fork_point,
                            retry: { retryRes: r =>
                                r.status !== 309 && r.status !== 500 }
                        })
                        if (freed || closed) return
                        if (r.ok) return console.log(`[find_fork_point] "${url.split('/').pop()}" has our latest fork point, hooray!`)
                    }

                    // otherwise let's binary search for new fork point..
                    var bytes = resource.doc.toBytes()
                    var [_, events, __] = braid_text.dt_parse([...bytes])
                    events = events.map(x => x.join('-'))

                    var min = -1
                    var max = events.length
                    self.fork_point = []
                    while (min + 1 < max) {
                        var i = Math.floor((min + max)/2)
                        var version = [events[i]]

                        console.log(`min=${min}, max=${max}, i=${i}, version=${version}`)

                        var st = Date.now()
                        var r = await my_fetch({
                            method: "HEAD",
                            version,
                            retry: { retryRes: r =>
                                r.status !== 309 && r.status !== 500 }
                        })
                        if (freed || closed) return
                        console.log(`fetched in ${Date.now() - st}`)

                        if (r.ok) {
                            min = i
                            self.fork_point = version
                        } else max = i
                    }
                    console.log(`[find_fork_point] settled on: ${JSON.stringify(self.fork_point)}`)
                    self.signal_file_needs_writing(true)
                }

                await find_fork_point()
                if (freed || closed) return

                await send_new_stuff()
                if (freed || closed) return

                var a = new AbortController()
                aborts.add(a)
                var res = await braid_fetch(url, {
                    signal: a.signal,
                    headers: {
                        "Merge-Type": "dt",
                        'accept-encoding': 'updates(dt)',
                        Accept: 'text/plain',
                        ...(x => x && {Cookie: x})(config.cookies?.[new URL(url).hostname]),
                    },
                    subscribe: true,
                    heartbeats: 120,
                    parents: self.fork_point,
                    peer: self.peer
                })
                if (freed || closed) return

                if (res.status < 200 || res.status >= 300) return retry(new Error(`unexpected status: ${res.status}`))

                if (res.status !== 209)
                    return log_error(`Can't sync ${url} -- got bad response ${res.status} from server (expected 209)`)

                console.log(`connected to ${url}`.padEnd(70, ' ')
                            + `(editable: ${res.headers.get('editable')})`)

                reconnect_rate_limiter.on_conn(url)

                self.file_read_only = res.headers.get('editable') === 'false'
                self.signal_file_needs_writing()
                
                initial_connect_done()
                res.subscribe(async update => {
                    if (freed || closed) return

                    if (!update.status) {
                        console.log(`got initial update about ${url}`)

                        // manually apply the dt bytes..
                        // ..code bits taken from braid-text put..
                        var bytes = update.body

                        var start_i = 1 + resource.doc.getLocalVersion().reduce((a, b) => Math.max(a, b), -1)
                        resource.doc.mergeBytes(bytes)

                        // update resource.actor_seqs
                        var end_i = resource.doc.getLocalVersion().reduce((a, b) => Math.max(a, b), -1)
                        for (var i = start_i; i <= end_i; i++) {
                            var v = resource.doc.localToRemoteVersion([i])[0]
                            if (!resource.actor_seqs[v[0]]) resource.actor_seqs[v[0]] = new braid_text.RangeSet()
                            resource.actor_seqs[v[0]].add_range(v[1], v[1])
                        }

                        resource.val = resource.doc.get()
                        resource.need_defrag = true
                        await resource.db_delta(bytes)
                        if (freed || closed) return

                        self.update_fork_point(JSON.parse(`[${res.headers.get('current-version')}]`), self.fork_point)
                        self.signal_file_needs_writing()
                        return
                    }

                    console.log(`got external update about ${url}`)

                    if (update.body) update.body = update.body_text
                    if (update.patches) for (let p of update.patches) p.content = p.content_text

                    // console.log(`update: ${JSON.stringify(update, null, 4)}`)
                    if (update.version.length === 0) return
                    if (update.version.length !== 1) throw 'unexpected'

                    await wait_on(braid_text.put(url, { ...update, peer: self.peer, merge_type: 'dt' }))
                    if (freed || closed) return

                    // the server is giving us this version,
                    // so it must have it,
                    // so let's add it to our fork point
                    self.update_fork_point(update.version, update.parents)

                    self.signal_file_needs_writing()
                }, retry)

                // send it stuff we have but it doesn't't
                async function send_new_stuff() {
                    if (freed || closed) return
                    var q = []
                    var in_flight = new Map()
                    var max_in_flight = 10
                    var send_pump_lock = 0

                    async function send_pump() {
                        send_pump_lock++
                        if (send_pump_lock > 1) return
                        try {
                            if (freed || closed) return
                            if (in_flight.size >= max_in_flight) return
                            if (!q.length) {
                                var frontier = self.fork_point
                                for (var u of in_flight.values())
                                    frontier = extend_frontier(frontier, u.version, u.parents)

                                var options = {
                                    parents: frontier,
                                    merge_type: 'dt',
                                    peer: self.peer,
                                    subscribe: u => u.version.length && q.push(u)
                                }
                                await braid_text.get(url, options)
                                await braid_text.forget(url, options)
                            }
                            while (q.length && in_flight.size < max_in_flight) {
                                let u = q.shift()
                                in_flight.set(u.version[0], u);
                                (async () => {
                                    await initial_connect_promise
                                    if (freed || closed) return
                                    await send_out({...u, peer: self.peer})
                                    if (freed || closed) return
                                    in_flight.delete(u.version[0])
                                    setTimeout(send_pump, 0)
                                })()
                            }
                        } finally {
                            var retry = send_pump_lock > 1
                            send_pump_lock = 0
                            if (retry) setTimeout(send_pump, 0)
                        }
                    }

                    var initial_stuff = true
                    await wait_on(braid_text.get(url, braid_text_get_options = {
                        parents: self.fork_point,
                        merge_type: 'dt',
                        peer: self.peer,
                        subscribe: async (u) => {
                            if (freed || closed) return
                            if (u.version.length) {
                                self.signal_file_needs_writing()
                                if (initial_stuff || in_flight.size < max_in_flight) q.push(u)
                                send_pump()
                            }
                        },
                    }))
                    initial_stuff = false
                }
            } catch (e) { return retry(e) }
        }

        // for config and errors file, listen for web changes
        if (!is_external_link) braid_text.get(url, braid_text_get_options = {
            merge_type: 'dt',
            peer: self.peer,
            subscribe: () => self.signal_file_needs_writing(),
        })

        return self
    }
    return await sync_url.cache[url]
}

async function ensure_path(path) {
    var parts = path.split('/').slice(1)
    for (var i = 1; i <= parts.length; i++) {
        var partial = '/' + parts.slice(0, i).join('/')
        await within_fiber(normalize_url(partial), async () => {
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

function ReconnectRateLimiter(get_wait_time) {
    var self = {}

    self.conns = new Map() // Map<host, Set<url>>
    self.host_to_q = new Map() // Map<host, Array<resolve>>
    self.qs = [] // Array<{host, turns: Array<resolve>, last_turn}>
    self.last_turn = 0
    self.timer = null

    function process() {
        if (self.timer) clearTimeout(self.timer)
        self.timer = null

        if (!self.qs.length) return
        var now = Date.now()
        var my_last_turn = () => self.conns.size === 0 ? self.last_turn : self.qs[0].last_turn

        while (self.qs.length && now >= my_last_turn() + get_wait_time()) {
            var x = self.qs.shift()
            if (!x.turns.length) {
                self.host_to_q.delete(x.host)
                continue
            }

            x.turns.shift()()
            x.last_turn = self.last_turn = now
            self.qs.push(x)
        }

        if (self.qs.length)
            self.timer = setTimeout(process, Math.max(0,
                my_last_turn() + get_wait_time() - now))
    }

    self.get_turn = async (url) => {
        var host = new URL(url).host
        
        // If host has connections, give turn immediately
        if (self.conns.has(host)) return

        console.log(`throttling reconn to ${url} (no conns yet to ${self.conns.size ? host : 'anything'})`)
        
        if (!self.host_to_q.has(host)) {
            var turns = []
            self.host_to_q.set(host, turns)
            self.qs.unshift({host, turns, last_turn: 0})
        }
        var p = new Promise(resolve => self.host_to_q.get(host).push(resolve))
        process()
        await p
    }

    self.on_conn = url => {
        var host = new URL(url).host
        if (!self.conns.has(host))
            self.conns.set(host, new Set())
        self.conns.get(host).add(url)
        
        // If there are turns waiting for this host, resolve them all immediately
        var turns = self.host_to_q.get(host)
        if (turns) {
            for (var turn of turns) turn()
            turns.splice(0, turns.length)
        }
        
        process()
    }

    self.on_diss = url => {
        var host = new URL(url).host
        var urls = self.conns.get(host)
        if (urls) {
            urls.delete(url)
            if (urls.size === 0) self.conns.delete(host)
        }
    }

    return self
}

async function fetch_http2(url, options = {}) {
    if (!fetch_http2.sessions) {
        fetch_http2.sessions = new Map()
        process.on("exit", () => fetch_http2.sessions.forEach(s => s.close()))
    }

    var u = new URL(url)
    if (u.protocol !== "https:") return fetch(url, options)

    try {
        var session = fetch_http2.sessions.get(u.origin)
        if (!session || session.closed) {
            session = require("http2").connect(u.origin, {
                rejectUnauthorized: options.rejectUnauthorized !== false,
            })
            session.on("error", () => fetch_http2.sessions.delete(u.origin))
            session.on("close", () => fetch_http2.sessions.delete(u.origin))
            fetch_http2.sessions.set(u.origin, session)
        }

        return await new Promise((resolve, reject) => {
            var stream = session.request({
                ":method": options.method || "GET",
                ":path": u.pathname + u.search,
                ":scheme": "https",
                ":authority": u.host,
                ...Object.fromEntries(options.headers || []),
            })

            options.signal?.addEventListener("abort",
                () => stream.destroy(new Error("Request aborted")),
                { once: true })

            stream.on("response", headers => {
                var status = +headers[":status"]
                resolve({
                    ok: status >= 200 && status < 300,
                    status,
                    statusText: "",
                    headers: new Headers(Object.fromEntries(
                        Object.entries(headers).filter(([k]) =>
                            typeof k === "string" && !k.startsWith(":")))),
                    body: new ReadableStream({
                        start(ctrl) {
                            stream.on("data", x => ctrl.enqueue(new Uint8Array(x)))
                            stream.on("end", () => ctrl.close())
                            stream.on("error", err => ctrl.error(err))
                        },
                        cancel() { stream.destroy() },
                    }),
                    bodyUsed: false,
                    async _consumeBody() {
                        this.bodyUsed = true
                        var chunks = []
                        var reader = this.body.getReader()

                        while (true) {
                            var { done, value } = await reader.read()
                            if (done) break
                            chunks.push(value)
                        }
                        return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))))
                    },
                    async text() { return (await this._consumeBody()).toString() },
                    async json() { return JSON.parse(await this.text()) },
                    async arrayBuffer() {
                        var b = await this._consumeBody()
                        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
                    },
                })
            })

            stream.on("error", reject)

            var body = options.body
            if (!body) return stream.end()

            if (body instanceof Uint8Array || Buffer.isBuffer(body)) stream.end(body)
            else if (body instanceof Blob) body.arrayBuffer()
                .then((b) => stream.end(Buffer.from(b)))
                .catch(reject)
            else stream.end(typeof body === "string" ? body : JSON.stringify(body))
        })
    } catch (err) {
        if (err.code?.includes("HTTP2") || err.message?.includes("HTTP/2")) {
            console.log("HTTP/2 failed, falling back to HTTP/1.1:", err.message)
            return fetch(url, options)
        }
        throw err
    }
}

////////////////////////////////

function normalize_url(url) {
    return url.replace(/(\/index)*\/?$/, '')
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

function within_fiber(id, func) {
    if (!within_fiber.chains) within_fiber.chains = {}
    var prev = within_fiber.chains[id] || Promise.resolve()
    var curr = prev.then(async () => {
        try {
            return await func()
        } finally {
            if (within_fiber.chains[id] === curr)
                delete within_fiber.chains[id]
        }
    })
    return within_fiber.chains[id] = curr
}

async function file_exists(fullpath) {
    try {
        let x = await require('fs').promises.stat(fullpath)
        return x.isFile()
    } catch (e) { }
}

function sha256(x) {
    return require('crypto').createHash('sha256').update(x).digest('base64')
}
