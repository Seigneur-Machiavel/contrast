// @ts-check
import { HashFunctions } from './conCrypto.mjs';
import { TxValidation } from './tx-validation.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';

/**
 * @typedef {string} TxUniqueId - Unique identifier of tx, hash of serialized transaction.
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import('../../types/block.mjs').BlockFinalized} BlockFinalized
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("./websocketCallback.mjs").WebSocketCallBack} WebSocketCallBack */

class FeeTiersOrganizer {
	/** @type {Object<string, Map<TxUniqueId, Transaction>>} */
	txsByRanges = {
		'1000+': new Map(),
		'100-1000': new Map(),
		'10-100': new Map(),
		'1-10': new Map(),
		'.1-1': new Map(),
		'.01-.1': new Map(),
		'.01-': new Map()
	};
	rangesList = Object.keys(this.txsByRanges);

	#getRangeKey(val = .01) {
		if (val < 0.01) return '.01-';
		if (val < 0.1) return '.01-.1';
		if (val < 1) return '.1-1';
		if (val < 10) return '1-10';
		if (val < 100) return '10-100';
		if (val < 1000) return '100-1000';
		return '1000+';
	}
	/** @param {Transaction} tx @param {number} feePerByte */
	async addTransaction(tx, feePerByte) {
		if (!feePerByte || feePerByte <= 0) throw new Error('Invalid feePerByte value');
		const rangeKey = this.#getRangeKey(feePerByte);
		const rangeMap = this.txsByRanges[rangeKey];
		const txUniqueId = await HashFunctions.SHA256(JSON.stringify(tx.inputs));
		rangeMap.set(txUniqueId, tx);
		return true;
	}
	/** @param {Transaction} tx @param {number} feePerByte */
	async removeTransaction(tx, feePerByte) {
		if (!feePerByte || feePerByte <= 0) throw new Error('Invalid feePerByte value');
		const rangeKey = this.#getRangeKey(feePerByte);
		const rangeMap = this.txsByRanges[rangeKey];
		const txUniqueId = await HashFunctions.SHA256(JSON.stringify(tx.inputs));
		return rangeMap.delete(txUniqueId);
	}
}

export class MemPool {
	blockchain;
	organizer = new FeeTiersOrganizer();
    /** @type {Map<string, Transaction>} */				byAnchor = new Map();
    /** @type {Object<string, WebSocketCallBack>} */	wsCallbacks = {};

	/** @param {import("./blockchain.mjs").Blockchain} blockchain */
	constructor(blockchain) { this.blockchain = blockchain; }

    /** @param {ContrastNode} node @param {Transaction} tx */
    async pushTransaction(node, tx, replaceConflicting = false) {
		// CHECK CONFORMITY & SPENDABILITY
        TxValidation.controlTransactionOutputsRulesConditions(tx); // throw if not conform
		const { involvedAnchors, repeatedAnchorsCount } = Transaction_Builder.extractInvolvedAnchors(tx, true);
		if (repeatedAnchorsCount > 0) throw new Error('Transaction has repeated anchors');
		
		const involvedUTXOs = this.blockchain.getUtxos(involvedAnchors, true);
		if (!involvedUTXOs) throw new Error('Unable to extract involved UTXOs for transaction, spent or missing UTXO detected');
        TxValidation.isConformTransaction(involvedUTXOs, tx); // throw if not conform/spendable
		
		// CHECK CONFLICTS
        const colliding = this.#caughtTransactionsAnchorsCollision(tx);
        if (colliding?.tx && !replaceConflicting) throw new Error(`Conflicting UTXOs anchor: ${colliding?.anchor}`);
		
		// CONFIRM ADDRESS OWNERSHIP & FEE PER BYTE
        const serialized = serializer.serialize.transaction(tx);
        const result = await TxValidation.transactionValidation(node, involvedUTXOs, tx);
		if (result.discovered.address && result.discovered.pubKey)
			await TxValidation.controlAddressDerivation(result.discovered.address, result.discovered.pubKey);
        
		tx.byteWeight = serialized.byteLength;
        tx.feePerByte = result.fee / tx.byteWeight;
		if (tx.feePerByte <= (colliding?.tx?.feePerByte || 0)) throw new Error(`Conflicting transaction in mempool higher or equal feePerByte: ${(colliding?.tx?.feePerByte || 0)} >= ${tx.feePerByte}`);
        
		this.#addMempoolTransaction(tx, colliding?.tx);
    }
	/** @param {BlockFinalized} block */
    removeFinalizedBlocksTransactions(block) {
        for (let i = 2; i < block.Txs.length; i++) {
            const colliding = this.#caughtTransactionsAnchorsCollision(block.Txs[i]);
            if (colliding) this.#removeMempoolTransaction(colliding.tx);
        }
    }
    /** @param {ContrastNode} node @param {Transaction[]} txs @param {number} [breathGap] number of txs before await immediate pause */
    async pushTransactions(node, txs, breathGap = 10) {
        /** @type {{ success: Transaction[], failed: string[] }} */
        const results = { success: [], failed: [] };
		for (let i = 0; i < txs.length; i++) {
            try {
                await this.pushTransaction(node, txs[i]);
                results.success.push(txs[i]);
            } catch (/**@type {any}*/ error) { results.failed.push(error.message) }

			if (i % breathGap === 0) await new Promise(resolve => setImmediate(resolve));
        }

        return results;
    }
    getMostLucrativeTransactionsBatch() {
		/** @type {Transaction[]} */
		const invalidTransactions = [];
		const batchSize = 1000; // Number of anchors to process in one go
		const maxSize = BLOCKCHAIN_SETTINGS.maxBlockSize;
    	const targetSize = maxSize * 0.98;
		const batch = {
			/** @type {Transaction[]} */ txs: [],
			/** @type {string[]} */ anchors: []
		}
		
		const result = { 
			/** @type {Transaction[]} */ txs: [],
			totalBytes: 0,
			totalFee: 0 
		};

		const controlCurrentBatch = () => {
			const involvedUTXOs = this.blockchain.getUtxos(batch.anchors, false) || {};
			for (const tx of batch.txs) {
				try { TxValidation.isConformTransaction(involvedUTXOs, tx) }
				catch (error) { invalidTransactions.push(tx); continue; }
				
				// ADD THE TRANSACTION
				const clone = Transaction_Builder.clone(tx);
				delete clone.feePerByte;
				delete clone.byteWeight;
				result.txs.push(clone);
				result.totalFee += (tx.feePerByte || 0) * (tx.byteWeight || 0);
				result.totalBytes += tx.byteWeight || 0;
				if (result.totalBytes >= targetSize) break;
			}

			batch.anchors = [];
			batch.txs = [];
		}

        // SELECT TRANSACTIONS FROM HIGHEST FEE TIERS TO LOWEST
        for (const rangeKey of this.organizer.rangesList) {
            const rangeMap = this.organizer.txsByRanges[rangeKey];
			if (rangeMap.size === 0) continue;

        	for (const [h, tx] of rangeMap) {
				if (!tx.byteWeight) throw new Error('Transaction in mempool missing byteWeight');
				if (result.totalBytes + tx.byteWeight > maxSize) continue;

				batch.txs.push(tx);
				batch.anchors.push(...tx.inputs);
				if (batch.anchors.length < batchSize) continue;

				controlCurrentBatch();
				if (result.totalBytes >= targetSize) break;
			}

			controlCurrentBatch();
			if (result.totalBytes >= targetSize) break;
        }

		// REMOVE INVALID TRANSACTIONS FROM MEMPOOL & RETURN RESULT
		for (const tx of invalidTransactions) this.#removeMempoolTransaction(tx);
        return result;
    }

	/** @param {Transaction} transaction */
    #caughtTransactionsAnchorsCollision(transaction) {
        for (const input of transaction.inputs) {
			const tx = this.byAnchor.get(input);
			if (tx) return { tx, anchor: input };
		}
    }
    /** IMPORTANT : BE SURE THAT THE TRANSACTION IS CONFORM @param {Transaction} tx @param {Transaction} [txToReplace] */
    #addMempoolTransaction(tx, txToReplace) {
        if (txToReplace) this.#removeMempoolTransaction(txToReplace);
        
		this.organizer.addTransaction(tx, tx.feePerByte || 0);
        for (const input of tx.inputs) this.byAnchor.set(input, tx);
    }
    /** @param {Transaction} transaction */
    #removeMempoolTransaction(transaction) {
        this.organizer.removeTransaction(transaction, transaction.feePerByte || 0);
		for (const input of transaction.inputs) this.byAnchor.delete(input);
    }
}