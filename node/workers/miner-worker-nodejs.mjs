// @ts-check
import { parentPort } from 'worker_threads';
import { BlockUtils } from '../src/block.mjs';
import { HashFunctions } from '../src/conCrypto.mjs';
import { mining } from '../../utils/conditionals.mjs';
import { Transaction_Builder } from '../src/transaction.mjs';
if (parentPort === null) throw new Error('No parent port in miner worker');

/**
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 */

class hashrateCalculator {
	calculateAndSendEvery = 10; // in hashes
	periodStart = Date.now();
	hashCount = 0;
	/** @type {number[]} */	hashTimes = [];

	/** @param {import("worker_threads").MessagePort} parentPort */
	constructor(parentPort) {
		this.parentPort = parentPort;
	}
	/** @param {number} hashTime */
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
		if (this.hashCount === 0) return;
		if (this.hashCount % this.calculateAndSendEvery !== 0) return;

		const avgTime = this.hashTimes.reduce((a, b) => a + b, 0) / this.hashTimes.length;
		console.log('Average hash time:', avgTime.toFixed(2), 'ms');
		this.hashTimes = [];
	}
}
async function mineBlockUntilValid() {
	if (parentPort === null) throw new Error('No parent port in miner worker');

	const hashRateCalculator = new hashrateCalculator(parentPort);
	while (true) {
		if (minerVars.exiting) return { error: 'Exiting' };
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
			const { signatureHex, nonce, block } = await prepareBlockCandidateBeforeMining();
			const blockHash = await mining.hashBlockSignature(HashFunctions.Argon2, signatureHex, nonce);
			if (!blockHash) throw new Error('Invalid block hash');
			
			block.hash = blockHash.hex;
			hashRateCalculator.newHash(performance.now() - startTime);
			//console.log('hashTime', Math.round(performance.now() - startTime), 'ms');
			
			if (!mining.verifyBlockHashConformToDifficulty(blockHash.bitsString, block).conform) continue;
			const now = Date.now() + minerVars.timeOffset;
			const blockReadyIn = Math.max(block.timestamp - now, 0);
			await new Promise((resolve) => setTimeout(resolve, blockReadyIn));
			return block;
		} catch (/**@type {any}*/ error) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { error: error.stack };
		}
	}
}
async function prepareBlockCandidateBeforeMining() {
	//let time = performance.now();
	//console.log(`prepareNextBlock: ${performance.now() - time}ms`); time = performance.now();
	/** @ts-ignore Candidate transmute to Finalized @type {BlockFinalized | null} */
	const block = minerVars.blockCandidate;
	if (block === null) throw new Error('No block candidate available');

	/** @ts-ignore Candidate transmute to Finalized @type {number} */
	const powReward = block.powReward;
	const headerNonce = mining.generateRandomNonce().Hex;
	const coinbaseNonce = mining.generateRandomNonce().Hex;
	block.nonce = headerNonce;

	const now = Date.now() + minerVars.timeOffset;
	block.timestamp = Math.max(block.posTimestamp + 1 + minerVars.bet, now);
	const coinbaseTx = await Transaction_Builder.createCoinbase(coinbaseNonce, minerVars.rewardAddress, powReward);
	BlockUtils.setCoinbaseTransaction(block, coinbaseTx); // Will replace existing coinbase if any

	const signatureHex = await BlockUtils.getBlockSignature(block);
	const nonce = `${headerNonce}${coinbaseNonce}`;
	//console.log(`${ signatureHex}:${nonce}`);
	//console.log(`getBlockSignature: ${performance.now() - time}ms`); time = performance.now();

	return { signatureHex, nonce, block };
}

const minerVars = {
	exiting: false,
	working: false,

	rewardAddress: '',
	highestBlockHeight: 0,
	bet: 0,
	timeOffset: 0,
	paused: false,
	/** @type {BlockCandidate | null} */	blockCandidate: null,
	/** @type {number | null} */			pausedAtTime: 0,

	testMiningSpeedPenality: 0 // TODO: set to 0 after testing
};

parentPort.on('message', async (task) => {
	if (parentPort === null) throw new Error('No parent port in miner worker');

	const response = {};
    switch (task.type) {
		case 'updateInfo':
			minerVars.rewardAddress = task.rewardAddress;
			minerVars.bet = task.bet;
			minerVars.timeOffset = task.timeOffset;
			return;
        case 'newCandidate':
			minerVars.highestBlockHeight = task.blockCandidate.index;
			minerVars.blockCandidate = task.blockCandidate;
			minerVars.pausedAtTime = null;
			return;
		case 'mineUntilValid':
			if (minerVars.working) return;
			
			minerVars.working = true;
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
			minerVars.exiting = true;
			parentPort.close(); // close the worker
			break;
        default:
			response.error = 'Invalid task type';
            break;
    }

	if (minerVars.exiting) return;
	
	minerVars.working = false;
	parentPort.postMessage(response);
});