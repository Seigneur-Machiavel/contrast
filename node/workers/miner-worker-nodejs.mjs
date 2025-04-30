import { parentPort } from 'worker_threads';
import { mining } from '../../utils/mining-functions.mjs';
import { HashFunctions } from '../src/conCrypto.mjs';
import { BlockUtils } from '../src/block-classes.mjs';
import { Transaction_Builder } from '../src/transaction.mjs';

/**
 * @typedef {import("../src/block-classes.mjs").BlockData} BlockData
 */

/** @param {BlockData} blockCandidate @param {string} signatureHex @param {string} nonce @param {boolean} useDevArgon2 */
async function mineBlock(blockCandidate, signatureHex, nonce, useDevArgon2) {
	try {
		//console.log('useDevArgon2', useDevArgon2);
		const argon2Fnc = useDevArgon2 ? HashFunctions.devArgon2 : HashFunctions.Argon2;

		const blockHash = await mining.hashBlockSignature(argon2Fnc, signatureHex, nonce);
		if (!blockHash) throw new Error('Invalid block hash');

		blockCandidate.hash = blockHash.hex;
		return { finalizedBlock: blockCandidate, bitsArrayAsString: blockHash.bitsArray.join('') };
	} catch (err) { throw err; }
}
class hashrateCalculator {
	constructor(parentPort) {
		this.parentPort = parentPort;
		this.periodStart = Date.now();
	
		this.hashCount = 0;
		this.hashTimes = [];
		this.calculateAndSendEvery = 10; // in hashes
	}
	newHash(hashTime) {
		this.hashCount++;
		//this.hashTimes.push(hashTime); // dev
		//this.#logHashTimeIfNecessary(); // dev
		this.#sendHashRateIfNecessary();
	}
	#sendHashRateIfNecessary() {
		if (this.hashCount === 0) { return; }
		if (this.hashCount % this.calculateAndSendEvery !== 0) { return; }

		const hashRate = this.hashCount / ((Date.now() - this.periodStart) / 1000);
		this.parentPort.postMessage({ hashRate });
		//console.log(`Hash rate: ${hashRate.toFixed(2)} H/s - ${this.hashCount}/${(Date.now() - this.periodStart).toFixed(2)}ms`);
		
		// for faster updates we reset the counter and time
		this.hashCount = 0;
		this.periodStart = Date.now();
	}
	#logHashTimeIfNecessary() { // dev
		if (this.hashCount === 0) { return; }
		if (this.hashCount % this.calculateAndSendEvery !== 0) { return; }

		const avgTime = this.hashTimes.reduce((a, b) => a + b, 0) / this.hashTimes.length;
		console.log('Average hash time:', avgTime.toFixed(2), 'ms');
		this.hashTimes = [];
	}
}
async function mineBlockUntilValid() {
	const hashRateCalculator = new hashrateCalculator(parentPort);
	while (true) {
		if (minerVars.exiting) { return { error: 'Exiting' }; }
		if (minerVars.paused) { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }

		// IF PAUSED MORE THAN A MINUTE AGO, WE NEED TO WAIT AN UPDATE OF BLOCK CANDIDATE
		// ON NEW CANDIDATE, PAUSE TIME IS RESET
		while (minerVars.pausedAtTime && minerVars.pausedAtTime > Date.now() - 60000)
			await new Promise((resolve) => setTimeout(resolve, 100));

		if (minerVars.blockCandidate === null) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
		if (minerVars.timeOffset === 0) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
		if (minerVars.testMiningSpeedPenality) await new Promise((resolve) => setTimeout(resolve, minerVars.testMiningSpeedPenality));

		try {
			const startTime = performance.now();
			const { signatureHex, nonce, clonedCandidate } = await prepareBlockCandidateBeforeMining();
			const mined = await mineBlock(clonedCandidate, signatureHex, nonce, false);
			if (!mined) throw new Error('Invalid block hash');
	
			minerVars.hashCount++;
			hashRateCalculator.newHash(performance.now() - startTime);
			//console.log('hashTime', Math.round(performance.now() - startTime), 'ms');
			
			const { conform } = mining.verifyBlockHashConformToDifficulty(mined.bitsArrayAsString, mined.finalizedBlock);
			if (!conform) continue;

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

	const headerNonce = mining.generateRandomNonce().Hex;
	const coinbaseNonce = mining.generateRandomNonce().Hex;
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
	exiting: false,
	working: false,

	rewardAddress: '',
	blockCandidate: null,
	highestBlockHeight: 0,
	bet: 0,
	timeOffset: 0,
	paused: false,
	pausedAtTime: 0,

	testMiningSpeedPenality: 0, // TODO: set to 0 after testing
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
			minerVars.pausedAtTime = null;
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
			minerVars.pausedAtTime = Date.now();
			parentPort.postMessage({ paused: true });
			return;
		case 'resume':
			minerVars.paused = false;
			parentPort.postMessage({ paused: false });
			return;
		case 'terminate':
			//console.info('[miner-worker-nodejs] Terminating...');
			minerVars.exiting = true;
			parentPort.close(); // close the worker
			break;
        default:
			response.error = 'Invalid task type';
            break;
    }

	if (minerVars.exiting) { return; }
	minerVars.working = false;
	parentPort.postMessage(response);
});