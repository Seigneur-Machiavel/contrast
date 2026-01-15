import fs from 'fs';
import express from 'express';
import { CLOCK } from 'hive-p2p';
await CLOCK.sync(); // Start time synchronization

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2);
const hostname = args.includes('-nh') ? nextArg('-nh') : 'localhost';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const wsProtocol = args.includes('-wss') ? 'wss' : 'ws'; // pour forcer wss en prod

const app = express();
const PORT = process.env.PORT || 3000;
const boardMjs = fs.readFileSync('board/board.js', 'utf8');
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
        style-src 'self' 'unsafe-inline';
        connect-src 'self' ${wsProtocol}://${hostname}:${nodePort} https://time.cloudflare.com https://time.google.com https://pool.ntp.org;
    `.replace(/\s+/g, ' ').trim();
    
    res.setHeader('Content-Security-Policy', csp);
    next();
});
app.get('/api/time', (req, res) => res.json({ time: CLOCK.time }));
app.use('/', express.static('board'));
app.use('/libs', express.static('libs'));
app.use('/node', express.static('node'));
app.use('/types', express.static('types'));
app.use('/utils', express.static('utils'));
app.use('/miniLogger', express.static('miniLogger'));
app.get('/', (req, res) => res.sendFile('board.html', { root: 'board' }));
app.get('/hive-p2p.min.js', (req, res) => res.sendFile('./node_modules/hive-p2p/dist/browser/hive-p2p.min.js', { root: '.' }));

app.listen(PORT, () => console.log(`Board service is running at http://localhost:${PORT}`));