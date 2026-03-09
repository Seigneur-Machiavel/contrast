// @ts-check
import { parentPort } from 'worker_threads';
import { BlockUtils } from '../src/block.mjs';
import { HashFunctions } from '../src/conCrypto.mjs';
import { solving } from '../../utils/conditionals.mjs';
import { Transaction_Builder } from '../src/transaction.mjs';
if (parentPort === null) throw new Error('No parent port in solver worker');

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
	if (parentPort === null) throw new Error('No parent port in solver worker');

	const hashRateCalculator = new hashrateCalculator(parentPort);
	while (true) {
		if (solverVars.exiting) return { error: 'Exiting' };
		if (solverVars.paused) { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }

		// IF PAUSED MORE THAN A MINUTE AGO, WE NEED TO WAIT AN UPDATE OF BLOCK CANDIDATE
		// ON NEW CANDIDATE, PAUSE TIME IS RESET
		while (solverVars.pausedAtTime && solverVars.pausedAtTime > Date.now() - 60000)
			await new Promise((resolve) => setTimeout(resolve, 100));

		if (solverVars.blockCandidate === null) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
		if (solverVars.timeOffset === 0) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
		if (solverVars.testSolvingSpeedPenality) await new Promise((resolve) => setTimeout(resolve, solverVars.testSolvingSpeedPenality));

		try {
			const startTime = performance.now();
			const { signatureHex, nonce, block } = await prepareBlockCandidateBeforeSolving();
			const blockHash = await solving.hashBlockSignature(HashFunctions.Argon2, signatureHex, nonce);
			if (!blockHash) throw new Error('Invalid block hash');
			
			block.hash = blockHash.hex;
			hashRateCalculator.newHash(performance.now() - startTime);
			//console.log('hashTime', Math.round(performance.now() - startTime), 'ms');
			
			if (!solving.verifyBlockHashConformToDifficulty(blockHash.bitsString, block).conform) continue;
			const now = Date.now() + solverVars.timeOffset;
			const blockReadyIn = Math.max(block.timestamp - now, 0);
			await new Promise((resolve) => setTimeout(resolve, blockReadyIn));
			return block;
		} catch (/**@type {any}*/ error) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { error: error.stack };
		}
	}
}
async function prepareBlockCandidateBeforeSolving() {
	//let time = performance.now();
	//console.log(`prepareNextBlock: ${performance.now() - time}ms`); time = performance.now();
	/** @ts-ignore Candidate transmute to Finalized @type {BlockFinalized | null} */
	const block = solverVars.blockCandidate;
	if (block === null) throw new Error('No block candidate available');

	/** @ts-ignore Candidate transmute to Finalized @type {number} */
	const powReward = block.powReward;
	const headerNonce = solving.generateRandomNonce().Hex;
	const coinbaseNonce = solving.generateRandomNonce().Hex;
	block.nonce = headerNonce;

	const now = Date.now() + solverVars.timeOffset;
	block.timestamp = Math.max(block.posTimestamp + 1 + solverVars.bet, now);
	const coinbaseTx = await Transaction_Builder.createCoinbase(coinbaseNonce, solverVars.rewardAddress, powReward);
	BlockUtils.setCoinbaseTransaction(block, coinbaseTx); // Will replace existing coinbase if any

	const signatureHex = await BlockUtils.getBlockSignature(block);
	const nonce = `${headerNonce}${coinbaseNonce}`;
	//console.log(`${ signatureHex}:${nonce}`);
	//console.log(`getBlockSignature: ${performance.now() - time}ms`); time = performance.now();

	return { signatureHex, nonce, block };
}

const solverVars = {
	exiting: false,
	working: false,

	rewardAddress: '',
	highestBlockHeight: 0,
	bet: 0,
	timeOffset: 0,
	paused: false,
	/** @type {BlockCandidate | null} */	blockCandidate: null,
	/** @type {number | null} */			pausedAtTime: 0,

	testSolvingSpeedPenality: 0 // TODO: set to 0 after testing
};

parentPort.on('message', async (task) => {
	if (parentPort === null) throw new Error('No parent port in solver worker');

	const response = {};
    switch (task.type) {
		case 'updateInfo':
			solverVars.rewardAddress = task.rewardAddress;
			solverVars.bet = task.bet;
			solverVars.timeOffset = task.timeOffset;
			return;
        case 'newCandidate':
			solverVars.highestBlockHeight = task.blockCandidate.index;
			solverVars.blockCandidate = task.blockCandidate;
			solverVars.pausedAtTime = null;
			return;
		case 'mineUntilValid':
			if (solverVars.working) return;
			
			solverVars.working = true;
			solverVars.rewardAddress = task.rewardAddress;
			solverVars.bet = task.bet;
			solverVars.timeOffset = task.timeOffset;

			const finalizedBlock = await mineBlockUntilValid();
			response.result = finalizedBlock;
			break;
		case 'pause':
			solverVars.paused = true;
			solverVars.pausedAtTime = Date.now();
			parentPort.postMessage({ paused: true });
			return;
		case 'resume':
			solverVars.paused = false;
			parentPort.postMessage({ paused: false });
			return;
		case 'terminate':
			solverVars.exiting = true;
			parentPort.close(); // close the worker
			break;
        default:
			response.error = 'Invalid task type';
            break;
    }

	if (solverVars.exiting) return;
	
	solverVars.working = false;
	parentPort.postMessage(response);
});