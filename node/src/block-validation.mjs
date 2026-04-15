// @ts-check
import { BlockUtils } from './block.mjs';
import { solving } from '../../utils/conditionals.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { SIZES } from '../../utils/serializer-schema.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { IdentitiesCache, TxValidation } from './tx-validation.mjs';
import { ValidationWorker } from '../workers/validation-worker-wrapper.mjs';

/**
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import('../src/tx-validation.mjs').qsafeVerifyTask} qsafeVerifyTask */

const validationMiniLogger = new MiniLogger('validation');
const failureErrorMessages = {
	// others can goes up in there but i'm tired now...
	invalidDifficulty: (diff = 0, expected = 0) => `!applyOffense! Invalid difficulty: ${diff} - expected: ${expected}`,
	invalidPowHash: (diff = 0, h = '', msg = '') => `!applyOffense! Invalid pow hash (difficulty: ${diff}): ${h} -> ${msg}`,
	invalidCoinbase: (index = 0, coinBase = 0, expected = 0) => `!applyOffense! Invalid #${index} coinbase: ${coinBase} - expected: ${expected}`,
	repeatedAnchors: '!applyOffense! Repeated UTXO anchors detected in block',
	missingUtxo: '!applyOffense! At least one UTXO not found or spent in blockchain during block validation',
	invalidReward: '!applyOffense! Invalid rewards',
	doubleSpending: '!applyOffense! Double spending detected',
	signatureValidationFailed: '!applyOffense! Witness signature validation failed during block validation'
}

class WorkerDispatcher {
	/** @type {Array<Promise<any> | null>} */
	promises = [];
	workers;
	workerIndex = 0;

	/** @param {ValidationWorker[]} workers */
	constructor(workers) { this.workers = workers; }

	/** @param {qsafeVerifyTask[]} batch */
	#assignJobToWorker(batch) {
		const w = this.workers[this.workerIndex];
		if (!w) throw new Error('Worker index overflow');

		this.promises.push(w.signatureValidation(batch));
		this.workerIndex++;
	}

	/** @param {qsafeVerifyTask[]} tasks */
	async dispatchJobAndWaitResult(tasks) {
		let batch = [];
        const batchSize = Math.ceil(tasks.length / this.workers.length);
		for (const task of tasks) {
			batch.push(task);
			if (batch.length < batchSize) continue;
			// BATCH READY => ASSIGN TO WORKER & CLEAR BATCH
			this.#assignJobToWorker(batch);
			batch = [];
		}

		// ASSIGN LAST BATCH IF NEEDED
		if (batch.length > 0) this.#assignJobToWorker(batch);

		// WAIT FOR ALL WORKERS TO COMPLETE (OR ABORT ON ERROR)
		try { await Promise.all(this.promises); return true; }
		catch (error) { for (const worker of this.workers) worker.abortOperation(); }
		return false;
	}
}

export class BlockValidation {
	// PUBLIC STATIC METHODS
	/** @param {ContrastNode} node @param {BlockFinalized} block @param {Uint8Array} serializedBlock */
    static async validateBlockProposal(node, block, serializedBlock) {
		if (typeof node.time !== 'number') throw new Error('Node time is missing');

		// COMPARE BLOCK INDEX TO CURRENT HEIGHT => AVOID HARD HASH COMPUTE IN MANY CASES
		const { lastBlock, currentHeight } = node.blockchain;
		if (block.index <= currentHeight) throw new Error(`Rejected: #${block.index} <= #${currentHeight}(outdated)`);
		if (block.index > currentHeight + 1) throw new Error(`Rejected: #${block.index} > #${currentHeight + 1}(last+1)`);

		// VALIDATE BLOCK HASH
        const { hex, bitsArrayAsString } = await BlockUtils.getSolverHash(block);
        if (block.hash !== hex) throw new Error(`!applyOffense! Invalid pow hash (not corresponding): ${block.hash} - expected: ${hex}`);

		// VALIDATE BLOCK PREVHASH
		const lastBlockHash = lastBlock?.hash || '00'.repeat(SIZES.hash.bytes);
        if (lastBlockHash !== block.prevHash) throw new Error(`#${block.index} Rejected -> invalid prevHash: ${block.prevHash.slice(0, 4)}... - expected: ${lastBlockHash.slice(0, 4)}...`);

		// VALIDATE BLOCK TIMESTAMPS && LEGITIMACY
		this.#validateTimestamps(block, lastBlock, node.time);
        await this.validateLegitimacy(node, block);

		// VALIDATE BLOCK DIFFICULTY EQUAL TO EXPECTED
        const { averageBlockTime, newDifficulty } = BlockUtils.calculateAverageBlockTimeAndDifficulty(node, true);
        if (block.difficulty !== newDifficulty) throw new Error(failureErrorMessages.invalidDifficulty(block.difficulty, newDifficulty));
        
		// VALIDATE BLOCK POW HASH AGAINST DIFFICULTY
		const hashConfInfo = solving.verifyBlockHashConformToDifficulty(bitsArrayAsString, block);
        if (!hashConfInfo.conform) throw new Error(failureErrorMessages.invalidPowHash(block.difficulty, block.hash, hashConfInfo.message));
        
		// POS/POW REWARDS & TRANSACTION VALIDATION
		const expectedCoinBase = solving.calculateNextCoinbaseReward(lastBlock || block);
        if (block.coinBase !== expectedCoinBase) throw new Error(failureErrorMessages.invalidCoinbase(block.index, block.coinBase, expectedCoinBase));

		// UTXOs INVOLVED EXTRACTION & VALIDATION
		const { involvedAnchors, repeatedAnchorsCount } = BlockUtils.extractInvolvedAnchors(block, 'blockFinalized');
		if (repeatedAnchorsCount > 0) throw new Error(failureErrorMessages.repeatedAnchors);

		const involvedUTXOs = node.blockchain.getUtxos(involvedAnchors, true); // early return null if at least one UTXO is missing/spent
		if (involvedUTXOs === null) throw new Error(failureErrorMessages.missingUtxo);
        
		// FULL BLOCK TXs VALIDATION we finish with the harder function
		const { powReward, posReward, totalFees } = BlockUtils.calculateBlockReward(involvedUTXOs, block);
        this.#areExpectedRewards(powReward, posReward, block); // throw if invalid rewards
        this.#isFinalizedBlockDoubleSpending(block); // throw if double spending detected
        
		await this.#fullBlockTxsValidation(node, block, involvedUTXOs);
        return { hashConfInfo, powReward, posReward, totalFees, involvedAnchors, involvedUTXOs, size: serializedBlock.length };
    }
	/** @param {ContrastNode} node @param {BlockFinalized | BlockCandidate} block @param {'finalized' | 'candidate'} mode */
    static async validateLegitimacy(node, block, mode = 'finalized') {
		// EARLY RETURN IF BLOCK LEGITIMACY IS "WORSE"
		if (block.legitimacy === await node.blockchain.vss.getWorseLegitimacy(block.prevHash)) return true; // worst legitimacy is always valid (even if not legit for the round, it means that no one was legit, so we accept the block with the worst legitimacy)

        const txs = block.Txs;
        const validatorTx = mode === 'candidate' ? txs[0] : txs[1];
        if (!validatorTx) throw new Error('Validator transaction not found');

		const [address, hint, signature] = validatorTx.witnesses[0];
		const identity = node.blockchain.identityStore.getIdentity(address);
		if (!identity) throw new Error(`Identity not found for address: ${address}`);
		
		for (const pk of identity.pubKeysHex) {
			if (hint !== pk.slice(3, 13)) continue; // compare hint.
			const legitimacy = await node.blockchain.vss.getPubkeyLegitimacy(pk, block.prevHash);
			if (legitimacy === block.legitimacy) return true; // legitimacy validated
		}

		throw new Error(`Invalid #${block.index} legitimacy: ${block.legitimacy} - no matching pubkey with expected legitimacy found for validator address ${address}`);
    }

	// PRIVATE STATIC METHODS
    /** @param {BlockFinalized} block @param {BlockFinalized | null} lastBlock @param {number} currentTime */
    static #validateTimestamps(block, lastBlock, currentTime) {
        // verify the POS timestamp
        if (typeof block.posTimestamp !== 'number') throw new Error('!applyOffense! Invalid block timestamp');
        if (Number.isInteger(block.posTimestamp) === false) throw new Error('!applyOffense! Invalid block timestamp');
        const timeDiffPos = lastBlock === null ? 1 : block.posTimestamp - lastBlock.timestamp;
        if (timeDiffPos <= 0) throw new Error(`Rejected: #${block.index} -> time difference (${timeDiffPos}) must be greater than 0`);

        // verify final timestamp
        if (typeof block.timestamp !== 'number') throw new Error('!applyOffense! Invalid block timestamp');
        if (Number.isInteger(block.timestamp) === false) throw new Error('!applyOffense! Invalid block timestamp');
        
        const timeDiffFinal = block.timestamp - currentTime;
        if (timeDiffFinal > 1000) throw new Error(`!applyMinorOffense! Rejected: #${block.index} -> ${timeDiffFinal} > timestamp_diff_tolerance: 1000`);
    }
	/** @param {number} powReward @param {number} posReward @param {BlockFinalized} block */
    static #areExpectedRewards(powReward, posReward, block) {
		const isValid = block.Txs[0].outputs[0].amount === powReward && block.Txs[1].outputs[0].amount === posReward;
        if (isValid) return; // PASS
		// LOG & THROW ERROR
		if (block.Txs[0].outputs[0].amount !== powReward) validationMiniLogger.log(`Invalid PoW reward: ${block.Txs[0].outputs[0].amount} - expected: ${powReward}`, (m, c) => console.warn(m, c));
        if (block.Txs[1].outputs[0].amount !== posReward) validationMiniLogger.log(`Invalid PoS reward: ${block.Txs[1].outputs[0].amount} - expected: ${posReward}`, (m, c) => console.warn(m, c));
		throw new Error(failureErrorMessages.invalidReward);
	}
    /** @param {BlockFinalized} block */
    static #isFinalizedBlockDoubleSpending(block) {
        const utxoSpent = new Set();
        for (let i = 0; i < block.Txs.length; i++) {
            const tx = block.Txs[i];
            const specialTx = i < 2 ? Transaction_Builder.isSolverOrValidatorTx(tx) : undefined;
            if (specialTx) continue; // coinbase Tx / validator Tx

            for (const input of tx.inputs)
                if (utxoSpent.has(input)) throw new Error(failureErrorMessages.doubleSpending);
                else utxoSpent.add(input);
        }
    }
	/** @param {ContrastNode} node @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs */
    static async #fullBlockTxsValidation(node, block, involvedUTXOs = {}) {
		const workerDispatcher = new WorkerDispatcher(node.workers.validations || []);
		if ((node.workers.validations || []).length === 0) throw new Error('No validation workers available');
		
		// PROCESS ALL TXs -EXCEPT SIGNATURE VERIFICATION
		const identitiesCache = new IdentitiesCache(); // local cache: used to avoid re-fetching identities
        const validationStart = Date.now();
		const signatureVerificationTasks = [];
		for (let i = 0; i < block.Txs.length; i++) {
            const tx = block.Txs[i];
			const specialTx = i < 2 ? Transaction_Builder.isSolverOrValidatorTx(tx) : undefined; // coinbase Tx / validator Tx
        	TxValidation.isConformTransaction(involvedUTXOs, tx, specialTx); // also check spendable UTXOs
			
			const fee = specialTx ? 0 : TxValidation.calculateRemainingAmount(involvedUTXOs, tx);
			TxValidation.controlTransactionOutputsRulesConditions(tx);
			TxValidation.controlIdentitiesReservation(node, tx, identitiesCache);
			TxValidation.extractOutputsIdentities(node, tx, identitiesCache);
			if (specialTx === 'solver') continue; // solver Tx doesn't have to verify signatures (can be signed by anyone)

			const idenditiesToConfirmByAddress = TxValidation.extractInputsIdentities(node, involvedUTXOs, tx, identitiesCache);
			const qsafeVerifyTasks = TxValidation.controlAddressesHasAssociatedWitnesses(tx, idenditiesToConfirmByAddress);
			signatureVerificationTasks.push(...qsafeVerifyTasks);
		}

		// SIGNATURE VERIFICATION (MULTI-THREADING)
		const dispatchedSuccessfully = await workerDispatcher.dispatchJobAndWaitResult(signatureVerificationTasks);
		if (!dispatchedSuccessfully) throw new Error(failureErrorMessages.signatureValidationFailed);

		// ALL VALIDATIONS PASSED
		validationMiniLogger.log(`(${node.workers.validations.length} threads) ${block.Txs.length} Txs validated in ${Date.now() - validationStart} ms`, (m, c) => console.info(m, c));
	}
}