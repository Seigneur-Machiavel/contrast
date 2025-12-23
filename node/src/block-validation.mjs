// @ts-check
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { TxValidation } from './tx-validation.mjs';
import { BlockUtils } from './block.mjs';
import { serializer } from '../../utils/serializer.mjs';

/**
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("../workers/workers-classes.mjs").ValidationWorker} ValidationWorker */

const validationMiniLogger = new MiniLogger('validation');
const failureErrorMessages = {
	// others can goes up in there but i'm tired now...
	invalidDifficulty: (diff = 0, expected = 0) => `!banBlock! !applyOffense! Invalid difficulty: ${diff} - expected: ${expected}`,
	invalidPowHash: (diff = 0, h = '', msg = '') => `!banBlock! !applyOffense! Invalid pow hash (difficulty: ${diff}): ${h} -> ${msg}`,
	invalidCoinbase: (index = 0, coinBase = 0, expected = 0) => `!banBlock! !applyOffense! Invalid #${index} coinbase: ${coinBase} - expected: ${expected}`,
	repeatedAnchors: '!banBlock! !applyOffense! Repeated UTXO anchors detected in block',
	missingUtxo: '!banBlock! !applyOffense! At least one UTXO not found or spent in blockchain during block validation',
	invalidReward: '!banBlock! !applyOffense! Invalid rewards',
	doubleSpending: '!banBlock! !applyOffense! Double spending detected',
	discoveredDerivationFailure: '!banBlock! !applyOffense! Address derivation control failed during block validation',
}

class WorkerDispatcher {
	/** @type {Array<Promise<any> | null>} */
	promises = [];
	workers;
	workerIndex = 0;

	/** @param {ValidationWorker[]} workers */
	constructor(workers) { this.workers = workers; }

	/** @param {Transaction[]} batch */
	#assignJobToWorker(batch) {
		const w = this.workers[this.workerIndex];
		if (!w) throw new Error('Worker index overflow');

		this.promises.push(w.derivationValidation(batch));
		this.workerIndex++;
	}

	/** @param {BlockFinalized} block */
	async dispatchJobAndWaitResult(block) {

		let batch = [];
        const batchSize = Math.ceil(block.Txs.length / this.workers.length);
		for (const tx of block.Txs) {
			batch.push(tx);
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
    /** @param {number} powReward @param {number} posReward @param {BlockFinalized} block */
    static #areExpectedRewards(powReward, posReward, block) {
		const isValid = block.Txs[0].outputs[0].amount === powReward && block.Txs[1].outputs[0].amount === posReward;
        if (isValid) return; // PASS
		// LOG & THROW ERROR
		if (block.Txs[0].outputs[0].amount !== powReward) validationMiniLogger.log(`Invalid PoW reward: ${block.Txs[0].outputs[0].amount} - expected: ${powReward}`, (m, c) => console.warn(m, c));
        if (block.Txs[1].outputs[0].amount !== posReward) validationMiniLogger.log(`Invalid PoS reward: ${block.Txs[1].outputs[0].amount} - expected: ${posReward}`, (m, c) => console.warn(m, c));
		throw new Error(failureErrorMessages.invalidReward);
	}
	/** @param {ContrastNode} node @param {BlockFinalized} block */
    static async validateBlockProposal(node, block) {
		if (typeof node.time !== 'number') throw new Error('Node time is missing');

		// VALIDATE BLOCK INDEX
		if (typeof block.index !== 'number') throw new Error('!banBlock! Invalid block index type');
		if (Number.isInteger(block.index) === false) throw new Error('!banBlock! Invalid block index value');

		// VALIDATE BLOCK SIGNATURE (CONFORMITY OF THE DATAS USING SERIALIZER)
		const serializedBlock = serializer.serialize.block(block);
		const deserializedBlock = serializer.deserialize.blockFinalized(serializedBlock);
		const blockSignature = await BlockUtils.getBlockSignature(block);
		const deserializedSignature = await BlockUtils.getBlockSignature(deserializedBlock);
		if (blockSignature !== deserializedSignature) throw new Error('Block signature mismatch');

		// VALIDATE BLOCK HASH
        const { hex, bitsArrayAsString } = await BlockUtils.getMinerHash(block);
        if (block.hash !== hex) throw new Error(`!banBlock! !applyOffense! Invalid pow hash (not corresponding): ${block.hash} - expected: ${hex}`);

		// COMPARE BLOCK INDEX TO CURRENT HEIGHT
		const currentHeight = node.blockchain.currentHeight;
		if (block.index > currentHeight + 9) throw new Error(`!ignore! Rejected: #${block.index} > #${currentHeight + 9}(+9)`);
        if (block.index > currentHeight + 1) throw new Error(`!store! !reorg! #${block.index} > #${currentHeight + 1}(last+1)`);
        if (block.index <= currentHeight) throw new Error(`!store! Rejected: #${block.index} <= #${currentHeight}(outdated)`);

		// VALIDATE BLOCK PREVHASH
		const lastBlock = node.blockchain.lastBlock || null;
		const lastBlockHash = lastBlock ? lastBlock.hash : '0000000000000000000000000000000000000000000000000000000000000000';
		if (typeof block.prevHash !== 'string') throw new Error('!banBlock! Invalid prevHash type!');
        if (typeof lastBlockHash !== 'string') throw new Error('!banBlock! Invalid lastBlockHash type!');
        if (lastBlockHash !== block.prevHash) throw new Error(`!store! !reorg! #${block.index} Rejected -> invalid prevHash: ${block.prevHash.slice(0, 10)} - expected: ${lastBlockHash.slice(0, 10)}`);

		// VALIDATE BLOCK TIMESTAMPS && LEGITIMACY
		this.#validateTimestamps(block, lastBlock, node.time);
        await this.#validateLegitimacy(block, node.vss);

		// VALIDATE BLOCK DIFFICULTY EQUAL TO EXPECTED
        const { averageBlockTime, newDifficulty } = BlockUtils.calculateAverageBlockTimeAndDifficulty(node);
        if (block.difficulty !== newDifficulty) throw new Error(failureErrorMessages.invalidDifficulty(block.difficulty, newDifficulty));
        
		// VALIDATE BLOCK POW HASH AGAINST DIFFICULTY
		const hashConfInfo = mining.verifyBlockHashConformToDifficulty(bitsArrayAsString, block);
        if (!hashConfInfo.conform) throw new Error(failureErrorMessages.invalidPowHash(block.difficulty, block.hash, hashConfInfo.message));
        
		// POS/POW REWARDS & TRANSACTION VALIDATION
		const expectedCoinBase = mining.calculateNextCoinbaseReward(lastBlock || block);
        if (block.coinBase !== expectedCoinBase) throw new Error(failureErrorMessages.invalidCoinbase(block.index, block.coinBase, expectedCoinBase));

		// UTXOs INVOLVED EXTRACTION & VALIDATION
		const { involvedAnchors, repeatedAnchorsCount } = BlockUtils.extractInvolvedAnchors(block, 'blockFinalized');
		if (repeatedAnchorsCount > 0) throw new Error(failureErrorMessages.repeatedAnchors);

		const involvedUTXOs = node.blockchain.getUtxos(involvedAnchors, true);
		if (involvedUTXOs === null) throw new Error(failureErrorMessages.missingUtxo);
        
		// FULL BLOCK TXs VALIDATION we finish with the harder function
		const { powReward, posReward, totalFees } = BlockUtils.calculateBlockReward(involvedUTXOs, block);
        this.#areExpectedRewards(powReward, posReward, block); // throw if invalid rewards
        this.#isFinalizedBlockDoubleSpending(block); // throw if double spending detected
        
		await this.#fullBlockTxsValidation(node, block, involvedUTXOs);
        return { hashConfInfo, powReward, posReward, totalFees, involvedAnchors, involvedUTXOs, size: serializedBlock.length };
    }

	// PRIVATE STATIC METHODS
    /** @param {BlockFinalized} block @param {BlockFinalized | null} lastBlock @param {number} currentTime */
    static #validateTimestamps(block, lastBlock, currentTime) {
        // verify the POS timestamp
        if (typeof block.posTimestamp !== 'number') throw new Error('!banBlock! !applyOffense! Invalid block timestamp');
        if (Number.isInteger(block.posTimestamp) === false) throw new Error('!banBlock! !applyOffense! Invalid block timestamp');
        const timeDiffPos = lastBlock === null ? 1 : block.posTimestamp - lastBlock.timestamp;
        if (timeDiffPos <= 0) throw new Error(`Rejected: #${block.index} -> time difference (${timeDiffPos}) must be greater than 0`);

        // verify final timestamp
        if (typeof block.timestamp !== 'number') throw new Error('!banBlock! !applyOffense! Invalid block timestamp');
        if (Number.isInteger(block.timestamp) === false) throw new Error('!banBlock! !applyOffense! Invalid block timestamp');
        
        const timeDiffFinal = block.timestamp - currentTime;
        if (timeDiffFinal > 1000) throw new Error(`!applyMinorOffense! Rejected: #${block.index} -> ${timeDiffFinal} > timestamp_diff_tolerance: 1000`);
    }
    /** @param {BlockFinalized} block @param {import("./vss.mjs").Vss} vss */
    static async #validateLegitimacy(block, vss, isCandidateBlock = false) {
        //await vss.calculateRoundLegitimacies(block.prevHash);
        const txs = block.Txs;
        const validatorTx = isCandidateBlock ? txs[0] : txs[1];
        if (!validatorTx) throw new Error('Validator transaction not found');

        const validatorAddress = validatorTx.inputs[0].split(':')[0];
        if (!validatorAddress) throw new Error('Validator address not found');

        const validatorLegitimacy = await vss.getAddressLegitimacy(validatorAddress, block.prevHash);
        if (validatorLegitimacy === block.legitimacy) return true;
        else throw new Error(`Invalid #${block.index} legitimacy: ${block.legitimacy} - expected: ${validatorLegitimacy}`);
    }
    /** @param {BlockFinalized} block */
    static #isFinalizedBlockDoubleSpending(block) {
        const utxoSpent = new Set();
        for (let i = 0; i < block.Txs.length; i++) {
            const tx = block.Txs[i];
            const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : undefined;
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
		
		// PROCESS ALL TXs
		/** Key: Address, Value: PubKeys @type {Map<string, Set<string>>} */
		const involvedIdentities = new Map(); // used to avoid re-fetching identities
        const validationStart = Date.now();
		for (let i = 0; i < block.Txs.length; i++) {
            const tx = block.Txs[i];
			const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : undefined; // coinbase Tx / validator Tx
        	TxValidation.isConformTransaction(involvedUTXOs, tx, specialTx); // also check spendable UTXOs
			const fee = specialTx ? 0 : TxValidation.calculateRemainingAmount(involvedUTXOs, tx);
			TxValidation.controlTransactionOutputsRulesConditions(tx);
			TxValidation.controlAddressesOwnership(node, involvedUTXOs, tx, specialTx, involvedIdentities);
			//const r = TxValidation.transactionValidation(node, involvedUTXOs, tx, specialTx, involvedIdentities);
			//if (!r.success) throw new Error(`Invalid transaction: ${block.index}:${i}`);
        }

		// DEPRECATED === DISPATCH WORKERS FOR ADDRESS DERIVATION VALIDATION => NOW CHECKED in "transactionValidation()"
		const dispatchedSuccessfully = await workerDispatcher.dispatchJobAndWaitResult(block);
		if (!dispatchedSuccessfully) throw new Error(failureErrorMessages.discoveredDerivationFailure);

		// ALL VALIDATIONS PASSED
		validationMiniLogger.log(`(${node.workers.validations.length} threads) ${block.Txs.length} Txs validated in ${Date.now() - validationStart} ms`, (m, c) => console.info(m, c));
	}
}