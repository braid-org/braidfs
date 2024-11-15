# braidfs

Sync Braid URLs as files on disk.

Like Dropbox (file sync), plus Google Docs (collaborative editing), all over HTTP.

## Installation

Install braidfs globally using npm:

```
npm install -g braidfs
```

## Usage

To start the braidfs server:

```
braidfs serve
```

To sync a URL:

```
braidfs sync <url>
```

When you run `braidfs sync <url>`, it creates a local file mirroring the content at that URL. The local file path is determined by the URL structure. For example:

- If you sync `https://example.com/path/file.txt`
- It creates a local file at `~/http/example.com/path/file.txt`

To unsync a URL:

```
braidfs unsync <url>
```

## Accessing the Server

The braidfs server runs on `http://localhost:10000` by default and provides the following endpoints:

- `/<url>`: Synchronizes the specified URL: creates a local file, and provides a Braid-HTTP interface
- `/.braidfs/config`: Displays the current configuration
- `/.braidfs/errors`: Shows the error log

Accessing a URL through the proxy (e.g., `http://localhost:10000/https://example.com/file.txt`) will automatically add it to the set of synced URLs, similar to using `braidfs sync <url>`.

## Configuration

braidfs looks for a configuration file at `~/http/.braidfs/config`. You can set the following options:

- `port`: The port number for the proxy server (default: 10000)
- `sync`: An object where the keys are URLs to sync, and the values are simply "true"
- `domains`: An object for setting domain-specific configurations, including authentication headers

Example `config.json`:

```json
{
  "port": 10000,
  "sync": {
    "https://example.com/document1.txt": true,
    "https://example.com/document2.txt": true
  },
  "domains": {
    "example.com": {
      "auth_headers": {
        "Cookie": "secret_pass"
      }
    }
  }
}
```

The `domains` configuration allows you to set authentication headers for specific domains. In the example above, any requests to `example.com` will include the specified `Cookie` header.

## Security

braidfs is designed to run locally and only accepts connections from localhost (127.0.0.1 or ::1) for security reasons. The `domains` configuration enables secure communication with servers that require authentication by allowing you to set domain-specific headers.
