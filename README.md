# braidfs
braid technology synchronizing files and webpages

## Features

- Proxies web resources as collaborative text using the Braid protocol
- Caches proxied content locally
- Monitors local files for changes and syncs them back to the origin
- Supports pinning specific URLs

## Installation

Clone the repository:

```bash
git clone https://github.com/braid-org/braidfs.git
cd braidfs
```

Install dependencies:

```bash
npm install
```

## Usage

Run the server:

```bash
node index.js [PORT] [OPTIONS]
```

### Options

- `PORT`: The port number to run the server on (default: 10000)
- `-pin URL`: Pin a specific URL to be proxied
- `-pin index URL`: Pin an index URL that contains a list of URLs to be proxied
- `COOKIE`: Set a cookie to be used in requests (optional)

Example:

```bash
node index.js 60000 -pin https://example.com/resource -pin index https://example.com/index.json mycookie=value
```

This will run a server on port 60000, pin the specified URL, use the index URL to proxy multiple resources, and set a cookie for requests.

## Accessing the Proxy

The proxy only allows connections from localhost for security reasons.

- `/pages`: Shows all the proxied URLs
- `/URL`: Proxies the specified URL as Braid text and creates a file in `proxy_base/URL`

## File Structure

- `braid-text-db`: Stores local cached information
- `proxy_base`: Stores proxied files, which are updated when resources change and monitored for local changes

## Security Note

This proxy is designed to be accessible only from localhost. Attempting to access it from any other IP address will result in a 403 Forbidden error.

## Known Issues

- The server doesn't automatically resubscribe to proxied resources when restarted, though it will keep trying to re-establish broken connections while running.
