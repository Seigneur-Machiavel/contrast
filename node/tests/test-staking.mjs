// TESTING STAKING TRANSACTIONS
// IN THIS TEST, WE CREATE A BOOTSTRAP NODE AND SEVERAL CLIENT NODES
// THEN ON EACH FINALIZED BLOCK, WE TRY TO CREATE AND PUSH A STAKING TRANSACTION FROM EACH NODE (IF THEY HAVE ENOUGH FUNDS TO DO SO).
// TO MADE THE CONDITION WORST, WE RUN ALL NODES ON THE SAME THREAD,
// SO THEY ARE ALL CONFLICTING FOR THE SAME RESOURCES (CPU, DISK, NETWORK), AND THEREFORE MORE LIKELY TO FAIL.

// @ts-check
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = args.includes('-local') ? 'localhost' : '0.0.0.0';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const clearOnStart = true;	// RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!

import { Wallet } from '../src/wallet.mjs';
import { createContrastNode } from '../src/node.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { Transaction_Builder } from "../src/transaction.mjs";

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { HIVE_P2P_CONFIG } from '../../utils/hive-p2p-config.mjs';
import { UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);
//HiveP2P.CONFIG.SIMULATION.USE_TEST_TRANSPORTS = true;

// BOOTSTRAP NODE
const bootstrapSeed = '0000000000000000000000000000000000000000000000000000000000000000';
const bootstrapStorage = new ContrastStorage(bootstrapSeed);
if (clearOnStart) bootstrapStorage.clear(); // start fresh
const bootstrapWallet = new Wallet(bootstrapSeed);
await bootstrapWallet.deriveAccounts(2, 'C', bootstrapStorage);

const bootstrapCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, bootstrapSeed);
// @ts-ignore
const bootstrapNode = await createContrastNode({ cryptoCodex: bootstrapCodex, storage: bootstrapStorage, domain, port: nodePort });
await bootstrapNode.start(bootstrapWallet);

const bootstraps = bootstrapNode.p2p.publicUrl ? [bootstrapNode.p2p.publicUrl] : [];
console.log('Bootstrap node public URL:', bootstraps);

// CLIENT NODES
const clientSeeds = [
	'0000000000000000000000000000000000000000000000000000000000000003',
	'0000000000000000000000000000000000000000000000000000000000000004',
	'0000000000000000000000000000000000000000000000000000000000000005',
	'0000000000000000000000000000000000000000000000000000000000000008',
	//'0000000000000000000000000000000000000000000000000000000000000009',
]
async function createClientNode(seed = 'toto') {
	const clientStorage = new ContrastStorage(seed);
	if (clearOnStart) clientStorage.clear(); // start fresh
	const clientWallet = new Wallet(seed);
	await clientWallet.deriveAccounts(2, 'C', clientStorage);

	const clientCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, seed);
	const clientNode = await createContrastNode({ cryptoCodex: clientCodex, storage: clientStorage, bootstraps, controllerPort: false });
	await clientNode.start(clientWallet);
	return clientNode;
}

/** @type {import("../src/node.mjs").ContrastNode[]} */
const clientNodes = [];
for (const seed of clientSeeds) clientNodes.push(await createClientNode(seed));

// -------------------------------------------------------------------------------------
// TESTS
// -------------------------------------------------------------------------------------
let height = -1;
/** @param {import("../src/blockchain.mjs").BlockFinalized} block */
const onBlockConfirmed = (block) => {
	if (block.index === height) return; // already processed
	height = block.index;
	console.log(`\n=== Block finalized #${block.index} (hash: ${block.hash.slice(0, 8)}...) ===`);
	// TEST: create staking transaction
	for (const node of clientNodes.concat([bootstrapNode])) {
		const { account } = node;
		if (!account) continue;
		
		const r = account.address;
		const ledger = node.blockchain.ledgersStorage.getAddressLedger(r);
		if (!ledger.ledgerUtxos) continue; // no UTXO

		//const sigUtxos = ledger.ledgerUtxos.filter(u => u.ruleCode === UTXO_RULES_GLOSSARY['sig'].code)
		account.setBalanceAndUTXOs(account.balance, ledger.ledgerUtxos);
		const sigUtxos = account.filteredUtxos(undefined, undefined, ['sig']);
		const availableAmount = sigUtxos.reduce((a, b) => a + b.amount, 0);
		if (availableAmount < 10_000_000 * 2) continue; // not enough to stake

		const { tx } = Transaction_Builder.createStakingVss(account, 1);
		const signedTx = account.signTransaction(tx);
		if (!signedTx) continue; // failed to create tx

		// TEST: push transaction
		console.log(`Pushing staking transaction spending: ${signedTx.inputs.join(', ')}`);
		const serialized = serializer.serialize.transaction(signedTx);
		console.log(`txBytes: ${serialized.length} | data.length: ${signedTx.data?.length || 0}`);
		node.p2p.broadcast(serialized, { topic: 'transaction' });
		console.log('Transaction broadcasted.');
	}
}
bootstrapNode.on('onBlockConfirmed', onBlockConfirmed);