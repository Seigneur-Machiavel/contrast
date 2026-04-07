// @ts-check
import { HashFunctions } from './conCrypto.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { IdentitiesCache, TxValidation } from './tx-validation.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';

/**
 * @typedef {string} TxUniqueId - Unique identifier of tx, hash of serialized transaction.
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import('../../types/block.mjs').BlockFinalized} BlockFinalized
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction */

class OrganizedTx {
	tx; fee; serialized; feePerByte;

	/** @param {Transaction} tx - The transaction object @param {number} fee - The total fee of the transaction @param {Uint8Array} serializedTx - The serialized transaction */
	constructor(tx, fee, serializedTx) {
		this.tx = tx;
		this.fee = fee;
		this.serialized = serializedTx;
		this.feePerByte = fee / serializedTx.byteLength;
	}

	get finalWeight() { return this.serialized.byteLength + 4 }; // Adding 4 bytes for the pointer to the transaction in the finalized block.
}

class Organizer {
	/** @type {Map<string, OrganizedTx>} */	byAnchor = new Map();
	/** @type {Object<string, Map<TxUniqueId, OrganizedTx>>} */
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
	/** @param {OrganizedTx} oTx */
	async add(oTx) {
		const txUniqueId = await HashFunctions.SHA256(JSON.stringify(oTx.tx.inputs));
		const rangeKey = this.#getRangeKey(oTx.feePerByte);

		// ADD BOTH MAPPINGS
		this.txsByRanges[rangeKey].set(txUniqueId, oTx);
		for (const input of oTx.tx.inputs) this.byAnchor.set(input, oTx);
		return true;
	}
	/** @param {OrganizedTx} oTx */
	async remove(oTx) {
		if (oTx.feePerByte <= 0) throw new Error('Invalid feePerByte value');

		const rangeKey = this.#getRangeKey(oTx.feePerByte);
		const txUniqueId = await HashFunctions.SHA256(JSON.stringify(oTx.tx.inputs)); 

		// REMOVE BOTH MAPPINGS
		for (const input of oTx.tx.inputs) this.byAnchor.delete(input);
		return this.txsByRanges[rangeKey].delete(txUniqueId);
	}
	/** @param {Transaction} tx */
    caughtAnchorsCollision(tx) {
        for (const input of tx.inputs) {
			const oTx = this.byAnchor.get(input);
			if (oTx) return { oTx, anchor: input };
		}
    }
}

export class MemPool {
	blockchain;
	organizer = new Organizer();

	/** @param {import("./blockchain.mjs").Blockchain} blockchain */
	constructor(blockchain) { this.blockchain = blockchain; }

    /** DON'T PARALLELIZE THIS FUNCTION!!!
	 * @param {ContrastNode} node @param {Uint8Array} serializedTx */
    async pushTransaction(node, serializedTx) {
		// CHECK CONFORMITY & SPENDABILITY
		const tx = serializer.deserialize.transaction(serializedTx);
		TxValidation.controlTransactionOutputsRulesConditions(tx); // throw if not conform

		const { involvedAnchors, repeatedAnchorsCount } = Transaction_Builder.extractInvolvedAnchors(tx, true);
		if (repeatedAnchorsCount > 0) throw new Error('Transaction has repeated anchors');
		
		const involvedUTXOs = this.blockchain.getUtxos(involvedAnchors, true);
		if (!involvedUTXOs) throw new Error('Unable to extract involved UTXOs for transaction, spent or missing UTXO detected');
		TxValidation.isConformTransaction(involvedUTXOs, tx); // throw if not conform/spendable
		
		// CHECK SIZE LIMIT
		if (serializedTx.byteLength >= BLOCKCHAIN_SETTINGS.maxTransactionSize)
			throw new Error(`Transaction size too big: ${serializedTx.byteLength} bytes >= ${BLOCKCHAIN_SETTINGS.maxTransactionSize} bytes`);
		
		// CONFIRM ADDRESS OWNERSHIP & FEE PER BYTE
		const result = await TxValidation.transactionValidation(node, involvedUTXOs, tx);
		if (!result.success) throw new Error('Transaction validation failed: succes === false');
		
		// CHECK CONFLICTS & REPLACEMENT POLICY
		const oTx = new OrganizedTx(tx, result.fee, serializedTx);
		const colliding = this.organizer.caughtAnchorsCollision(tx);
		if (colliding && oTx.feePerByte <= colliding.oTx.feePerByte) throw new Error(`Conflicting transaction in mempool higher or equal feePerByte: ${colliding.oTx.feePerByte} >= ${oTx.feePerByte}`);
		
		// ADD TRANSACTION TO MEMPOOL
		if (colliding?.oTx) await this.organizer.remove(colliding.oTx);
		this.organizer.add(oTx);
    }
	/** @param {BlockFinalized} block */
    removeFinalizedBlocksTransactions(block) {
        for (let i = 2; i < block.Txs.length; i++) {
            const colliding = this.organizer.caughtAnchorsCollision(block.Txs[i]);
            if (colliding) this.organizer.remove(colliding.oTx);
        }
    }
	/** @param {ContrastNode} node */
    getMostLucrativeTransactionsBatch(node) {
		/** @type {OrganizedTx[]} */
		const invalidTransactions = [];
		const batchSize = 1000; // Number of anchors to process in one go
    	const targetSize = BLOCKCHAIN_SETTINGS.maxBlockSize * 0.98; // a 2% margin to avoid edge cases of slightly exceeding the max block size due to unexpected serialization size differences or future changes in block structure.
		const batch = {
			/** @type {OrganizedTx[]} */   oTxs: [],
			/** @type {string[]} */ 	anchors: [],
			bytes: 0
		}
		
		const result = { 
			/** @type {Transaction[]} */ 	txs: [],
			bytes: 0,
			totalFee: 0 
		};

		/** @type {Set<string>} */
		const spentAnchors = new Set();
		const identitiesCache = new IdentitiesCache();

		const includeCurrentBatchIfValid = () => {
			const involvedUTXOs = this.blockchain.getUtxos(batch.anchors, false) || {};
			for (const oTx of batch.oTxs) {
				// skip transaction if one of its inputs is already spent by another tx in the batch
				if (oTx.tx.inputs.some(input => spentAnchors.has(input))) continue;

				try {
					TxValidation.isConformTransaction(involvedUTXOs, oTx.tx);
					TxValidation.controlOutputsIdentities(node, oTx.tx, identitiesCache);
				} catch (error) { invalidTransactions.push(oTx); continue; }
				
				// ADD THE TRANSACTION TO RESULT
				for (const input of oTx.tx.inputs) spentAnchors.add(input);
				result.txs.push(oTx.tx);
				result.totalFee += oTx.fee;
				result.bytes += oTx.finalWeight;
				if (result.bytes >= targetSize) break;
			}

			batch.anchors = [];
			batch.oTxs = [];
			batch.bytes = 0;
		}

        // SELECT TRANSACTIONS FROM HIGHEST FEE TIERS TO LOWEST
        for (const rangeKey of this.organizer.rangesList) {
            const rangeMap = this.organizer.txsByRanges[rangeKey];
        	for (const [h, oTx] of rangeMap) {
				if (!oTx.finalWeight) throw new Error('Transaction in mempool missing(or zero) finalWeight');
				if (result.bytes + batch.bytes + oTx.finalWeight > targetSize) continue;

				batch.oTxs.push(oTx);
				batch.anchors.push(...oTx.tx.inputs);
				batch.bytes += oTx.finalWeight;
				if (batch.anchors.length >= batchSize) includeCurrentBatchIfValid();
				if (result.bytes + batch.bytes >= targetSize) includeCurrentBatchIfValid();
				if (result.bytes >= targetSize) break;
			}

			includeCurrentBatchIfValid();
			if (result.bytes > targetSize) break;
        }

		// REMOVE INVALID TRANSACTIONS FROM MEMPOOL & RETURN RESULT
		for (const oTx of invalidTransactions) this.organizer.remove(oTx);
        return result;
    }
}