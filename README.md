# braidfs

Sync Braid URLs and website as files on disk.

Like Dropbox (file sync), plus Google Docs (collaborative editing), all over
HTTP.

## Installation

Install braidfs globally using npm:

```
npm install -g braidfs
```

## Usage

To start braidfs, run the following command:

```
braidfs [port] [-pin <url>] [-pin index <url>]
```

- `[port]`: Optional. Specify the port number (default is 10000).
- `-pin <url>`: Pin a specific URL for synchronization.
- `-pin index <url>`: Pin an index URL that contains a list of URLs to synchronize.

Example:

```
braidfs 8080 -pin https://example.com/document.txt -pin index https://example.com/index.json
```

## Configuration

braidfs looks for a configuration file at `~/.braidfs/config.json`. You can set the following options:

- `port`: The port number for the proxy server.
- `pin_urls`: An array of URLs to pin for synchronization.
- `pindex_urls`: An array of index URLs containing lists of URLs to synchronize.
- `proxy_base`: The base directory for storing proxied files (default is `~/http`).

Example `config.json`:

```json
{
  "port": 9000,
  "pin_urls": ["https://example.com/document1.txt", "https://example.com/document2.txt"],
  "pindex_urls": ["https://example.com/index.json"],
  "proxy_base": "/path/to/custom/proxy/directory"
}
```

## Accessing the Proxy

The proxy only allows connections from localhost for security reasons.

- `/pages`: Shows all the proxied URLs
- `/URL`: Proxies the specified URL and creates a file in `proxy_base/URL`

## Security

braidfs is designed to run locally and only accepts connections from localhost (127.0.0.1 or ::1) for security reasons.
