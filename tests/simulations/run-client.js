// @ts-check
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const workerData 	= JSON.parse(process.env.NODE_WORKER_DATA || '{}');
const seed      	= workerData.seed;
const isStaker  	= workerData.isStaker || false;
const isSpammer 	= workerData.isSpammer || false;
const nbReceipients = workerData.nbReceipients || 0; // Number of recipient addresses in multi output transaction
const nbOfSenders 	= workerData.nbOfSenders || 0; // Number of single output transactions to send (should be higher than nbReceipients)
const clearOnStart 	= workerData.clearOnStart; // RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!
const bootstraps = ['ws://localhost:27260']; // bootstrap node URL(s) to connect to

if (isStaker && isSpammer) throw new Error('A client cannot be both a staker and a spammer');
if (!seed) throw new Error('Please provide a seed with -seed <seed>');

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { Wallet } from '../../node/src/wallet.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { createContrastNode } from '../../node/src/node.mjs';
import { HIVE_P2P_CONFIG } from '../../config/hive-p2p-config.mjs';
import { TestTransactionCreator } from "../../tests/test-transactions-creator.js";
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

const clientStorage = new ContrastStorage(seed);
if (clearOnStart) clientStorage.clear(); // start fresh

const clientWallet = await Wallet.initializedWallet(clientStorage, undefined, seed);
const clientCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, seed);
const clientNode = await createContrastNode({
	cryptoCodex: clientCodex,
	storage: clientStorage,
	controllerPort: false,
	bootstraps
});
await clientNode.start(clientWallet);

// STAKER / SPAMMER BEHAVIOR
const testTxsCreator = await TestTransactionCreator.newInstance(clientNode, undefined, nbOfSenders, nbReceipients);
let spamHeight = -1;
let stakeHeight = -1;

/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const onBlockConfirmed = async (block) => {
	if (!testTxsCreator.mainAccountsReady()) return; // nodeWallet not ready yet!
    if (block.index === spamHeight) return;
	
	testTxsCreator.clearPreparedTxs();
	testTxsCreator.updateAccountBalanceAndLedger(undefined, false); // update solver account

	//TEST: SPAM TXS
	if (isSpammer && block.index !== spamHeight) {
		spamHeight = block.index; // flag to not do the operation at the same height

		// TEST: CREATE MISSING IDENTITIES
		await testTxsCreator.createMissingIdentitiesTransactions(false);
		
		// TEST: CREATE TRANSACTIONS WITH MULTI OUTPUTS (ONLY ON ODD BLOCKS)
		if (testTxsCreator.txs.length === 0 && block.index % 2 === 1)
			await testTxsCreator.createMultiOutputsTransactions(false);
	
		// TEST: CREATE SINGLE OUTPUT TRANSACTIONS (ONLY ON EVEN BLOCKS)
		if (testTxsCreator.txs.length === 0 && block.index % 2 === 0)
			await testTxsCreator.createSingleOutputTransactions();
	}

	// TEST: STAKE
	if (isStaker && block.index !== stakeHeight) {
		stakeHeight = block.index; // flag to not do the operation at the same height
		await testTxsCreator.createStakingTransaction();
	}

	// TEST: SEND ALL TXS
	await testTxsCreator.sendAllPreparedTxs(false);
}

clientNode.on('onBlockConfirmed', onBlockConfirmed);