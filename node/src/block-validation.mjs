import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { TxValidation } from './tx-validation.mjs';
import { BlockUtils } from './block.mjs';
import { serializer } from '../../utils/serializer.mjs';

/**
 * @typedef {import("./mempool.mjs").MemPool} MemPool
 * @typedef {import("./utxo-cache.mjs").UtxoCache} UtxoCache
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../workers/workers-classes.mjs").ValidationWorker} ValidationWorker
 * 
 * @typedef {import("../../types/block.mjs").BlockData} BlockData
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 */

const validationMiniLogger = new MiniLogger('validation');
export class BlockValidation {
    /** @param {BlockData} blockData @param {BlockData} prevBlockData */
    static isTimestampsValid(blockData, prevBlockData) {
        if (blockData.posTimestamp <= prevBlockData.timestamp) throw new Error(`Invalid PoS timestamp: ${blockData.posTimestamp} <= ${prevBlockData.timestamp}`);
        if (blockData.timestamp > Date.now()) throw new Error('Invalid timestamp');
    }
    /** @param {number} powReward @param {number} posReward @param {BlockData} blockData */
    static areExpectedRewards(powReward, posReward, blockData) {
        if (blockData.Txs[0].outputs[0].amount !== powReward) throw new Error(`Invalid PoW reward: ${blockData.Txs[0].outputs[0].amount} - expected: ${powReward}`);
        if (blockData.Txs[1].outputs[0].amount !== posReward) throw new Error(`Invalid PoS reward: ${blockData.Txs[0].outputs[0].amount} - expected: ${posReward}`);
    }

    /** @param {BlockData} block */
    static checkBlockIndexIsNumber(block) {
        if (typeof block.index !== 'number') throw new Error('Invalid block index');
        if (Number.isInteger(block.index) === false) throw new Error('Invalid block index');
    }
	/** @param {BlockData} finalizedBlock */
	static async #validateBlockSignature(finalizedBlock) {
		const serializedBlock = serializer.serialize.block(finalizedBlock);
		const deserializedBlock = serializer.deserialize.block(serializedBlock);
		const blockSignature = await BlockUtils.getBlockSignature(finalizedBlock);
		const deserializedSignature = await BlockUtils.getBlockSignature(deserializedBlock);
		if (blockSignature !== deserializedSignature) throw new Error('Block signature mismatch');
	}
    /** @param {BlockData} block @param {number} currentHeight */
    static validateBlockIndex(block, currentHeight = -1) {
        if (block.index > currentHeight + 9) throw new Error(`!ignore! Rejected: #${block.index} > #${currentHeight + 9}(+9)`);
        if (block.index > currentHeight + 1) throw new Error(`!store! !reorg! #${block.index} > #${currentHeight + 1}(last+1)`);
        if (block.index <= currentHeight) throw new Error(`!store! Rejected: #${block.index} <= #${currentHeight}(outdated)`);
    }
    /** @param {BlockData} block @param {string} lastBlockHash */
    static validateBlockPrevHash(block, lastBlockHash) {
        if (typeof block.prevHash !== 'string') throw new Error('!banBlock! Invalid prevHash type!');
        if (typeof lastBlockHash !== 'string') throw new Error('!banBlock! Invalid lastBlockHash type!');
        if (lastBlockHash !== block.prevHash) throw new Error(`!store! !reorg! #${block.index} Rejected -> invalid prevHash: ${block.prevHash.slice(0, 10)} - expected: ${lastBlockHash.slice(0, 10)}`);
    }
    /** @param {BlockData} block @param {BlockData} lastBlock @param {number} currentTime */
    static validateTimestamps(block, lastBlock, currentTime) {
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
    /** @param {BlockData} block @param {import("./vss.mjs").Vss} vss */
    static async validateLegitimacy(block, vss, isCandidateBlock = false) {
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
    /** @param {BlockData} blockData */
    static isFinalizedBlockDoubleSpending(blockData) {
        const utxoSpent = {};
        for (let i = 0; i < blockData.Txs.length; i++) {
            const tx = blockData.Txs[i];
            const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : false;
            if (specialTx) continue; // coinbase Tx / validator Tx

            for (const input of tx.inputs)
                if (utxoSpent[input]) throw new Error('Double spending!');
                else utxoSpent[input] = true;
        }
    }
    /** Apply fullTransactionValidation() to all transactions in a block
     * @param {BlockData} blockData @param {ContrastNode} node */
    static async fullBlockTxsValidation(blockData, node) {
		const { utxoCache, memPool, workers } = node;
        const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTxs(blockData.Txs);
        if (!involvedUTXOs) throw new Error('At least one UTXO not found in utxoCache');

        /** @type {Object<string, string>} */
        const allDiscoveredPubKeysAddresses = {};
        const nbOfWorkers = workers.length;
        const minTxsToUseWorkers = 15;
        const singleThreadStart = Date.now();
        if (nbOfWorkers === 0 || blockData.Txs.length <= minTxsToUseWorkers) {
            for (let i = 0; i < blockData.Txs.length; i++) {
                const tx = blockData.Txs[i];
                let specialTx = false;
                if (i < 2) { specialTx = Transaction_Builder.isMinerOrValidatorTx(tx) } // coinbase Tx / validator Tx

                const { fee, success, discoveredPubKeysAddresses } = await TxValidation.fullTransactionValidation(involvedUTXOs, memPool, tx, specialTx);
                if (!success) throw new Error(`Invalid transaction: ${blockData.index}:${i}`);

				for (const pubKeyHex in discoveredPubKeysAddresses)
					allDiscoveredPubKeysAddresses[pubKeyHex] = discoveredPubKeysAddresses[pubKeyHex];
            }
            validationMiniLogger.log(`Single thread ${blockData.Txs.length} txs validated in ${Date.now() - singleThreadStart} ms`, (m, c) => console.info(m, c));
            return allDiscoveredPubKeysAddresses;
        }

        // THIS CODE IS NOT EXECUTED IF nbOfWorkers === 0 // IGNORED ATM
        //#region - MULTI THREADING VALIDATION_v2
        const multiThreadStart = Date.now();
        // PARTIAL VALIDATION
        const allImpliedKnownPubkeysAddresses = {};
        for (let i = 0; i < blockData.Txs.length; i++) {
            const tx = blockData.Txs[i];
            let specialTx = false;
            if (i < 2) { specialTx = Transaction_Builder.isMinerOrValidatorTx(tx) } // coinbase Tx / validator Tx

            const r = await TxValidation.partialTransactionValidation(involvedUTXOs, memPool, tx, specialTx);
			if (!r.success) throw new Error(`Invalid transaction: ${blockData.index}:${i}`);
			
			for (const pubKeyHex in r.impliedKnownPubkeysAddresses)
				allImpliedKnownPubkeysAddresses[pubKeyHex] = r.impliedKnownPubkeysAddresses[pubKeyHex];
        }

        // ADDRESS OWNERSHIP CONFIRMATION WITH WORKERS
        const treatedTxs = {};
        let remainingTxs = blockData.Txs.length;
        let fastTreatedTxs = 0;
        // treat the first 2 transactions in the main thread
        for (let i = 0; i < 2; i++) {
            const tx = blockData.Txs[i];
            let specialTx = false;
            if (i < 2) { specialTx = Transaction_Builder.isMinerOrValidatorTx(tx) } // coinbase Tx / validator Tx

			const r = await TxValidation.fullTransactionValidation(involvedUTXOs, memPool, tx, specialTx);
            if (!r.success) throw new Error(`Invalid transaction: ${blockData.index}:${i}`);

			for (const pubKeyHex in r.discoveredPubKeysAddresses)
				allDiscoveredPubKeysAddresses[pubKeyHex] = r.discoveredPubKeysAddresses[pubKeyHex];

            treatedTxs[i] = true;
            remainingTxs--;
        }

        // treat the txs that can be fast validated because we know the pubKey-address correspondence
        for (let i = 2; i < blockData.Txs.length; i++) {
            const tx = blockData.Txs[i];
            const isValid = await TxValidation.addressOwnershipConfirmationOnlyIfKownPubKey(
                involvedUTXOs, tx, allImpliedKnownPubkeysAddresses, false, false
            );
            if (isValid === false) continue; // can't proceed fast confirmation

            remainingTxs--;
            fastTreatedTxs++;
            treatedTxs[i] = true;
        }

        if (remainingTxs === 0) {
            validationMiniLogger.log(`Multi thread ${blockData.Txs.length}(fast: ${fastTreatedTxs}) txs validated in ${Date.now() - multiThreadStart} ms`, (m, c) => console.info(m, c));
            return allDiscoveredPubKeysAddresses;
        }

        const workersPromises = {};
        const txsByWorkers = {};
        for (const worker of workers) {
			workersPromises[worker.id] = null;
			txsByWorkers[worker.id] = [];
		}

        // SPLIT THE REMAINING TRANSACTIONS BETWEEN WORKERS
        const nbOfTxsPerWorker = Math.floor(remainingTxs / nbOfWorkers);
        let currentWorkerIndex = 0;
        for (let i = 2; i < blockData.Txs.length; i++) {
            if (treatedTxs[i]) continue; // already treated

            const tx = blockData.Txs[i];
            txsByWorkers[workers[currentWorkerIndex].id].push(tx);

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

        validationMiniLogger.log(`Multi thread ${blockData.Txs.length}(fast: ${fastTreatedTxs}) txs validated in ${Date.now() - multiThreadStart} ms`, (m, c) => console.info(m, c));
        return allDiscoveredPubKeysAddresses;
    }

	/** @param {ContrastNode} node @param {BlockData} finalizedBlock */
    static async validateBlockProposal(node, finalizedBlock) {
        try { this.checkBlockIndexIsNumber(finalizedBlock); }
        catch (error) { validationMiniLogger.log(`#${finalizedBlock.index} -> ${error.message} Miner: ${minerId} | Validator: ${validatorId}`, (m, c) => console.info(m, c)); throw error; }

		await this.#validateBlockSignature(finalizedBlock);

        const { hex, bitsArrayAsString } = await BlockUtils.getMinerHash(finalizedBlock);
        if (finalizedBlock.hash !== hex) throw new Error(`!banBlock! !applyOffense! Invalid pow hash (not corresponding): ${finalizedBlock.hash} - expected: ${hex}`);

        this.validateBlockIndex(finalizedBlock, node.blockchain.currentHeight);
        const lastBlockHash = node.blockchain.lastBlock ? node.blockchain.lastBlock.hash : '0000000000000000000000000000000000000000000000000000000000000000';
        this.validateBlockPrevHash(finalizedBlock, lastBlockHash);
        this.validateTimestamps(finalizedBlock, node.blockchain.lastBlock, node.time);
        await this.validateLegitimacy(finalizedBlock, node.vss);

        const { averageBlockTime, newDifficulty } = BlockUtils.calculateAverageBlockTimeAndDifficulty(node);
        if (finalizedBlock.difficulty !== newDifficulty)
			throw new Error(`!banBlock! !applyOffense! Invalid difficulty: ${finalizedBlock.difficulty} - expected: ${newDifficulty}`);
        
		const hashConfInfo = mining.verifyBlockHashConformToDifficulty(bitsArrayAsString, finalizedBlock);
        if (!hashConfInfo.conform)
			throw new Error(`!banBlock! !applyOffense! Invalid pow hash (difficulty): ${finalizedBlock.hash} -> ${hashConfInfo.message}`);

        const expectedCoinBase = mining.calculateNextCoinbaseReward(node.blockchain.lastBlock || finalizedBlock);
        if (finalizedBlock.coinBase !== expectedCoinBase) throw new Error(`!banBlock! !applyOffense! Invalid #${finalizedBlock.index} coinbase: ${finalizedBlock.coinBase} - expected: ${expectedCoinBase}`);
        const { powReward, posReward, totalFees } = BlockUtils.calculateBlockReward(node.utxoCache, finalizedBlock);
        try { this.areExpectedRewards(powReward, posReward, finalizedBlock); } 
        catch { throw new Error('!banBlock! !applyOffense! Invalid rewards'); }

        try { this.isFinalizedBlockDoubleSpending(finalizedBlock); }
        catch { throw new Error('!banBlock! !applyOffense! Double spending detected'); }

        const allDiscoveredPubKeysAddresses = await this.fullBlockTxsValidation(finalizedBlock, node);
        return { hashConfInfo, powReward, posReward, totalFees, allDiscoveredPubKeysAddresses };
    }
}