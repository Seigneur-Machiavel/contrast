// THIS FILE IS USED TO DEBUG THE FRONT BOARD IN A LOCAL ENVIRONMENT
// BY SERVING THE BOARD FILES WITH EXPRESS AND PATCHING THE BOOTSTRAP NODE URL

// --> NODES NEEDS TO BE RUNS SEPARATELY, NODE PUB_KEY CAN BE COPY FROM THE LOGS WHILE STARTING ONE
// FOR DEBUGGING THE FRONT BOARD WITHOUT HAVING TO BUILD THE EXTENSION OR ELECTRON EVERY TIME

import fs from 'fs';
import path from 'path';
import express from 'express';
import { CLOCK } from 'hive-p2p';
import { fileURLToPath } from 'url';
await CLOCK.sync(); // Start time synchronization

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2);
const hostname = args.includes('-nh') ? nextArg('-nh') : 'localhost';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const wsProtocol = args.includes('-wss') ? 'wss' : 'ws'; // force wss in prod (probably useless since we use sym encryption)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 27262;
const app = express();
const boardMjs = fs.readFileSync(path.join(__dirname, 'board/board.js'), 'utf8');
app.get('/board.mjs', (req, res) => { // PATCH board.mjs TO SET THE RIGHT BOOTSTRAP NODE URL
    const wsUrl = `${wsProtocol}://${hostname}:${nodePort}`;
    const patched = boardMjs.replace(
        /const bootstraps = \[.*?\];/,
        `const bootstraps = ['${wsUrl}'];`
    );
    res.type('application/javascript').send(patched);
});
app.use((req, res, next) => { // CSP Middleware
    const csp = `
        default-src 'self';
		img-src 'self' data:;
        style-src 'self' 'unsafe-inline';
        connect-src 'self' ${wsProtocol}://${hostname}:${nodePort} ws://127.0.0.1:27261 https://time.cloudflare.com https://time.google.com https://pool.ntp.org;
    `.replace(/\s+/g, ' ').trim();
    
    res.setHeader('Content-Security-Policy', csp);
    next();
});
app.get('/api/time', (req, res) => res.json({ time: CLOCK.time }));
app.use('/', express.static(path.join(__dirname, 'board')));
app.use('/libs', express.static(path.join(__dirname, 'libs')));
app.use('/node', express.static(path.join(__dirname, 'node')));
app.use('/types', express.static(path.join(__dirname, 'types')));
app.use('/utils', express.static(path.join(__dirname, 'utils')));
app.use('/miniLogger', express.static(path.join(__dirname, 'miniLogger')));
app.get('/', (req, res) => res.sendFile('board.html', { root: path.join(__dirname, 'board') }));
app.get('/hive-p2p.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/hive-p2p/dist/browser/hive-p2p.min.js')));

app.listen(PORT, () => console.log(`Board service is running at http://localhost:${PORT}`));