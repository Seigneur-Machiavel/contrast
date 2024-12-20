import { parentPort } from 'worker_threads';
import utils from '../src/utils.mjs';
import { HashFunctions } from '../src/conCrypto.mjs';
import { BlockUtils } from '../src/block-classes.mjs';
import { Transaction_Builder } from '../src/transaction.mjs';

/**
 * @typedef {import("../src/block-classes.mjs").BlockData} BlockData
 */

/**
 * @param {BlockData} blockCandidate
 * @param {string} signatureHex
 * @param {string} nonce
 * @param {boolean} useDevArgon2
 */
async function mineBlock(blockCandidate, signatureHex, nonce, useDevArgon2) {
	try {
		//console.log('useDevArgon2', useDevArgon2);
		const argon2Fnc = useDevArgon2 ? HashFunctions.devArgon2 : HashFunctions.Argon2;
		const blockHash = await utils.mining.hashBlockSignature(argon2Fnc, signatureHex, nonce);
		if (!blockHash) { throw new Error('Invalid block hash'); }

		blockCandidate.hash = blockHash.hex;
		return { finalizedBlock: blockCandidate, bitsArrayAsString: blockHash.bitsArray.join('') };
	} catch (err) {
		throw err;
	}
}
async function mineBlockUntilValid() {
	while (true) {
		if (minerVars.blockCandidate === null) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
		if (minerVars.paused) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
		if (minerVars.timeOffset === 0) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
		await new Promise((resolve) => setTimeout(resolve, minerVars.testMiningSpeedPenality));

		try {
			const { signatureHex, nonce, clonedCandidate } = await prepareBlockCandidateBeforeMining();
			const mined = await mineBlock(clonedCandidate, signatureHex, nonce, false);
			if (!mined) { throw new Error('Invalid block hash'); }
	
			minerVars.hashCount++;
			if (minerVars.hashCount % minerVars.sendUpdateHashEvery === 0) {
				//console.log('hashCount', minerVars.hashCount);
				parentPort.postMessage({ hashCount: minerVars.hashCount });
				minerVars.hashCount = 0;
			}

			const { conform } = utils.mining.verifyBlockHashConformToDifficulty(mined.bitsArrayAsString, mined.finalizedBlock);
			if (!conform) { continue; }

			const now = Date.now() + minerVars.timeOffset;
			const blockReadyIn = Math.max(mined.finalizedBlock.timestamp - now, 0);
			
			await new Promise((resolve) => setTimeout(resolve, blockReadyIn));
			return mined.finalizedBlock;
		} catch (error) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { error: error.stack };
		}
	}
}
async function prepareBlockCandidateBeforeMining() {
	//let time = performance.now();
	/** @type {BlockData} */
	const blockCandidate = minerVars.blockCandidate;
	const clonedCandidate = BlockUtils.cloneBlockData(blockCandidate);
	//console.log(`prepareNextBlock: ${performance.now() - time}ms`); time = performance.now();

	const headerNonce = utils.mining.generateRandomNonce().Hex;
	const coinbaseNonce = utils.mining.generateRandomNonce().Hex;
	clonedCandidate.nonce = headerNonce;

	const now = Date.now() + minerVars.timeOffset;
	clonedCandidate.timestamp = Math.max(clonedCandidate.posTimestamp + 1 + minerVars.bet, now);
	//console.log(`generateRandomNonce: ${performance.now() - time}ms`); time = performance.now();

	const powReward = blockCandidate.powReward;
	delete clonedCandidate.powReward;
	const coinbaseTx = await Transaction_Builder.createCoinbase(coinbaseNonce, minerVars.rewardAddress, powReward);
	//console.log(`createCoinbase: ${performance.now() - time}ms`); time = performance.now();
	BlockUtils.setCoinbaseTransaction(clonedCandidate, coinbaseTx);
	//console.log(`setCoinbaseTransaction: ${performance.now() - time}ms`); time = performance.now();

	const signatureHex = await BlockUtils.getBlockSignature(clonedCandidate);
	const nonce = `${headerNonce}${coinbaseNonce}`;
	//console.log(`getBlockSignature: ${performance.now() - time}ms`); time = performance.now();

	return { signatureHex, nonce, clonedCandidate };
}

const minerVars = {
	working: false,

	rewardAddress: '',
	blockCandidate: null,
	highestBlockHeight: 0,
	bet: 0,
	timeOffset: 0,
	paused: false,

	sendUpdateHashEvery: 10,
	hashCount: 0,
	testMiningSpeedPenality: 0 // TODO: set to 0 after testing
};
parentPort.on('message', async (task) => {
	//console.log('miner-worker-nodejs', task);

	const response = {};
    switch (task.type) {
		case 'updateInfo':
			minerVars.rewardAddress = task.rewardAddress;
			minerVars.bet = task.bet;
			minerVars.timeOffset = task.timeOffset;

			console.info('miner-worker-nodejs -> updateInfo');
			return;
        case 'newCandidate':
			minerVars.highestBlockHeight = task.blockCandidate.index;
			minerVars.blockCandidate = task.blockCandidate;
			return;
		case 'mineUntilValid':
			if (minerVars.working) { return; } else { minerVars.working = true; }

			minerVars.rewardAddress = task.rewardAddress;
			minerVars.bet = task.bet;
			minerVars.timeOffset = task.timeOffset;
			const finalizedBlock = await mineBlockUntilValid();
			response.result = finalizedBlock;
			break;
		case 'pause':
			minerVars.paused = true;
			return;
		case 'resume':
			minerVars.paused = false;
			return;
		case 'terminate':
			console.log('terminating miner-worker-nodejs');
			parentPort.close(); // close the worker
			break;
        default:
			response.error = 'Invalid task type';
            break;
    }

	minerVars.working = false;
	parentPort.postMessage(response);
});
