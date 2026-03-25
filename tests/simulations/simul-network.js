// @ts-check
//import { newWorker } from '../../node/workers/unified-worker-initializer.mjs';
import { newProcess } from "./process-spawner.js";
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain 			= args.includes('--local') ? 'localhost' : '0.0.0.0';
const bootstrapCount 	= parseInt(nextArg('-bootstraps')) || 0;
const clientCount 		= parseInt(nextArg('-clients'))  || 0;
const stakerCount  		= parseInt(nextArg('-stakers'))  || 0;
const spammerCount 		= parseInt(nextArg('-spammers')) || 0;
const nbReceipients 	= parseInt(nextArg('-nor')) || 4800;	// Number of receipient addresses in multi output transaction
const nbOfSenders 		= parseInt(nextArg('-nos')) || 800; 	// Number of single output transactions to send (should be higher than nbReceipients)
const totalClients 		= clientCount + stakerCount + spammerCount;

// MANUAL SETUP
const publicScript = './run-public.js';
const clientScript = './run-client.js';
const clearOnStart = false;	// RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!
const nodePort = 27260;
const bootstrapSeeds = [
	'0000000000000000000000000000000000000000000000000000000000000000',
]
const clientSeeds = [
	'0000000000000000000000000000000000000000000000000000000000000003',
	'0000000000000000000000000000000000000000000000000000000000000004',
	'0000000000000000000000000000000000000000000000000000000000000005',
	'0000000000000000000000000000000000000000000000000000000000000008',
	'0000000000000000000000000000000000000000000000000000000000000009',
]

if (totalClients > clientSeeds.length) throw new Error(`Not enough client seeds provided for ${totalClients} clients. Please add more seeds to the clientSeeds array.`);

// START PUBLIC WORKERS (BOOTSTRAP NODES)
for (let n = 0; n < bootstrapCount; n++)
	newProcess(publicScript, { seed: bootstrapSeeds[n], domain, nodePort, clearOnStart });

let i = 0; // START CLIENT WORKERS - DELAY OF 5-10s EACH TO SIMULATE MORE REALISTIC JOINING PATTERN, OTHERWISE THEY ALL TRY TO JOIN AT ONCE AND CAUSE A RUSH OF LOGS
for (let n = 0; n < clientCount; n++) // regular clients => start immediately to merge consensus.
	newProcess(clientScript, { seed: clientSeeds[i++], clearOnStart })

for (let n = 0; n < stakerCount;  n++) {
	await new Promise(resolve => setTimeout(resolve, 5_000 + Math.random() * 5_000));
	newProcess(clientScript, { seed: clientSeeds[i++], isStaker: true, clearOnStart })
}
for (let n = 0; n < spammerCount; n++) {
	await new Promise(resolve => setTimeout(resolve, 5_000 + Math.random() * 5_000));
	newProcess(clientScript, { seed: clientSeeds[i++], isSpammer: true, nbReceipients, nbOfSenders, clearOnStart })
}

console.log(`[SIMULATION] ${bootstrapCount} bootstraps, ${clientCount} clients, ${stakerCount} stakers, ${spammerCount} spammers`);