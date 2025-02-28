# braidfs

Sync Braid URLs as files on disk.

Like Dropbox (file sync), plus Google Docs (collaborative editing), all over HTTP.

## How It Works

braidfs uses Braid HTTP — a proposed protocol extension to HTTP that enables real-time synchronization. To learn more about Braid HTTP, visit [https://braid.org](https://braid.org).

braidfs creates a bi-directional sync between remote Braid HTTP resources and your local filesystem. When you run the braidfs daemon, it maintains a directory at `~/http` that mirrors resources from various web servers. The content in `~/http` is organized by domain. For example:
```
~/http/
  ├── .braidfs/
  │   └── config
  ├── example.com/
  │   ├── document.txt
  │   └── references/
  │       └── other.txt
  └── localhost:12345/
      └── notes.md
```

The magic happens through bi-directional synchronization:

- When you edit a file locally (e.g., `~/http/example.com/document.txt`), braidfs automatically sends the changes to the corresponding Braid URL (`https://example.com/document.txt`).
- When the remote resource changes, the Braid HTTP protocol notifies braidfs, and your local file is updated to match.

This creates a seamless experience where you can use standard text editors and file tools with web resources.

This video demonstrates syncing and unsyncing some resources from the command line, and seeing the files appear and disappear in the file system:


https://github.com/user-attachments/assets/4fb36208-e0bd-471b-b47b-bbeee20e4f3f



## Installation

Install braidfs globally using npm:

```
npm install -g braidfs
```

## Usage

To start the braidfs daemon:

```
braidfs run
```

To sync a Braid URL:

```
braidfs sync <url>
```

When you run `braidfs sync <url>`, it creates a local file mirroring the content at that Braid URL. The local file path is determined by the URL structure. For example:

- If you sync `https://example.com/path/file.txt`
- It creates a local file at `~/http/example.com/path/file.txt`

To unsync a URL:

```
braidfs unsync <url>
```

## Configuration

braidfs looks for a configuration file at `~/http/.braidfs/config`, or creates it if it doesn't exist. You can set the following options:

- `sync`: An object where the keys are Braid URLs to sync, and the values are simply `true`
- `domains`: An object for setting domain-specific configurations, including authentication headers
- `port`: The port number for the internal daemon (default: 45678)

Example `config`:

```json
{
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
  },
  "port": 45678
}
```

The `domains` configuration allows you to set authentication headers for specific domains. In the example above, any requests to `example.com` will include the specified `Cookie` header.

## Security

braidfs is designed to run locally and only accepts connections from localhost (127.0.0.1 or ::1) for security reasons. The `domains` configuration enables secure communication with servers that require authentication by allowing you to set domain-specific headers.
