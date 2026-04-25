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

class HashrateCalculator {
    #windowSize = 30;
    /** @type {{ t: number, finalDifficulty: number }[]} */
    #window = [];

    /** @param {import("worker_threads").MessagePort} parentPort */
    constructor(parentPort) { this.parentPort = parentPort; }

    /** @param {number} finalDifficulty */
    newHash(finalDifficulty) {
        this.#window.push({ t: Date.now(), finalDifficulty });
        if (this.#window.length > this.#windowSize) this.#window.shift();
        if (this.#window.length < 2) return;

        const elapsed = (this.#window[this.#window.length - 1].t - this.#window[0].t) / 1000;
        if (elapsed === 0) return;

        const hashRate = (this.#window.length - 1) / elapsed;
        const finalDiffAvg = this.#window.reduce((s, h) => s + h.finalDifficulty, 0) / this.#window.length;
        this.parentPort.postMessage({ hashRate, finalDifficulty: finalDiffAvg });
    }
}

const hashRateCalculator = new HashrateCalculator(parentPort);

const solverVars = {
    exiting: false,
    working: false,
    /** @type {string | undefined} */       sAddress: undefined,
    bet: 0,
    timeOffset: 0,
    paused: false,
    /** @type {BlockCandidate | null} */    blockCandidate: null,
    /** @type {BlockFinalized | null} */    readyBlock: null,
    readyBlockTimestamp: 0,
    /** @type {number | null} */            pausedAtTime: null,
    /** @type {Uint8Array[]} */             identities: [],
    hashingTime: 500,
    testSolvingSpeedPenality: 0,
};

function now() { return Date.now() + solverVars.timeOffset; }

function prepareBlock(applyBet = true) {
    if (!solverVars.blockCandidate) throw new Error('No block candidate available');
	if (!solverVars.blockCandidate.powReward) throw new Error('Block candidate has no powReward');
    if (!solverVars.sAddress) throw new Error('No reward address provided');

    /** @type {BlockFinalized} */ // @ts-ignore
    const block = solverVars.blockCandidate;
    const headerNonce = solving.generateRandomNonce().Hex;
    const coinbaseNonce = solving.generateRandomNonce().Hex;
    block.nonce = headerNonce;
    block.timestamp = applyBet
        ? Math.max(block.posTimestamp + 1 + solverVars.bet, now() + solverVars.hashingTime)
        : now() + Math.max(solverVars.hashingTime - 100, 0);

    const rewardTx = Transaction_Builder.createSolverReward(
        coinbaseNonce, solverVars.sAddress, solverVars.blockCandidate.powReward, solverVars.identities
    );
    BlockUtils.setCoinbaseTransaction(block, rewardTx);

    const signatureHex = BlockUtils.getBlockSignature(block);
    return { signatureHex, nonce: `${headerNonce}${coinbaseNonce}`, block, candidateIndex: block.index };
}

async function mineBlockUntilValid() {
    while (true) {
        // Submit preshot block if its timestamp is reached
        if (solverVars.readyBlock?.index === solverVars.blockCandidate?.index
			&& solverVars.readyBlock?.prevHash === solverVars.blockCandidate?.prevHash
			&& solverVars.readyBlockTimestamp <= now())
			return solverVars.readyBlock;

        if (solverVars.exiting) return { error: 'Exiting' };
        if (solverVars.paused) { await new Promise(r => setTimeout(r, 100)); continue; }

        while (solverVars.pausedAtTime && solverVars.pausedAtTime > Date.now() - 60_000)
            await new Promise(r => setTimeout(r, 100));

        if (!solverVars.blockCandidate || solverVars.timeOffset === 0)
            { await new Promise(r => setTimeout(r, 10)); continue; }
        if (solverVars.testSolvingSpeedPenality)
            await new Promise(r => setTimeout(r, solverVars.testSolvingSpeedPenality));

        // If we already have a preshot block pending, keep hashing without bet
        const { signatureHex, nonce, block, candidateIndex } = prepareBlock(solverVars.readyBlock === null);

        try {
            const startTime = Date.now();
            const blockHash = await solving.hashBlockSignature(HashFunctions.Argon2, signatureHex, nonce);
            solverVars.hashingTime = Date.now() - startTime;

            if (!blockHash) throw new Error('Invalid block hash');
            if (candidateIndex !== solverVars.blockCandidate?.index) continue; // stale, discard

            block.hash = blockHash.hex;
            const { conform, finalDifficulty } = solving.verifyBlockHashConformToDifficulty(blockHash.bitsString, block);
            hashRateCalculator.newHash(finalDifficulty);
            if (!conform) continue;
			
            if (block.timestamp - now() <= 0) return block;
            //solverVars.readyBlock = { ...block }; // clone to freeze state
			//solverVars.readyBlock = { ...block, Txs: block.Txs.map(tx => ({ ...tx })) };
			solverVars.readyBlock = { ...block, Txs: [...block.Txs] };
			solverVars.readyBlock = JSON.parse(JSON.stringify(block)); // deep clone to freeze state
            solverVars.readyBlockTimestamp = block.timestamp;
        } catch (/** @type {any} */ err) {
            await new Promise(r => setTimeout(r, 10));
            return { error: err.stack };
        }
    }
}

parentPort.on('message', async (task) => {
    if (parentPort === null) throw new Error('No parent port');

    const response = {};
    switch (task.type) {
        case 'updateInfo':
            solverVars.sAddress = task.sAddress;
            solverVars.bet = task.bet;
            solverVars.timeOffset = task.timeOffset;
            solverVars.identities = task.identityEntries || [];
            return;
		case 'newCandidate':
			if (solverVars.readyBlock?.index !== task.blockCandidate.index
				|| solverVars.readyBlock?.prevHash !== task.blockCandidate.prevHash)
				solverVars.readyBlock = null;
			solverVars.blockCandidate = task.blockCandidate;
			solverVars.pausedAtTime = null;
			return;
        case 'mineUntilValid':
            if (solverVars.working) return;
            solverVars.working = true;
            solverVars.sAddress = task.sAddress;
            solverVars.bet = task.bet;
            solverVars.timeOffset = task.timeOffset;
            solverVars.identities = task.identityEntries || [];

            const finalizedBlock = await mineBlockUntilValid();
            solverVars.readyBlock = null;
            response.result = finalizedBlock;
            break;
        case 'pause':
            solverVars.paused = true;
            solverVars.pausedAtTime = Date.now();
            parentPort.postMessage({ paused: true });
            return;
        case 'resume':
            solverVars.paused = false;
            solverVars.pausedAtTime = null;
            parentPort.postMessage({ paused: false });
            return;
        case 'terminate':
            solverVars.exiting = true;
            parentPort.close();
            break;
        default:
            response.error = 'Invalid task type';
            break;
    }

    if (solverVars.exiting) return;
    solverVars.working = false;
    parentPort.postMessage(response);
});