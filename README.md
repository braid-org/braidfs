# BraidFS: Braid your Filesystem with the Web

Provides interoperability between **web pages** via http and your **OS filesystem**.
  - Using collaborative CRDTs and the Braid extensions for HTTP.

The `braidfs` daemon performs bi-directional synchronization between remote Braid-HTTP resources and your local filesystem.

### Web resources map onto your filesystem

It creates a `~/http` folder in your home directory to synchronize webpages with:

```
~/http/
  ├── example.com/
  │   ├── document.html
  │   ├── notes.md
  │   └── assets/
  │       └── style.css
  └── braid.org/
      └── meeting-53
```


https://github.com/user-attachments/assets/4fb36208-e0bd-471b-b47b-bbeee20e4f3f



### Two-way sync edits between files and web

As long as `braidfs` is running, it will keep the file and web resources in
sync!

 - Edit to the file → web resource
 - Edit to the web resource → file

> video of editing

Each edit to the file is diffed and sent as a CRDT patch, so you can edit
files offline, and even collaboratively edit them, with one caveat:

#### Caveat

For the period of time that you have edited the file in your editor but not
saved it, external edits cannot be integrated.

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

## Configuration

braidfs looks for a configuration file at `~/http/.braidfs/config`, or creates it if it doesn't exist. You can set the following options:

- `sync`: An object where the keys are URLs to sync, and the values are simply `true`
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
