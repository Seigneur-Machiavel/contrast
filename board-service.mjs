// THIS FILE SERVES THE FRONT BOARD TO THE CONTRAST APP ONLY
// DATA IS ENCRYPTED VIA CHACHA — BROWSER ACCESS IS FORBIDDEN

import fs from 'fs';
import path from 'path';
import http from 'node:http';
import HiveP2P from "hive-p2p";
import { fileURLToPath } from 'url';
import { ContrastStorage } from './storage/storage.mjs';
await HiveP2P.CLOCK.sync();

// LOAD BOOTSTRAP URLS FROM "contrast/bootstraps.json" IF EXISTS, OTHERWISE USE DEFAULT
const startupStorage = new ContrastStorage(); 	// ACCESS TO "contrast-storage".
const bootstraps = startupStorage.loadJSON('bootstraps', true) || ['ws://localhost:27260'];
const pkg = startupStorage.loadJSON('package', true);
const version = pkg.version // '0.6.12'
console.info(`[BOARD SERVICE] Version: ${version} - ${bootstraps.length} bootstraps`);

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2);
const start = args.includes('--start') || args.includes('-s');
const hostname = args.includes('-nh') ? nextArg('-nh') : 'localhost';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const wsProtocol = args.includes('-wss') ? 'wss' : 'ws';
const hostPubkey = args.includes('-hpk') ? nextArg('-hpk') : undefined;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 27262;

const CSP_BASE = `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';`;
const CSP_CONNECT = [
    `connect-src 'self'`,
    `https://time.cloudflare.com`,
    `https://time.google.com`,
    `https://pool.ntp.org`,
    `ws://127.0.0.1:27261`,
	...bootstraps
].join(' ');
const CSP = `${CSP_BASE} ${CSP_CONNECT};`;

const MIME = {
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.html': 'text/html', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Static roots mapped to URL prefixes
const STATIC = [
    { prefix: '/libs/',       dir: path.join(__dirname, 'libs') },
    { prefix: '/node/',       dir: path.join(__dirname, 'node') },
    { prefix: '/types/',      dir: path.join(__dirname, 'types') },
    { prefix: '/utils/',      dir: path.join(__dirname, 'utils') },
    { prefix: '/miniLogger/', dir: path.join(__dirname, 'miniLogger') },
    { prefix: '/',            dir: path.join(__dirname, 'board') }, // catch-all last
];

//const CSP = `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ${wsProtocol}://${hostname}:${nodePort} ws://127.0.0.1:27261 https://time.cloudflare.com https://time.google.com https://pool.ntp.org;`;

/** @param {http.ServerResponse} res @param {number} code */
function send404(res, code = 404) { res.writeHead(code).end(); }

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
function serveStatic(req, res) {
    for (const { prefix, dir } of STATIC) {
		if (req.method !== 'GET') return send404(res);
		
        if (!req.url?.startsWith(prefix)) continue;
        const rel = req.url.slice(prefix.length) || 'index.html';
        // Prevent path traversal attacks
		const filePath = path.resolve(dir, rel);
		if (!filePath.startsWith(path.resolve(dir))) return send404(res, 403);
        if (!filePath.startsWith(dir)) return send404(res, 403);
        if (!fs.existsSync(filePath)) continue; // try next root
        const mime = MIME[path.extname(filePath)] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Security-Policy': CSP });
        fs.createReadStream(filePath).pipe(res);
        return;
    }
    send404(res);
}

const boardMjs = fs.readFileSync(path.join(__dirname, 'board/board.js'), 'utf8');

/** @param {string} [safeConnexionToken] @param {string} [hostPubkeyStr] */
export function startBoardService(safeConnexionToken = null, hostPubkeyStr = null) {
	const hpkStr = hostPubkeyStr || hostPubkey || null;
	http.createServer((req, res) => {
		const url = (req.url ?? '/').split('?')[0]; // http://localhost:27262?token=abc123
		const { searchParams } = new URL(req.url, 'http://localhost');
		const token = searchParams.get('token');
		const isSafeSource = token && safeConnexionToken && token === safeConnexionToken;

		// Patch board.js bootstrap URL on the fly
		if (url === '/board.js') {
			let patched = boardMjs.replace(/const bootstraps = \[.*?\];/, `const bootstraps = ${JSON.stringify(bootstraps)};`);
			patched = patched.replace(/const version = '.*?';/, `const version = '${version}';`);
			if (hpkStr && isSafeSource)
				patched = patched.replace(/const hostPubkeyStr = null;/, `const hostPubkeyStr = '${hpkStr}';`);
			res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Security-Policy': CSP });
			return res.end(patched);
		}

		if (url === '/api/time') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ time: HiveP2P.CLOCK.time }));
		}

		if (url === '/hive-p2p.min.js') {
			const filePath = path.join(__dirname, 'node_modules/hive-p2p/dist/browser/hive-p2p.min.js');
			res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Security-Policy': CSP });
			return fs.createReadStream(filePath).pipe(res);
		}

		if (url === '/' || url === '/index.html') {
			res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP });
			return fs.createReadStream(path.join(__dirname, 'board/board.html')).pipe(res);
		}

		serveStatic(req, res);
	}).listen(PORT, () => console.log(`Board service running at http://localhost:${PORT}`));
}

if (start) startBoardService();