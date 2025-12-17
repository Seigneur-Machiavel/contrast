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
 */

const validationMiniLogger = new MiniLogger('validation');
export class BlockValidation {
	// PUBLIC STATIC METHODS
    /** @param {number} powReward @param {number} posReward @param {BlockFinalized} block */
    static areExpectedRewards(powReward, posReward, block) {
        if (block.Txs[0].outputs[0].amount !== powReward) throw new Error(`Invalid PoW reward: ${block.Txs[0].outputs[0].amount} - expected: ${powReward}`);
        if (block.Txs[1].outputs[0].amount !== posReward) throw new Error(`Invalid PoS reward: ${block.Txs[1].outputs[0].amount} - expected: ${posReward}`);
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
        if (block.difficulty !== newDifficulty) throw new Error(`!banBlock! !applyOffense! Invalid difficulty: ${block.difficulty} - expected: ${newDifficulty}`);
        
		// VALIDATE BLOCK POW HASH AGAINST DIFFICULTY
		const hashConfInfo = mining.verifyBlockHashConformToDifficulty(bitsArrayAsString, block);
        if (!hashConfInfo.conform) throw new Error(`!banBlock! !applyOffense! Invalid pow hash (difficulty): ${block.hash} -> ${hashConfInfo.message}`);
        
		// POS/POW REWARDS & TRANSACTION VALIDATION
		const expectedCoinBase = mining.calculateNextCoinbaseReward(lastBlock || block);
        if (block.coinBase !== expectedCoinBase) throw new Error(`!banBlock! !applyOffense! Invalid #${block.index} coinbase: ${block.coinBase} - expected: ${expectedCoinBase}`);

		const { involvedAnchors, repeatedAnchorsCount } = BlockUtils.extractInvolvedAnchors(block, 'blockFinalized');
		if (repeatedAnchorsCount > 0) throw new Error('!banBlock! !applyOffense! Repeated UTXO anchors detected in block');

		const involvedUTXOs = node.blockchain.getUtxos(involvedAnchors, true);
		if (involvedUTXOs === null) throw new Error('!banBlock! !applyOffense! At least one UTXO not found or spent in blockchain during block validation');
        
		const { powReward, posReward, totalFees } = BlockUtils.calculateBlockReward(involvedUTXOs, block);
        try { this.areExpectedRewards(powReward, posReward, block); } 
        catch { throw new Error('!banBlock! !applyOffense! Invalid rewards'); }

        try { this.#isFinalizedBlockDoubleSpending(block); }
        catch { throw new Error('!banBlock! !applyOffense! Double spending detected'); }
        
		const allDiscoveredPubKeysAddresses = await this.#fullBlockTxsValidation(block, node, involvedUTXOs);
        return { hashConfInfo, powReward, posReward, totalFees, allDiscoveredPubKeysAddresses, involvedUTXOs };
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
            const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : false;
            if (specialTx) continue; // coinbase Tx / validator Tx

            for (const input of tx.inputs)
                if (utxoSpent.has(input)) throw new Error('Double spending!');
                else utxoSpent.add(input);
        }
    }
    /** Apply fullTransactionValidation() to all transactions in a block @param {BlockFinalized} block @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs */
    static async #fullBlockTxsValidation(block, node, involvedUTXOs) {
		/** @type {Object<string, string>} */
        const allDiscoveredPubKeysAddresses = {};
		const memPool = node.memPool;
		const workers = node.workers.validations || [];
        const nbOfWorkers = workers.length;
        const minTxsToUseWorkers = 1; //15;
        const singleThreadStart = Date.now();
        if (nbOfWorkers === 0 || block.Txs.length <= minTxsToUseWorkers) {
            for (let i = 0; i < block.Txs.length; i++) {
                const tx = block.Txs[i];
                const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : false; // coinbase Tx / validator Tx
                const { fee, success, discoveredPubKeysAddresses } = await TxValidation.fullTransactionValidation(involvedUTXOs, memPool, tx, specialTx);
                if (!success) throw new Error(`Invalid transaction: ${block.index}:${i}`);

				for (const pubKeyHex in discoveredPubKeysAddresses)
					allDiscoveredPubKeysAddresses[pubKeyHex] = discoveredPubKeysAddresses[pubKeyHex];
            }
            validationMiniLogger.log(`Single thread ${block.Txs.length} txs validated in ${Date.now() - singleThreadStart} ms`, (m, c) => console.info(m, c));
            return allDiscoveredPubKeysAddresses;
        }

        // THIS CODE IS NOT EXECUTED IF nbOfWorkers === 0 // IGNORED ATM
        //#region - MULTI THREADING VALIDATION_v2
        const multiThreadStart = Date.now();
        // PARTIAL VALIDATION
		/** @type {Object<string, string>} */
        const allImpliedKnownPubkeysAddresses = {};
        for (let i = 0; i < block.Txs.length; i++) {
            const tx = block.Txs[i];
			const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : false; // coinbase Tx / validator Tx
            const r = await TxValidation.partialTransactionValidation(involvedUTXOs, memPool, tx, specialTx);
			if (!r.success) throw new Error(`Invalid transaction: ${block.index}:${i}`);
			
			for (const pubKeyHex in r.impliedKnownPubkeysAddresses)
				allImpliedKnownPubkeysAddresses[pubKeyHex] = r.impliedKnownPubkeysAddresses[pubKeyHex];
        }

        // ADDRESS OWNERSHIP CONFIRMATION WITH WORKERS
		/** @type {Set<number>} */
        const treatedTxs = new Set();
        let remainingTxs = block.Txs.length;
        let fastTreatedTxs = 0;
        // treat the first 2 transactions in the main thread
        for (let i = 0; i < 2; i++) {
            const tx = block.Txs[i];
			const specialTx = Transaction_Builder.isMinerOrValidatorTx(tx); // coinbase Tx / validator Tx
			if (!specialTx) throw new Error(`Invalid special transaction at index ${i} in block ${block.index}`);
			
			const r = await TxValidation.fullTransactionValidation(involvedUTXOs, memPool, tx, specialTx);
            if (!r.success) throw new Error(`Invalid transaction: ${block.index}:${i}`);

			for (const pubKeyHex in r.discoveredPubKeysAddresses)
				allDiscoveredPubKeysAddresses[pubKeyHex] = r.discoveredPubKeysAddresses[pubKeyHex];

			treatedTxs.add(i);
            remainingTxs--;
        }

        // treat the txs that can be fast validated because we know the pubKey-address correspondence
        for (let i = 2; i < block.Txs.length; i++) {
            const tx = block.Txs[i];
            const isValid = await TxValidation.addressOwnershipConfirmationOnlyIfKownPubKey(
                involvedUTXOs, tx, allImpliedKnownPubkeysAddresses, false
            );
            if (isValid === false) continue; // can't proceed fast confirmation

            remainingTxs--;
            fastTreatedTxs++;
			treatedTxs.add(i);
        }

        if (remainingTxs === 0) {
            validationMiniLogger.log(`Multi thread ${block.Txs.length}(fast: ${fastTreatedTxs}) txs validated in ${Date.now() - multiThreadStart} ms`, (m, c) => console.info(m, c));
            return allDiscoveredPubKeysAddresses;
        }

		/** @type {Object<number, Transaction[]>} */			const txsByWorkers = {};
		/** @type {Object<number, Promise<any> | null>} */		const workersPromises = {};
        for (const worker of workers) {
			workersPromises[worker.id] = null;
			txsByWorkers[worker.id] = [];
		}

        // SPLIT THE REMAINING TRANSACTIONS BETWEEN WORKERS
        const nbOfTxsPerWorker = Math.floor(remainingTxs / nbOfWorkers);
        let currentWorkerIndex = 0;
        for (let i = 2; i < block.Txs.length; i++) {
			if (treatedTxs.has(i)) continue; // already treated
			txsByWorkers[workers[currentWorkerIndex].id].push(block.Txs[i]);

            const isLastWorker = currentWorkerIndex === nbOfWorkers - 1;
            if (isLastWorker) continue; // avoid giving tx to undefined worker

            // check nbOfTxsPerWorker to increment the currentWorkerIndex
            const workerTxsCount = txsByWorkers[workers[currentWorkerIndex].id].length;
            if (workerTxsCount >= nbOfTxsPerWorker) currentWorkerIndex++;
        }

        for (const worker of workers) {
            const txs = txsByWorkers[worker.id];
            if (txs.length === 0) continue;

            workersPromises[worker.id] = worker.addressOwnershipConfirmation(involvedUTXOs, txs, allImpliedKnownPubkeysAddresses);
        }

        for (const worker of workers) {
            if (workersPromises[worker.id] === null) continue; // no task sent

            const resolved = await workersPromises[worker.id];
            if (!resolved.isValid) throw new Error(resolved.error);

			for (const pubKeyHex in resolved.discoveredPubKeysAddresses)
				allDiscoveredPubKeysAddresses[pubKeyHex] = resolved.discoveredPubKeysAddresses[pubKeyHex];
        }

        validationMiniLogger.log(`Multi thread ${block.Txs.length}(fast: ${fastTreatedTxs}) txs validated in ${Date.now() - multiThreadStart} ms`, (m, c) => console.info(m, c));
        return allDiscoveredPubKeysAddresses;
    }
}