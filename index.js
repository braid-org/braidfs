#!/usr/bin/env node

var { diff_main } = require(`${__dirname}/diff.js`),
    braid_text = require("braid-text"),
    braid_blob = require("braid-blob"),
    braid_fetch = require('braid-http').fetch

// Helper function to check if a file is binary based on its extension
function is_binary(filename) {
    const binaryExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.mp3', '.zip', '.tar', '.rar', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.img', '.bmp', '.tiff', '.svg', '.webp', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.wav', '.flac', '.aac', '.ogg', '.wma', '.7z', '.gz', '.bz2', '.xz'];
    return binaryExtensions.includes(require('path').extname(filename).toLowerCase());
}

braid_fetch.set_fetch(fetch_http2)
braid_text.braid_fetch.set_fetch(fetch_http2)
braid_blob.braid_fetch.set_fetch(fetch_http2)

var sync_base = `${require('os').homedir()}/http`
// Check for --sync-base argument (hidden for testing)
var argv = process.argv.slice(2)
var sync_base_index = argv.indexOf('--sync-base')
if (sync_base_index !== -1 && sync_base_index < argv.length - 1) {
    sync_base = require('path').resolve(argv[sync_base_index + 1])
    // Remove the --sync-base and its value from argv
    argv.splice(sync_base_index, 2)
    console.log(`[Testing mode] Using sync_base: ${sync_base}`)
}

var braidfs_config_dir = `${sync_base}/.braidfs`,
    braidfs_config_file = `${braidfs_config_dir}/config`,
    sync_base_meta = `${braidfs_config_dir}/proxy_base_meta`
braid_text.db_folder = `${braidfs_config_dir}/braid-text-db`
braid_blob.db_folder = { read: () => {}, write: () => {}, delete: () => {} }
braid_blob.meta_folder = `${braidfs_config_dir}/braid-blob-meta`
var trash = `${braidfs_config_dir}/trash`
var temp_folder = `${braidfs_config_dir}/temp`

// DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
var investigating_disconnects_log = `${braidfs_config_dir}/investigating_disconnects.log`

var config = null,
    watcher_misses = 0

require('fs').mkdirSync(braidfs_config_dir, { recursive: true })
require('fs').mkdirSync(sync_base_meta, { recursive: true })
require('fs').mkdirSync(trash, { recursive: true })
require('fs').mkdirSync(temp_folder, { recursive: true })

// Clear out temp folder
for (let f of require('fs').readdirSync(temp_folder))
    require('fs').unlinkSync(`${temp_folder}/${f}`)

try {
    config = require('fs').readFileSync(braidfs_config_file, 'utf8')
    try {
        config = JSON.parse(config)

        // for 0.0.55 users upgrading to 0.0.56,
        // which changes the config "domains" key to "cookies",
        // and condenses its structure a bit
        if (config.domains) {
            config.cookies = Object.fromEntries(Object.entries(config.domains).map(([k, v]) => {
                if (v.auth_headers?.Cookie) return [k, v.auth_headers.Cookie]
            }).filter(x => x))
            delete config.domains
            atomic_write_sync(braidfs_config_file, JSON.stringify(config, null, 4), temp_folder)
        }
    } catch (e) { return console.log(`could not parse config file: ${braidfs_config_file}`) }
} catch (e) {
    config = {
        sync: {},
        cookies: { 'example.com': 'secret_pass' },
        port: 45678,
        scan_interval_ms: 1000 * 20,
        reconnect_delay_ms: 1000 * 3,
    }
    atomic_write_sync(braidfs_config_file, JSON.stringify(config, null, 4), temp_folder)
}

var reconnect_rate_limiter = new ReconnectRateLimiter(config.reconnect_delay_ms ?? 3000)
if (config.reconnect_delay_ms) {
    braid_fetch.reconnect_delay_ms = config.reconnect_delay_ms
    braid_blob.reconnect_delay_ms = config.reconnect_delay_ms
}

// DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
require('fs').appendFileSync(investigating_disconnects_log, `${Date.now()} -- braidfs starting\n`)
function do_investigating_disconnects_log(url, message) {
    if (url.match(/^https:\/\/(dt\.)?braid\.org\/hello$/))
        require('fs').appendFileSync(investigating_disconnects_log, `${Date.now()}:${url} -- ${message}\n`)
}

// Add instructions for how to run in the background on this OS
var to_run_in_background = process.platform === 'darwin' ? `
To run daemon in background:
    launchctl submit -l org.braid.braidfs -- braidfs run` : ''
// ...except this doesn't work yet.  So disable.
to_run_in_background = ''

console.log(`braidfs version: ${require(`${__dirname}/package.json`).version}`)

// process command line args (argv was already processed above for --sync-base)
if (argv.length === 1 && argv[0].match(/^(run|serve)$/)) {
    return main()
} else if (argv.length && argv.length % 2 == 0 && argv.every((x, i) => i % 2 != 0 || x.match(/^(sync|unsync)$/))) {
    return (async () => {
        for (let i = 0; i < argv.length; i += 2) {
            var sync = argv[i] === 'sync',
                url = argv[i + 1]

            if (!is_well_formed_absolute_url(url)) {
                console.log(`malformed url: ${url}`)
                return
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

    await braid_text.db_folder_init()
    await braid_blob.init()

    require('http').createServer(async (req, res) => {
        try {
            // console.log(`${req.method} ${req.url}`)

            if (req.url === '/favicon.ico') return

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
                    console.log(`plugin edited ${path}`)

                    sync.local_edit_counter += patches_to_code_points(patches, parent_text)
                    var version = [sync.peer + "-" + (sync.local_edit_counter - 1)]
                    await braid_text.put(sync.url, { version, parents, patches, merge_type: 'dt' })

                    // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                    require('fs').appendFileSync(investigating_disconnects_log, `${Date.now()}:${sync.url} -- plugin edited (${sync.investigating_disconnects_thinks_connected})\n`)

                    // may be able to do this more efficiently.. we want to make sure we're capturing a file write that is after our version was written.. there may be a way we can avoid calling file_needs_writing here
                    await new Promise(done => {
                        sync.file_written_cbs.push(done)
                        sync.signal_file_needs_writing()
                    })
                    return res.end('')
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
    }).listen(config.port, 'localhost', async () => {
        console.log(`daemon started on port ${config.port}`)
        console.log('!! only accessible from localhost !!')

        await sync_url('.braidfs/config')
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
        sync_url('.braidfs/errors')

        // console.log({ sync: config.sync })
        for (let x of Object.entries(config.sync)) if (x[1]) sync_url(x[0])

        watch_files()
        setTimeout(scan_files, 1200)
    }).on('error', e => {
        if (e.code === 'EADDRINUSE') return console.log(`ERROR: port ${config.port} is in use`)
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

    // console.log('watch files..')
    watch_files.watcher = require('chokidar').watch(sync_base, {
        useFsEvents: true,
        usePolling: false,
    }). on('add', x => chokidar_handler(x, 'add')).
        on('change', x => chokidar_handler(x, 'change')).
        on('unlink', x => chokidar_handler(x, 'unlink'))

    async function chokidar_handler(fullpath, event) {
        // console.log(`file event "${event}": ${fullpath}`)

        // Make sure the path is within sync_base..
        if (!fullpath.startsWith(sync_base))
            return on_watcher_miss(`path ${fullpath} outside ${sync_base}`)

        // See if this is a file we should skip..
        var path = require('path').relative(sync_base, fullpath)
        if (skip_file(path)) return

        // Make sure the path is to a file, and not a directory
        if (event != 'unlink' && (await require('fs').promises.stat(fullpath)).isDirectory())
            return on_watcher_miss(`expected file, got: ${fullpath}`)

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

        if (watch_files?.watcher?.options?.usePolling)
            console.log('Warning: BAD PERFORMANCE!!  Filesystem using polling!')

        var st = Date.now()

        if (await f(sync_base))
            on_watcher_miss(`scanner picked up a change that the watcher should have gotten`, false)
        
        var timestamp = new Date().toLocaleTimeString(
            'en-US', {minute: '2-digit', second: '2-digit', hour: '2-digit'}
        )
        var mem = process.memoryUsage()
        var heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1)
        var rssMB = (mem.rss / 1024 / 1024).toFixed(1)
        console.log(`scan files.. ${timestamp}.  ${Date.now() - st}ms  [${heapMB} MB heap, ${rssMB} MB RSS]`)
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
            if ('' + stat.mtimeNs !== sync.file_mtimeNs_str) {
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

    // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
    do_investigating_disconnects_log(url, `unsync_url: ${url}`)

    delete sync_url.cache[url]
    sync_url.chain = sync_url.chain.then(unsync_url.cache[url])
    delete unsync_url.cache[url]
}

function sync_url(url) {
    // normalize url by removing any trailing /index/index/
    var normalized_url = normalize_url(url),
        wasnt_normal = normalized_url != url
    url = normalized_url

    var is_external_link = url.match(/^https?:\/\//),
        path = is_external_link ? url.replace(/^https?:\/\//, '') : url,
        fullpath = `${sync_base}/${path}`,
        meta_path = `${sync_base_meta}/${braid_text.encode_filename(url)}`

    // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
    do_investigating_disconnects_log(url, `sync_url`)

    if (!sync_url.cache) sync_url.cache = {}
    if (!sync_url.chain) sync_url.chain = Promise.resolve()
    if (!sync_url.cache[path]) {
        // console.log(`sync_url: ${url}`)

        var self = {url,
            ac: new AbortController()},
            aborts = new Set()
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
            self.ac.abort()
            await self.disconnect?.()
            await wait_promise

            if (self.merge_type === 'dt')
                await braid_text.delete(url)
            else if (self.merge_type === 'aww')
                await braid_blob.delete(url)

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

        sync_url.cache[path] = (async () => {
            self.merge_type = await detect_merge_type()
            if (self.ac.signal.aborted) return

            if (self.merge_type === 'dt') {
                return await (sync_url.chain = sync_url.chain.then(init))
            } else if (self.merge_type === 'aww') {
                return await (sync_url.chain = sync_url.chain.then(init_binary_sync))
            } else throw new Error(`unknown merge-type: ${self.merge_type}`)
        })()
    }
    return sync_url.cache[path]

    async function detect_merge_type() {
        // special case for .braidfs/config and .braidfs/error
        if (url.startsWith('.braidfs/')) return 'dt'

        try {
            var meta = JSON.parse(await require('fs').promises.readFile(meta_path, 'utf8'))

            // optimization for old braidfs versions
            if (typeof meta.local_edit_counter === 'number') return 'dt'

            if (meta.merge_type) return meta.merge_type
        } catch (e) {}
        if (self.ac.signal.aborted) return

        var retry_count = 0
        while (true) {
            try {
                for (var try_sub = 0; try_sub <= 1; try_sub++) {
                    await reconnect_rate_limiter.get_turn(url)
                    var res = await braid_fetch(url, {
                        signal: self.ac.signal,
                        method: 'HEAD',
                        // version needed to force Merge-Type return header
                        version: [],
                        // setting subscribe shouldn't work according to spec,
                        // but it does for some old braid-text servers
                        subscribe: !!try_sub,
                        headers: {
                            // in case it supports dt, so it doesn't give us "simpleton"
                            'Merge-Type': 'dt',
                        }
                    })
                    if (self.ac.signal.aborted) return

                    var merge_type = res.headers.get('merge-type')
                    if (merge_type) {
                        // convince the rate limiter to give turns to this host for a bit,
                        // but use a fake url so we don't on_diss from the real one
                        var fake_url = url + '?merge_type'
                        reconnect_rate_limiter.on_conn(fake_url)
                        setTimeout(() => reconnect_rate_limiter.on_diss(fake_url), 10 * 1000)
                        return merge_type
                    }
                }
            } catch (e) {
                if (e.name !== 'AbortError') throw e
            }
            if (self.ac.signal.aborted) return

            // Retry with increasing delays: 1s, 2s, 3s, 3s, 3s...
            var delay = Math.min(++retry_count, 3)
            console.log(`retrying in ${delay}s: ${url} after error: no merge-type header`)
            await new Promise(r => setTimeout(r, delay * 1000))
            if (self.ac.signal.aborted) return
        }
    }
    
    async function init_binary_sync() {
        await ensure_path_stuff()
        if (self.ac.signal.aborted) return

        console.log(`init_binary_sync: ${url}`)

        async function save_meta() {
            await atomic_write(meta_path, JSON.stringify({
                merge_type: self.merge_type,
                peer: self.peer,
                file_mtimeNs_str: self.file_mtimeNs_str
            }), temp_folder)
        }

        self.file_mtimeNs_str = null
        self.file_read_only = null

        await within_fiber(fullpath, async () => {
            try {
                Object.assign(self, JSON.parse(
                    await require('fs').promises.readFile(meta_path, 'utf8')))
            } catch (e) {}
            if (self.ac.signal.aborted) return

            if (!self.peer) self.peer = Math.random().toString(36).slice(2)
        })
        if (self.ac.signal.aborted) return

        self.signal_file_needs_reading = async () => {
            await within_fiber(fullpath, async () => {
                try {
                    if (self.ac.signal.aborted) return

                    var fullpath = await get_fullpath()
                    if (self.ac.signal.aborted) return

                    var stat = await require('fs').promises.stat(fullpath, { bigint: true })
                    if (self.ac.signal.aborted) return

                    if (self.file_mtimeNs_str !== '' + stat.mtimeNs) {
                        var data = await require('fs').promises.readFile(fullpath)
                        if (self.ac.signal.aborted) return

                        await braid_blob.put(url, data, { skip_write: true })
                        if (self.ac.signal.aborted) return
                        
                        self.file_mtimeNs_str = '' + stat.mtimeNs
                        await save_meta()
                    }
                } catch (e) {
                    if (e.code !== 'ENOENT') throw e
                }
            })
        }
        await self.signal_file_needs_reading()

        var db = {
            read: async (_key) => {
                return await within_fiber(fullpath, async () => {
                    var fullpath = await get_fullpath()
                    if (self.ac.signal.aborted) return

                    try {
                        return await require('fs').promises.readFile(fullpath)
                    } catch (e) {
                        if (e.code === 'ENOENT') return null
                        throw e
                    }
                })
            },
            write: async (_key, data) => {
                return await within_fiber(fullpath, async () => {
                    var fullpath = await get_fullpath()
                    if (self.ac.signal.aborted) return

                    try {
                        var stat = await atomic_write(fullpath, data, temp_folder)
                        if (self.ac.signal.aborted) return

                        self.file_mtimeNs_str = '' + stat.mtimeNs
                        await save_meta()
                        if (self.ac.signal.aborted) return

                        if (self.file_read_only !== null && await is_read_only(fullpath) !== self.file_read_only) {
                            if (self.ac.signal.aborted) return
                            await set_read_only(fullpath, self.file_read_only)
                        }
                    } catch (e) {
                        if (e.code === 'ENOENT') return null
                        throw e
                    }
                })
            },
            delete: async (_key) => {
                return await within_fiber(fullpath, async () => {
                    var fullpath = await get_fullpath()
                    if (self.ac.signal.aborted) return

                    try {
                        await require('fs').promises.unlink(fullpath)
                    } catch (e) {
                        if (e.code !== 'ENOENT') throw e
                    }
                })
            }
        }

        var ac
        function start_sync() {
            if (ac) ac.abort()
            if (self.ac.signal.aborted) return

            var closed = false
            ac = new AbortController()

            self.disconnect = async () => {
                if (closed) return
                closed = true
                reconnect_rate_limiter.on_diss(url)
                ac.abort()
            }

            braid_blob.sync(url, new URL(url), {
                db,
                signal: ac.signal,
                peer: self.peer,
                headers: {
                    ...(x => x && { Cookie: x })(config.cookies?.[new URL(url).hostname])
                },
                on_pre_connect: () => reconnect_rate_limiter.get_turn(url),
                on_res: async res => {
                    if (self.ac.signal.aborted) return
                    reconnect_rate_limiter.on_conn(url)
                    self.file_read_only = res.headers.get('editable') === 'false'
                    console.log(`connected to ${url}${self.file_read_only ? ' (readonly)' : ''}`)

                    await within_fiber(fullpath, async () => {
                        var fullpath = await get_fullpath()
                        if (self.ac.signal.aborted) return

                        try {
                            if (await is_read_only(fullpath) !== self.file_read_only) {
                                if (self.ac.signal.aborted) return
                                await set_read_only(fullpath, self.file_read_only)
                            }
                        } catch (e) {}
                    })
                },
                on_unauthorized: async () => {
                    console.log(`access denied: reverting local edits`)
                    unsync_url(url)
                    sync_url(url)
                },
                on_disconnect: () => reconnect_rate_limiter.on_diss(url)
            })
        }

        self.reconnect = () => start_sync()

        start_sync()
        return self
    }

    async function ensure_path_stuff() {
        if (self.ac.signal.aborted) return
        
        // if we're accessing /blah/index, it will be normalized to /blah,
        // but we still want to create a directory out of blah in this case
        if (wasnt_normal && !(await is_dir(fullpath))) {
            if (self.ac.signal.aborted) return
            await ensure_path(fullpath)
        }
        if (self.ac.signal.aborted) return

        await ensure_path(require("path").dirname(fullpath))
        if (self.ac.signal.aborted) return
    }
    
    async function init() {
        await ensure_path_stuff()
        if (self.ac.signal.aborted) return

        self.peer = Math.random().toString(36).slice(2)
        self.local_edit_counter = 0
        var file_last_version = null,
            file_last_digest = null
        self.file_last_text = null
        self.file_mtimeNs_str = null
        self.file_read_only = null
        var file_needs_reading = true,
            file_needs_writing = null,
            file_loop_pump_lock = 0
        self.file_written_cbs = []

        // hack: remvoe in future
        var old_meta_fork_point = null

        // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
        self.investigating_disconnects_thinks_connected = false

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
            if (self.ac.signal.aborted) return
            file_needs_reading = true
            file_loop_pump()
        }

        self.signal_file_needs_writing = (just_meta_file) => {
            if (self.ac.signal.aborted) return

            if (!just_meta_file) file_needs_writing = true
            else if (just_meta_file && !file_needs_writing)
                file_needs_writing = 'just_meta_file'

            file_loop_pump()
        }

        // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
        do_investigating_disconnects_log(url, 'before within_fiber')

        await within_fiber(fullpath, async () => {
            if (self.ac.signal.aborted) return
            var fullpath = await get_fullpath()
            if (self.ac.signal.aborted) return
            if (await wait_on(require('fs').promises.access(meta_path).then(
                () => 1, () => 0))) {
                if (self.ac.signal.aborted) return

                // meta file exists
                let meta = JSON.parse(await wait_on(require('fs').promises.readFile(meta_path, { encoding: 'utf8' })))
                if (self.ac.signal.aborted) return
                
                // destructure stuff from the meta file
                !({
                    version: file_last_version,
                    digest: file_last_digest,

                    // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                    // create new peer to eliminate this as a potential issue for now:
                    // peer: self.peer,
                    // local_edit_counter: self.local_edit_counter,

                    fork_point: old_meta_fork_point
                } = Array.isArray(meta) ? { version: meta } : meta)

                if (!self.peer) self.peer = Math.random().toString(36).slice(2)
                if (!self.local_edit_counter) self.local_edit_counter = 0

                try {
                    self.file_last_text = (await wait_on(braid_text.get(url, { version: file_last_version }))).body
                } catch (e) {
                    if (self.ac.signal.aborted) return
                    // the version from the meta file doesn't exist..
                    if (fullpath === braidfs_config_file) {
                        // in the case of the config file,
                        // we want to load the current file contents,
                        // which we can acheive by setting file_last_version
                        // to the latest
                        console.log(`WARNING: there was an issue with the config file, and it is reverting to the contents at: ${braidfs_config_file}`)
                        var x = await wait_on(braid_text.get(url, {}))
                        if (self.ac.signal.aborted) return
                        file_last_version = x.version
                        self.file_last_text = x.body
                        file_last_digest = sha256(self.file_last_text)
                    } else throw new Error(`sync error: version not found: ${file_last_version}`)
                }
                if (self.ac.signal.aborted) return

                file_needs_writing = !v_eq(file_last_version, (await wait_on(braid_text.get(url, {}))).version)
                if (self.ac.signal.aborted) return

                // sanity check
                if (file_last_digest && sha256(self.file_last_text) != file_last_digest) throw new Error('file_last_text does not match file_last_digest')
            } else if (await wait_on(require('fs').promises.access(fullpath).then(() => 1, () => 0))) {
                if (self.ac.signal.aborted) return
                // file exists, but not meta file
                file_last_version = []
                self.file_last_text = ''
            }
        })
        if (self.ac.signal.aborted) return

        // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
        do_investigating_disconnects_log(url, 'after within_fiber')

        await file_loop_pump()
        async function file_loop_pump() {
            if (self.ac.signal.aborted) return
            if (file_loop_pump_lock) return
            file_loop_pump_lock++

            await within_fiber(fullpath, async () => {
                var fullpath = await get_fullpath()
                if (self.ac.signal.aborted) return

                while (file_needs_reading || file_needs_writing) {
                    async function write_meta_file() {
                        if (self.ac.signal.aborted) return
                        await wait_on(atomic_write(meta_path, JSON.stringify({
                            merge_type: self.merge_type,
                            version: file_last_version,
                            digest: sha256(self.file_last_text),
                            peer: self.peer,
                            local_edit_counter: self.local_edit_counter
                        }), temp_folder))
                    }

                    if (file_needs_reading) {
                        // console.log(`reading file: ${fullpath}`)

                        file_needs_reading = false

                        // check if file is missing, and create it if so..
                        if (!(await wait_on(file_exists(fullpath)))) {
                            if (self.ac.signal.aborted) return

                            // console.log(`file not found, creating: ${fullpath}`)
                            
                            file_needs_writing = true
                            file_last_version = []
                            self.file_last_text = ''

                            await wait_on(atomic_write(fullpath, self.file_last_text, temp_folder))
                        }
                        if (self.ac.signal.aborted) return

                        if (self.file_read_only === null) try { self.file_read_only = await wait_on(is_read_only(fullpath)) } catch (e) { }
                        if (self.ac.signal.aborted) return

                        let text = await wait_on(require('fs').promises.readFile(
                            fullpath, { encoding: 'utf8' }))
                        if (self.ac.signal.aborted) return

                        var stat = await wait_on(require('fs').promises.stat(fullpath, { bigint: true }))
                        if (self.ac.signal.aborted) return

                        var patches = diff(self.file_last_text, text)
                        if (patches.length) {
                            console.log(`file change in ${path}`)

                            // convert from js-indicies to code-points
                            self.local_edit_counter += patches_to_code_points(patches, self.file_last_text)

                            self.file_last_text = text

                            var version = [self.peer + "-" + (self.local_edit_counter - 1)]
                            var parents = file_last_version
                            file_last_version = version

                            add_to_version_cache(text, version)

                            await wait_on(braid_text.put(url, { version, parents, patches, merge_type: 'dt' }))
                            if (self.ac.signal.aborted) return

                            // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                            require('fs').appendFileSync(investigating_disconnects_log, `${Date.now()}:${url} -- file edited (${self.investigating_disconnects_thinks_connected})\n`)

                            await write_meta_file()
                            if (self.ac.signal.aborted) return
                        } else {
                            add_to_version_cache(text, file_last_version)

                            // console.log(`no changes found in: ${fullpath}`)
                            if ('' + stat.mtimeNs === self.file_mtimeNs_str) {
                                if (Date.now() > (self.last_touch ?? 0) + 1000)
                                    on_watcher_miss(`expected change to: ${fullpath}`)
                                // else console.log(`no changes expected`)
                            } // else console.log('found change in file stat')
                        }
                        self.file_mtimeNs_str = '' + stat.mtimeNs
                        self.last_touch = Date.now()
                    }
                    if (file_needs_writing === 'just_meta_file') {
                        file_needs_writing = false
                        await write_meta_file()
                        if (self.ac.signal.aborted) return
                    } else if (file_needs_writing) {
                        file_needs_writing = false
                        let { version, body } = await wait_on(braid_text.get(url, {}))
                        if (self.ac.signal.aborted) return
                        if (!v_eq(version, file_last_version)) {
                            // let's do a final check to see if anything has changed
                            // before writing out a new version of the file
                            let text = await wait_on(require('fs').promises.readFile(fullpath, { encoding: 'utf8' }))
                            if (self.ac.signal.aborted) return
                            if (self.file_last_text != text) {
                                // if the text is different, let's read it first..
                                file_needs_reading = true
                                file_needs_writing = true
                                continue
                            }

                            // console.log(`writing file ${fullpath}`)

                            add_to_version_cache(body, version)

                            try { if (await wait_on(is_read_only(fullpath))) await wait_on(set_read_only(fullpath, false)) } catch (e) { }
                            if (self.ac.signal.aborted) return

                            file_last_version = version
                            self.file_last_text = body
                            self.last_touch = Date.now()
                            await wait_on(atomic_write(fullpath, self.file_last_text, temp_folder))
                            if (self.ac.signal.aborted) return
                        }

                        await write_meta_file()
                        if (self.ac.signal.aborted) return

                        if (await wait_on(is_read_only(fullpath)) !== self.file_read_only) {
                            if (self.ac.signal.aborted) return
                            self.last_touch = Date.now()
                            await wait_on(set_read_only(fullpath, self.file_read_only))
                        }
                        if (self.ac.signal.aborted) return

                        self.file_mtimeNs_str = '' + (await wait_on(require('fs').promises.stat(fullpath, { bigint: true }))).mtimeNs
                        if (self.ac.signal.aborted) return

                        for (var cb of self.file_written_cbs) cb()
                        self.file_written_cbs = []
                    }
                }
            })

            file_loop_pump_lock--
        }

        // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
        do_investigating_disconnects_log(url, 'after file_loop_pump')

        function start_sync() {
            // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
            do_investigating_disconnects_log(url, 'start_sync')

            var closed = false
            var ac = new AbortController()
            aborts.add(ac)

            self.disconnect = async () => {
                // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                do_investigating_disconnects_log(url, 'self.disconnect')

                if (closed) return
                closed = true
                reconnect_rate_limiter.on_diss(url)
                for (var a of aborts) a.abort()
                aborts.clear()
            }

            // Subscribe to local changes to trigger file writes
            braid_text.get(url, {
                signal: ac.signal,
                peer: self.peer,
                merge_type: 'dt',
                subscribe: () => {
                    if (self.ac.signal.aborted) return
                    self.signal_file_needs_writing()
                }
            })

            // Use braid_text.sync for bidirectional sync with the remote URL
            if (is_external_link) braid_text.sync(url, new URL(url), {

                // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                do_investigating_disconnects_log_L04LPFHQ1M: do_investigating_disconnects_log,

                fork_point_hint: old_meta_fork_point,
                signal: ac.signal,
                headers: {
                    'Content-Type': 'text/plain',
                    ...(x => x && { Cookie: x })(config.cookies?.[new URL(url).hostname])
                },
                on_pre_connect: () => {
                    // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                    do_investigating_disconnects_log(url, `sync.on_pre_connect`)

                    return reconnect_rate_limiter.get_turn(url)
                },
                on_res: res => {
                    // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                    do_investigating_disconnects_log(url, `sync.on_res status:${res?.status}`)
                    self.investigating_disconnects_thinks_connected = res?.status

                    if (self.ac.signal.aborted) return
                    reconnect_rate_limiter.on_conn(url)
                    self.file_read_only = res.headers.get('editable') === 'false'
                    console.log(`connected to ${url}${self.file_read_only ? ' (readonly)' : ''}`)
                },
                on_unauthorized: async () => {
                    // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                    do_investigating_disconnects_log(url, `sync.on_unauthorized`)

                    console.log(`access denied: reverting local edits`)
                    unsync_url(url)
                    //await sync_url.chain
                    sync_url(url)
                },
                on_disconnect: () => {
                    // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
                    do_investigating_disconnects_log(url, `sync.on_disconnect`)
                    self.investigating_disconnects_thinks_connected = false

                    return reconnect_rate_limiter.on_diss(url)
                }
            })
        }

        self.reconnect = () => {
            // DEBUGGING HACK ID: L04LPFHQ1M -- INVESTIGATING DISCONNECTS
            do_investigating_disconnects_log(url, `reconnect`)

            for (var a of aborts) a.abort()
            aborts.clear()
            start_sync()
        }

        start_sync()
        return self
    }
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

function ReconnectRateLimiter(wait_time) {
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

        while (self.qs.length && now >= my_last_turn() + wait_time) {
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
                my_last_turn() + wait_time - now))
    }

    self.get_turn = async (url) => {
        var host = new URL(url).host
        
        // If host has connections, give turn immediately
        if (self.conns.has(host)) return

        // console.log(`throttling reconn to ${url} (no conns yet to ${self.conns.size ? host : 'anything'})`)
        
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

// Undici-based fetch with HTTP/2 support for HTTPS,
// falls back to built-in fetch for HTTP (faster, no Agent overhead)
// Timeout defaults: connect.timeout=10s,
//                   headersTimeout=5min, bodyTimeout=5min,
//                   keepAliveTimeout=4s, keepAliveMaxTimeout=10min
async function fetch_http2(url, options = {}) {
    // Use built-in fetch for HTTP (faster, no need for HTTP/2)
    if (new URL(url).protocol !== 'https:')
        return fetch(url, options)

    if (!fetch_http2.undici) {
        fetch_http2.undici = require('undici')
        var makeAgent = (insecure) => new fetch_http2.undici.Agent({
            allowH2: true,
            connect: { rejectUnauthorized: !insecure },
        })
        fetch_http2.agent = makeAgent(false)
        fetch_http2.insecureAgent = makeAgent(true)
    }

    // Workaround: undici HTTP/2 can hang with empty body on some servers
    // See https://github.com/nodejs/undici/issues/2589
    var body = options.body
    if (body?.length === 0) body = undefined

    return fetch_http2.undici.fetch(url, {
        method: options.method || 'GET',
        headers: options.headers,
        body,
        signal: options.signal,
        dispatcher: options.rejectUnauthorized === false
            ? fetch_http2.insecureAgent
            : fetch_http2.agent,
    })
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
        
        // Check if chmod is actually needed
        if (read_only && (mode & 0o222) === 0) return
        if (!read_only && (mode & 0o200) !== 0) return
        
        // Perform chmod only if necessary
        if (read_only) mode &= ~0o222  // Remove all write permissions
        else mode |= 0o200   // Add owner write permission
        
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

async function atomic_write(final_destination, data, temp_folder) {
    var temp = `${temp_folder}/${Math.random().toString(36).slice(2)}`
    await require('fs').promises.writeFile(temp, data)
    var stat = await require('fs').promises.stat(temp, { bigint: true })
    await require('fs').promises.rename(temp, final_destination)
    return stat
}

function atomic_write_sync(final_destination, data, temp_folder) {
    var temp = `${temp_folder}/${Math.random().toString(36).slice(2)}`
    require('fs').writeFileSync(temp, data)
    require('fs').renameSync(temp, final_destination)
}

function is_well_formed_absolute_url(urlString) {
    if (!urlString || typeof urlString !== 'string') return
    if (urlString.match(/\s/)) return
    try {
        var url = new URL(urlString)
        if (url.hostname.includes('%')) return
        if (!url.hostname) return
        return urlString.match(/^https?:\/\//)
    } catch (error) {}
}
