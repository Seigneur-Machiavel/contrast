// THIS FILE IS USED TO START NODE STANDALONE (WITHOUT ELECTRON APP WRAPPER)

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }

const args = process.argv.slice(2); // digest the start args
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const observerPort = args.includes('-op') ? parseInt(nextArg('-op')) : 27270;
const dashboardPort = args.includes('-dp') ? parseInt(nextArg('-dp')) : 27271;

import HiveP2P from "hive-p2p";
import { createContrastNode } from './src/node.mjs';
//import { Wallet } from './src/wallet.mjs';

//const wallet = new Wallet();
//await wallet.loadAccounts();

console.log('Creating bootstrap node...');
const bootstrapSeed = '0000000000000000000000000000000000000000000000000000000000000000';
const bootstrapCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, bootstrapSeed);
const bootstrapNode = await createContrastNode({ cryptoCodex: bootstrapCodex, domain: 'localhost', port: nodePort });
bootstrapNode.p2pNode.onPeerConnect(() => console.log('Peer connected to bootstrap node'));
bootstrapNode.start();

// -------------------------------------------------------------------------------------
const bootstraps = [bootstrapNode.p2pNode.publicUrl];
console.log(`Bootstrap node url: ${bootstrapNode.p2pNode.publicUrl}`);
// -------------------------------------------------------------------------------------

const clientSeed = '0000000000000000000000000000000000000000000000000000000000000003';
const clientCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, clientSeed);
const clientNode = await createContrastNode({ cryptoCodex: clientCodex, bootstraps });