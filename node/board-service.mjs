// THIS FILE SERVES THE FRONT BOARD TO THE CONTRAST APP ONLY
// DATA IS ENCRYPTED VIA CHACHA — BROWSER ACCESS IS FORBIDDEN

import fs from 'fs';
import url from 'url';
import path from 'path';
import http from 'node:http';
import HiveP2P from "hive-p2p";
import { ContrastStorage } from '../storage/storage.mjs';
await HiveP2P.CLOCK.sync();

const filePath = url.fileURLToPath(import.meta.url);
let rootFolder = filePath; // loop until we find "contrast" folder
while (!rootFolder.endsWith('contrast'))
	if (rootFolder === path.dirname(rootFolder)) throw new Error('Could not find contrast root folder');
	else rootFolder = path.dirname(rootFolder);

console.log(`[BOARD SERVICE] Starting... - Root folder: ${rootFolder}`);

// LOAD BOOTSTRAP URLS FROM "contrast/bootstraps.json" IF EXISTS, OTHERWISE USE DEFAULT
const startupStorage = new ContrastStorage(); 	// ACCESS TO "contrast-storage".
const bootstraps = startupStorage.loadJSON('config/bootstraps', true) || ['ws://localhost:27260'];
const pkg = startupStorage.loadJSON('package', true);
const version = pkg.version // '0.6.12'
console.info(`[BOARD SERVICE] Version: ${version} - ${bootstraps.length} bootstraps`);

// HANDLE STARTUP ARGS
function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2);
const start = args.includes('--start') || args.includes('-s');
const hostPubkey = args.includes('-hpk') ? nextArg('-hpk') : undefined;

const SERVICE_PORT = 27262;
const CSP_BASE = `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval';`;
const CSP_CONNECT = [
    `connect-src 'self'`,
    `https://time.cloudflare.com`,
    `https://time.google.com`,
    `https://pool.ntp.org`,
    // `ws://127.0.0.1:27261`, Will be pushed by startBoardService()
	...bootstraps
];

const MIME = {
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.html': 'text/html', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Static roots mapped to URL prefixes
const STATIC = [
    { prefix: '/external-libs/',	dir: path.join(rootFolder, 'external-libs') },
    { prefix: '/node/',       		dir: path.join(rootFolder, 'node') },
	{ prefix: '/config/',     		dir: path.join(rootFolder, 'config') },
    { prefix: '/types/',      		dir: path.join(rootFolder, 'types') },
    { prefix: '/utils/',      		dir: path.join(rootFolder, 'utils') },
    { prefix: '/miniLogger/', 		dir: path.join(rootFolder, 'miniLogger') },
    { prefix: '/',            		dir: path.join(rootFolder, 'board') }, // catch-all last
];

/** @param {http.ServerResponse} res @param {number} code */
function send404(res, code = 404) { res.writeHead(code).end(); }

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} CSP */
function serveStatic(req, res, CSP) {
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

const boardMjs = fs.readFileSync(path.join(rootFolder, 'board/board.js'), 'utf8');

/** @param {string} [safeConnexionToken] @param {string} [hostPubkeyStr] The NodeController server pubKey @param {number} [controllerPort] */
export function startBoardService(safeConnexionToken = null, hostPubkeyStr = null, controllerPort = 27261) {
	// APPEND CONTROLLER_PORT TO CSP ----------------------------
	CSP_CONNECT.push(`ws://127.0.0.1:${controllerPort}`);
	const CSP = `${CSP_BASE} ${CSP_CONNECT.join(' ')};`;
	
	// START HTTP SERVER ----------------------------------------
	const hpkStr = hostPubkeyStr || hostPubkey || null;
	http.createServer((req, res) => {
		const url = (req.url ?? '/').split('?')[0]; // http://localhost:27262?token=abc123
		const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
		const token = searchParams.get('token');
		const isSafeSource = token && safeConnexionToken && token === safeConnexionToken;

		if (url === '/' || url === '/index.html') {
			if (isSafeSource) console.log('[BOARD SERVICE] SERVING INDEX.HTML TO SAFE SOURCE');
			else console.warn('[BOARD SERVICE] SERVING INDEX.HTML TO UNSAFE SOURCE');

			let html = fs.readFileSync(path.join(rootFolder, 'board/board.html'), 'utf8');
    		if (isSafeSource) html = html.replace('src="board.js"', `src="/board.js?token=${token}"`);
			res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP });
			return res.end(html);
		}
		
		// Patch board.js bootstrap URL on the fly
		if (url === '/board.js') {
			let patched = boardMjs.replace(/const bootstraps = \[.*?\];/, `const bootstraps = ${JSON.stringify(bootstraps)};`);
			patched = patched.replace(/const version = '.*?';/, `const version = '${version}';`);
			if (hpkStr && isSafeSource)
				patched = patched.replace(/const hostPubkeyStr = null;/, `const hostPubkeyStr = '${hpkStr}';`);
			res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Security-Policy': CSP });
			return res.end(patched);
		}

		if (url === '/dashboard/dashboard.js') {
			console.log('REQUESTING DASHBOARD.JS');
			// replacee "PORT: 27261," by actual controllerPort in dashboard.js on the fly
			let dashboardPath = path.join(rootFolder, 'board/dashboard/dashboard.js');
			let dashboardJs = fs.readFileSync(dashboardPath, 'utf8');
			dashboardJs = dashboardJs.replace(/PORT:\s*\d{4,5}/, `PORT: ${controllerPort}`);
			res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Security-Policy': CSP });
			return res.end(dashboardJs);
		}

		if (url === '/api/time') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ time: HiveP2P.CLOCK.time }));
		}

		if (url === '/hive-p2p.min.js') {
			const filePath = path.join(rootFolder, 'node_modules/hive-p2p/dist/browser/hive-p2p.min.js');
			res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Security-Policy': CSP });
			return fs.createReadStream(filePath).pipe(res);
		}

		if (url === '/qsafe-sig.browser.min.js') {
			const filePath = path.join(rootFolder, 'node_modules/@pinkparrot/qsafe-sig/dist/qsafe-sig.browser.min.js');
			res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Security-Policy': CSP });
			return fs.createReadStream(filePath).pipe(res);
		}

		serveStatic(req, res, CSP);
	}).listen(SERVICE_PORT, () => console.log(`Board service running at http://localhost:${SERVICE_PORT}`));
}

if (start) startBoardService();