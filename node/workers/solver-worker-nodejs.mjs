// @ts-check
import { parentPort } from 'worker_threads';
import { BlockUtils } from '../src/block.mjs';
import { HashFunctions } from '../src/conCrypto.mjs';
import { solving } from '../../utils/conditionals.mjs';
import { Transaction_Builder } from '../src/transaction.mjs';
if (parentPort === null) throw new Error('No parent port in solver worker');

/**
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized */

class HashrateCalculatorV2 {
    #windowSize = 60; // number of hashes to keep in the window
    /** @type {{ t: number, stale: boolean, finalDifficulty: number }[]} */
    #window = [];
    #isStale = false;
    #lastFinalDifficulty = 1;

    /** @param {import("worker_threads").MessagePort} parentPort */
    constructor(parentPort) { this.parentPort = parentPort; }

    /** @param {number} finalDifficulty */
    onNewCandidate(finalDifficulty) {
        this.#isStale = true; // hashes in flight until next newHash are stale
        this.#lastFinalDifficulty = finalDifficulty;
    }

	/** @param {number} finalDifficulty */
	newHash(finalDifficulty) {
		this.#isStale = false;
		this.#lastFinalDifficulty = finalDifficulty;
		this.#window.push({ t: Date.now(), stale: this.#isStale, finalDifficulty });
		if (this.#window.length > this.#windowSize) this.#window.shift();

		const elapsed = (this.#window[this.#window.length - 1].t - this.#window[0].t) / 1000;
		if (elapsed === 0) return; // single entry, can't compute rate yet

		const staleCount = this.#window.filter(h => h.stale).length;
		const hashRate = this.#window.length / elapsed;
		const stalenessRatio = staleCount / this.#window.length;

		this.parentPort.postMessage({ hashRate, stalenessRatio, finalDifficulty: this.#lastFinalDifficulty });
	}
}

async function mineBlockUntilValid() {
	if (parentPort === null) throw new Error('No parent port in solver worker');

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
			const { signatureHex, nonce, block } = prepareBlockCandidateBeforeSolving();
			const blockHash = await solving.hashBlockSignature(HashFunctions.Argon2, signatureHex, nonce);
			if (!blockHash) throw new Error('Invalid block hash');
			
			block.hash = blockHash.hex;
			
			const { conform, finalDifficulty } = solving.verifyBlockHashConformToDifficulty(blockHash.bitsString, block);
			hashRateCalculatorV2.newHash(finalDifficulty);
			if (!conform) continue;

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
function prepareBlockCandidateBeforeSolving() {
	//let time = performance.now();
	//console.log(`prepareNextBlock: ${performance.now() - time}ms`); time = performance.now();
	/** @ts-ignore Candidate transmute to Finalized @type {BlockFinalized | null} */
	const block = solverVars.blockCandidate;
	if (block === null) throw new Error('No block candidate available');
	if (!solverVars.sAddress) throw new Error('No reward address provided');

	/** @ts-ignore Candidate transmute to Finalized @type {number} */
	const powReward = block.powReward;
	const headerNonce = solving.generateRandomNonce().Hex;
	const coinbaseNonce = solving.generateRandomNonce().Hex;
	block.nonce = headerNonce;

	const now = Date.now() + solverVars.timeOffset;
	block.timestamp = Math.max(block.posTimestamp + 1 + solverVars.bet, now);

	const rewardTx = Transaction_Builder.createSolverReward(coinbaseNonce, solverVars.sAddress, powReward, solverVars.identities);
	BlockUtils.setCoinbaseTransaction(block, rewardTx); // Will replace existing coinbase if any

	const signatureHex = BlockUtils.getBlockSignature(block);
	const nonce = `${headerNonce}${coinbaseNonce}`;
	//console.log(`${ signatureHex}:${nonce}`);
	//console.log(`getBlockSignature: ${performance.now() - time}ms`); time = performance.now();

	return { signatureHex, nonce, block };
}

const solverVars = {
	exiting: false,
	working: false,

	/** @type {string | undefined} */
	sAddress: undefined,
	highestBlockHeight: 0,
	bet: 0,
	timeOffset: 0,
	paused: false,
	/** @type {BlockCandidate | null} */	blockCandidate: null,
	/** @type {number | null} */			pausedAtTime: 0,
	/** @type {Uint8Array[]} */				identities: [],

	testSolvingSpeedPenality: 0 // TODO: set to 0 after testing
};

const hashRateCalculatorV2 = new HashrateCalculatorV2(parentPort);
parentPort.on('message', async (task) => {
	if (parentPort === null) throw new Error('No parent port in solver worker');

	const response = {};
    switch (task.type) {
		case 'updateInfo':
			solverVars.sAddress = task.sAddress;
			solverVars.bet = task.bet;
			solverVars.timeOffset = task.timeOffset;
			solverVars.identities = task.identityEntries || [];
			return;
        case 'newCandidate':
			solverVars.pausedAtTime = null;
			solverVars.blockCandidate = task.blockCandidate;
			solverVars.highestBlockHeight = task.blockCandidate.index;
			hashRateCalculatorV2.onNewCandidate(solving.getBlockFinalDifficulty(task.blockCandidate).finalDifficulty);
			return;
		case 'mineUntilValid':
			if (solverVars.working) return;
			
			solverVars.working = true;
			solverVars.sAddress = task.sAddress;
			solverVars.bet = task.bet;
			solverVars.timeOffset = task.timeOffset;
			solverVars.identities = task.identityEntries || [];

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