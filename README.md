# BraidFS: Braid your Filesystem with the Web

Synchronize ***WWW Pages*** with your ***OS Filesystem***.

The `braidfs` daemon performs bi-directional synchronization between remote
[Braided](https://braid.org) HTTP resources and your local filesystem.  It uses
the [braid-text](https://github.com/braid-org/braid-text) library for
high-performance, peer-to-peer collaborative text synchronization over HTTP,
and keeps your filesystem two-way synchronized with the fully-consistent CRDT.

### Sync the web into your `~/http` folder

Braidfs synchronizes webpages to a local `~/http` folder:

```
~/http/
  ├── braid.org/
  |   └── meeting-53
  └── example.com/
      ├── document.html
      ├── notes.md
      └── assets/
          └── style.css
```

Add a new page with the `braidfs sync <url>` command:

![](https://braid.org/files/braidfs-demo1.webp)

Unsync a page with `braidfs unsync <url>`.

### Edit remote state as a local file—and vice versa

Any synced page can be edited with your favorite local text editor—like
VSCode, Emacs, Vim, Sublime, TextWrangler, BBEdit, Pico, Nano, or Notepad—and
edits propagate live to the web, and vice-versa.

Here's a demo of VSCode editing [braid.org/braidfs](https://braid.org/braidfs):

<img src="https://braid.org/files/braidfs-demo2.webp" width="586">

After VSCode saves the file, braidfs immediately computes a diff of the edits
and sends them as patches over Braid HTTP to https://braid.org/braidfs:

```
PUT /braidfs
Version: "n0j5kg9g23-100"
Parents: "ercurwxmz7g-37"
Content-Length: 9
Content-Range: text [32:32]

 with the

```

Conversely, remote edits instantly update the local filesystem, and thus the
editor.

```
HTTP 200 OK
Version: "ercurwxmz7g-41"
Parents: "n0j5kg9g23-100"
Content-Length: 4
Content-Range: text [41:41]

 Web

```

Edits are formatted as simple
[Braid-HTTP](https://github.com/braid-org/braid-spec).  To participate in the
network, you can even author these messages by hand, from your own code, using
simple GETs and PUTs.

### Conflict-Free Collaborative Editing

Braidfs has a full [braid-text](https://github.com/braid-org/braid-text) peer
within it, providing high-performance collaborative text editing on the
diamond-types CRDT over the Braid HTTP protocol, guaranteeing conflict-free
editing with multiple editors, whether online or offline.

A novel trick using [Time Machines](https://braid.org/time-machines) lets us
making regular text editors conflict-free, as well, without speaking CRDT!
This means that you can edit a file in Emacs, even while other people edit the
same file, without write conflicts, and without adding CRDT code to Emacs.
(Still under development.)

# Installation and Usage

Install the `braidfs` command onto your computer with npm:

```
npm install -g braidfs
```

Then you can start the braidfs daemon with:

```
braidfs run
```

To run it automatically as a background service on MacOS, use:

```
 # Todo: fix this.  Not working yet.
 # launchctl submit -l org.braid.braidfs -- braidfs run
```

### Adding and removing URLs

Sync a URL with:

```
braidfs sync <url>
```

Unsync a URL with:

```
braidfs unsync <url>
```

URLs map to files with a simple pattern:

- url: `https://<domain>/<path>`
- file: `~/http/<domain>/<path>`


Examples:

| URL | File |
| --- | --- |
| `https://example.com/path/file.txt` | `~/http/example.com/path/file.txt` |
| `https://braid.org:8939/path` | `~/http/braid.org:8939/path` |
| `https://braid.org/` | `~/http/braid.org/index` |

If you sync a URL path to a directory containing items within it, the
directory will be named `/index`.


### Configuration

The config file lives at `~/http/.braidfs/config`.  It looks like this:

```json
{
  "sync": {
    "https://example.com/document1.txt": true,
    "https://example.com/document2.txt": true
  },
  "cookies": {
    "example.com": "secret_pass",
    "braid.org": "client=hsu238s88adhab3afhalkj3jasdhfdf"
  },
  "port": 45678
}
```

These are the options:
- `sync`: A set of URLs to synchronize.  Each one maps to `true`.
- `cookies`: Braidfs will use these cookie when connecting to the domains.
  - Put your login session cookies here.
  - To find your cookie for a website:
    - Log into the website with a browser
    - Open the Javascript console and run `document.cookie`
    - That's your cookie.  Copy paste it into  your config file.
- `port`: The port number for the internal daemon (default: 45678)

This config file live-updates, too.  Changes are automatically detected and
applied to the running braidfs daemon.  The only exception is the `port`
setting, which requires restarting the daemon after a change.


## Limitations & Future Work

- Doesn't sync binary yet.  Just text text mime-types:
  `text/*`, `application/html`, and `application/json`
  - Binary blob support would be pretty easy and nice to add.
  - Contact us if you'd like to add it!
- Doesn't update your editor's text with remote updates until you save
  - It's not hard to make it live-update, though, so that you can see your edits integrated with others' before you save.
  - Contact us if you'd like to help!  It would be a fun project!
