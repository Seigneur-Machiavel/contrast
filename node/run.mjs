// THIS FILE IS USED TO START NODE STANDALONE (WITHOUT ELECTRON APP WRAPPER)
process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

import { NodeAppWorker } from './workers/workers-classes.mjs';

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const observerPort = args.includes('-op') ? parseInt(nextArg('-op')) : 27270;
const dashboardPort = args.includes('-dp') ? parseInt(nextArg('-dp')) : 27271;
//const nodeApp = args.includes('-na') ? nextArg('-na') : 'dashboard'; // dashboard, stresstest
const nodeApp = 'unified';
const privateKey = args.includes('-pk') ? nextArg('-pk') : null;
const password = args.includes('-pw') ? nextArg('-pw') : 'fingerPrint'; //fingerPrint.slice(0, 30)
const forceRelay = args.includes('-fr') ? true : false; // force p2p relay mode even if port verification fails

const dashboardWorker = new NodeAppWorker(nodeApp, nodePort, dashboardPort, observerPort, null, forceRelay);
const result = await dashboardWorker.setPasswordAndWaitResult(password); // (will try init node if password is correct)
console.log('passwordCorrect:', result.data);

await new Promise(resolve => setTimeout(resolve, 10000));
if (dashboardWorker.nodeStarted) while(true) await new Promise(resolve => setTimeout(resolve, 1000)); // keep node running

if (privateKey) {
    console.log('Starting node with private key from arg...');
    dashboardWorker.setPrivateKeyAndStartNode(privateKey);
    while(true) await new Promise(resolve => setTimeout(resolve, 1000)); // keep node running
}

//console.log('Failed to start node.');