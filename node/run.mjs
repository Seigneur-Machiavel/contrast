// THIS FILE IS USED TO START NODE STANDALONE (WITHOUT ELECTRON APP WRAPPER)

import { NodeAppWorker } from './workers/workers-classes.mjs';

let dashboardPort = 27271; // network port 27271
let observerPort = 27270; // network port 27270
let nodePort = 27260; // network port 27260
let nodeApp = 'dashboard';

// start args
const args = process.argv.slice(2);
if (args.includes('-op')) {
    const portIndex = args.indexOf('-p') + 1;
    const port = parseInt(args[portIndex]);
    observerPort = port;
}
if (args.includes('-dp')) {
    const portIndex = args.indexOf('-dp') + 1;
    const port = parseInt(args[portIndex]);
    dashboardPort = port;
}
if (args.includes('-np')) {
    const portIndex = args.indexOf('-np') + 1;
    const port = parseInt(args[portIndex]);
    nodePort = port;
}
if (args.includes('-na')) {
    const appIndex = args.indexOf('-na') + 1;
    nodeApp = args[appIndex];
}

const dashboardWorker = new NodeAppWorker(nodeApp, nodePort, dashboardPort, observerPort);

process.on('uncaughtException', (error) => {
    console.error('Uncatched exception:', error.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise rejected:', promise, 'reason:', reason);
});