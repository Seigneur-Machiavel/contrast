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

class OrganizedTx {
	tx; fee; serializedTx; feePerByte;

	/** @param {Transaction} tx - The transaction object @param {number} fee - The total fee of the transaction @param {Uint8Array} serializedTx - The serialized transaction */
	constructor(tx, fee, serializedTx) {
		this.tx = tx;
		this.fee = fee;
		this.serializedTx = serializedTx;
		this.feePerByte = fee / serializedTx.byteLength;
	}
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
    /** @type {Object<string, WebSocketCallBack>} */	wsCallbacks = {};

	/** @param {import("./blockchain.mjs").Blockchain} blockchain */
	constructor(blockchain) { this.blockchain = blockchain; }

    /** @param {ContrastNode} node @param {Uint8Array} serializedTx */
    pushTransaction(node, serializedTx) {
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
		const result = TxValidation.transactionValidation(node, involvedUTXOs, tx);
		if (!result.success) throw new Error('Transaction validation failed: succes === false');
		
		// CHECK CONFLICTS & REPLACEMENT POLICY
		const oTx = new OrganizedTx(tx, result.fee, serializedTx);
		const colliding = this.organizer.caughtAnchorsCollision(tx);
		if (colliding && oTx.feePerByte <= colliding.oTx.feePerByte) throw new Error(`Conflicting transaction in mempool higher or equal feePerByte: ${colliding.oTx.feePerByte} >= ${oTx.feePerByte}`);
		
		// ADD TRANSACTION TO MEMPOOL
		if (colliding?.oTx) this.organizer.remove(colliding.oTx);
		this.organizer.add(oTx);
    }
	/** @param {BlockFinalized} block */
    removeFinalizedBlocksTransactions(block) {
        for (let i = 2; i < block.Txs.length; i++) {
            const colliding = this.organizer.caughtAnchorsCollision(block.Txs[i]);
            if (colliding) this.organizer.remove(colliding.oTx);
        }
    }
    getMostLucrativeTransactionsBatch() {
		/** @type {OrganizedTx[]} */
		const invalidTransactions = [];
		const batchSize = 1000; // Number of anchors to process in one go
		const maxSize = BLOCKCHAIN_SETTINGS.maxBlockSize;
    	const targetSize = maxSize * 0.98;
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

		const controlCurrentBatch = () => {
			const involvedUTXOs = this.blockchain.getUtxos(batch.anchors, false) || {};
			for (const oTx of batch.oTxs) {
				try { TxValidation.isConformTransaction(involvedUTXOs, oTx.tx) }
				catch (error) { invalidTransactions.push(oTx); continue; }
				
				// ADD THE TRANSACTION TO RESULT
				result.txs.push(oTx.tx);
				result.totalFee += oTx.fee;
				result.bytes += oTx.serializedTx.byteLength;
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
				const oTxByteWeight = oTx.serializedTx.byteLength;
				if (!oTxByteWeight) throw new Error('Transaction in mempool missing byteWeight');
				if (result.bytes + batch.bytes + oTxByteWeight > maxSize) continue;

				batch.oTxs.push(oTx);
				batch.anchors.push(...oTx.tx.inputs);
				batch.bytes += oTxByteWeight;
				if (batch.anchors.length >= batchSize) controlCurrentBatch();
				if (result.bytes + batch.bytes >= targetSize) controlCurrentBatch();
				if (result.bytes >= targetSize) break;
			}

			controlCurrentBatch();
			if (result.bytes >= targetSize) break;
        }

		// REMOVE INVALID TRANSACTIONS FROM MEMPOOL & RETURN RESULT
		for (const oTx of invalidTransactions) this.organizer.remove(oTx);
        return result;
    }
}