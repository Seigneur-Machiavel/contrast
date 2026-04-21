// @ts-check
function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const enableBoardService = args.includes('--board-service');
const controllerPort = args.includes('-cp') ? parseInt(nextArg('-cp')) : 27261;
const serverChachaSeedHex = args.includes('-scs') ? nextArg('-scs') : undefined; // chachaSeed to use instead of gnerating a new on in NodeController. Useful while starting client on different process or worker.
const unsafeServePubKey = args.includes('--unsafe-serve-pubkey'); // WARNING: ENABLING THIS CAN EXPOSE THE NODE TO MITM ATTACKS - ONLY USE IN SAFE ENVIRONMENTS!

import { Wallet } from './src/wallet.mjs';
import { createContrastNode } from './src/node.mjs';
import { serializer } from '../utils/serializer.mjs';
import { ContrastStorage } from '../storage/storage.mjs';

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { HIVE_P2P_CONFIG } from '../config/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

const startupStorage = new ContrastStorage(); 	// ACCESS TO "contrast-storage".
const walletSeed = startupStorage.loadBinary('seed') || Wallet.generateRandomMasterHex().bytes; // GENERATE A RANDOM SEED IF NOT EXISTING FOR NEXT STEPS (NODE CREATION, STORAGE PATHS, ETC...).
const walletSeedHex = serializer.converter.bytesToHex(walletSeed);
const storage = new ContrastStorage(walletSeedHex); // ACCESS TO 'contrast-storage/{localIdentifier}'.
const wallet = new Wallet(walletSeedHex);
await wallet.deriveAccounts(2, 'C', undefined, undefined, storage);

// LOAD BOOTSTRAP URLS FROM "contrast/bootstraps.json" IF EXISTS, OTHERWISE USE DEFAULT
const bootstraps = startupStorage.loadJSON('config/bootstraps', true) || ['ws://localhost:27260'];
const codexSeed = await HiveP2P.CryptoCodex.generateNewSybilIdentity(false);
const cryptoCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, codexSeed);
const clientNode = await createContrastNode({
	cryptoCodex,
	storage,
	bootstraps,
	controllerPort,
	serverChachaSeedHex,
	unsafeServePubKey
});
await clientNode.start(wallet);

// PERSIST THE SEED FOR NEXT STARTUPS IF NODE IS ABLE TO START SUCCESSFULLY
startupStorage.saveBinary('seed', walletSeed);

// LOG THE CONTROLLER PUBKEY IF NECESSARY
if (!unsafeServePubKey && !serverChachaSeedHex && clientNode.controller)
	console.log(`[CONTROLLER PUBKEY: ${serializer.converter.bytesToHex(clientNode.controller?.myKeypair.myPub)}`);

// START THE BOARD SERVICE IF THE FLAG IS ENABLED
if (enableBoardService) {
	const { startBoardService } = await import('./board-service.mjs');
	startBoardService(undefined, undefined, controllerPort);
}