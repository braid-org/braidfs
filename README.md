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

Each edit to the file is diffed and sent as a CRDT patch, so you can edit
files offline, and even collaboratively edit them, with one caveat:

#### Caveat

For the period of time that you have edited the file in your editor but not
saved it, external edits cannot be integrated.

#### Consistency Guarantees

- **Offline edits**: Changes made while offline are synchronized when connectivity returns
- **Daemon status**: Edits made while the daemon is stopped are detected and synchronized when it restarts
- **Race conditions**: If you save changes at the exact moment `braidfs` is writing to a file, the result depends on filesystem timing; the final state will become the new baseline. All saved changes outside this time will get properly detected and merged.

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

When started, `braidfs` looks for a configuration file at `~/http/.braidfs/config`, or creates it if it doesn't exist. You can set the following options:

- `sync`: An object where the keys are URLs to sync, and the values are simply `true`
- `cookies`: An object that maps domains to cookie values that will be sent with every HTTP request to that domain. For example, if you set `"example.com": "secret_pass"`, then all requests to example.com will include the header `Cookie: secret_pass`. This is useful for accessing protected resources that require authentication.
- `port`: The port number for the internal daemon (default: 45678)

Example `config`:

```json
{
  "sync": {
    "https://example.com/document1.txt": true,
    "https://example.com/document2.txt": true
  },
  "cookies": {
    "example.com": "secret_pass"
  },
  "port": 45678
}
```

### Live Configuration Updates

The configuration file can be edited and saved while the daemon is running. Changes are automatically detected and applied immediately without requiring a restart. The only exception is the `port` setting, which requires restarting the daemon to change.
