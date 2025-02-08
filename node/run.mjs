// THIS FILE IS USED TO START NODE STANDALONE (WITHOUT ELECTRON APP WRAPPER)
import { NodeAppWorker } from './workers/workers-classes.mjs';
function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }

const args = process.argv.slice(2); // digest the start args
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const observerPort = args.includes('-op') ? parseInt(nextArg('-op')) : 27270;
const dashboardPort = args.includes('-dp') ? parseInt(nextArg('-dp')) : 27271;
const nodeApp = args.includes('-na') ? nextArg('-na') : 'dashboard'; // dashboard, stresstest
const privateKey = args.includes('-pk') ? nextArg('-pk') : null;

const dashboardWorker = new NodeAppWorker(nodeApp, nodePort, dashboardPort, observerPort);
if (privateKey) { await new Promise(resolve => setTimeout(resolve, 5000)); dashboardWorker.generatePrivateKeyAndStartNode(privateKey); }

process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });