// @ts-check
function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const controllerPort = args.includes('-cp') ? parseInt(nextArg('-cp')) : 27261;
const chachaSeedHex = args.includes('-cs') ? nextArg('-cs') : '31ba0b522136530dd340d856d7eaa7ab4f5c53f763ff0696ff1fa9fcea464281';
// console.log(`[run-client] chachaSeedHex: ${chachaSeedHex}`);

import { Wallet } from './src/wallet.mjs';
import { createContrastNode } from './src/node.mjs';
import { serializer } from '../utils/serializer.mjs';
import { ContrastStorage } from '../storage/storage.mjs';
import { Transaction_Builder } from "./src/transaction.mjs";

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { HIVE_P2P_CONFIG } from '../utils/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

const startupStorage = new ContrastStorage(); 	// ACCESS TO "contrast-storage".
const seed = startupStorage.loadBinary('seed') || await HiveP2P.CryptoCodex.generateNewSybilIdentity(false);

// LOAD BOOTSTRAP URLS FROM "contrast/bootstraps.json" IF EXISTS, OTHERWISE USE DEFAULT
const bootstraps = startupStorage.loadJSON('bootstraps', true) || ['ws://localhost:27260'];
const seedHex = serializer.converter.bytesToHex(seed);
const storage = new ContrastStorage(seedHex);	// ACCESS TO 'contrast-storage/{localIdentifier}'.
const wallet = new Wallet(seedHex);
await wallet.deriveAccounts(2, 'C', storage);

const cryptoCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, seed);
const clientNode = await createContrastNode({ cryptoCodex, storage, bootstraps, chachaSeedHex, controllerPort });
await clientNode.start(wallet);

// PERSIST THE SEED FOR NEXT STARTUPS IF NODE IS ABLE TO START SUCCESSFULLY
startupStorage.saveBinary('seed', seed);