// @ts-check
import fs from 'fs';
import path from 'path';
//import AdmZip from 'adm-zip';
import HiveP2P from "hive-p2p";
import { UTXO } from '../types/transaction.mjs';
import { BlockUtils } from '../node/src/block.mjs';
import { serializer } from '../utils/serializer.mjs';
import { BinaryHandler } from './binary-handler.mjs';
import { BLOCKCHAIN_SETTINGS } from '../utils/blockchain-settings.mjs';

/**
 * @typedef {import("hive-p2p").Converter} Converter
 * @typedef {import("../types/block.mjs").BlockInfo} BlockInfo
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/transaction.mjs").VoutId} VoutId
 * @typedef {import("../types/transaction.mjs").TxAnchor} TxAnchor
 * @typedef {import("../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized */

const ENTRY_BYTES = serializer.lengths.indexEntry.bytes;

/** New version of BlockchainStorage.
 * - No needs for "retreiveBlockByHash" anymore, we only use block indexes now
 * - Blocks hashes are stored in an index file (blockchain.idx) for fast retrieval
 * - Blocks are stored in binary files containing a batch (max: 262_980 blocks per file) */
export class BlockchainStorage {
	storage;
	get logger() { return this.storage.miniLogger; }
	converter = new HiveP2P.Converter();
	batchSize = BLOCKCHAIN_SETTINGS.halvingInterval; // number of blocks per binary file
	lastBlockIndex = -1;
	/** Blockchain parts handler (blockchain-X.bin) Key: block file index @type {Object<number, BinaryHandler>} */
	bcHandlers = {};
	/** Blocks indexes (blockchain.idx) handler @type {BinaryHandler} */
	idxsHandler;
	
	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) {
		this.storage = storage;
		this.idxsHandler = new BinaryHandler(path.join(this.storage.PATH.BLOCKCHAIN, 'blockchain.idx'));
		if (this.idxsHandler.size % ENTRY_BYTES !== 0) throw new Error(`blockchain.idx file is corrupted (size: ${this.idxsHandler.size})`);
		this.lastBlockIndex = Math.ceil(this.idxsHandler.size / ENTRY_BYTES) - 1;
		this.logger.log(`BlockchainStorage initialized with ${this.lastBlockIndex + 1} blocks`, (m, c) => console.info(m, c));
	}
	
	// API METHODS
	/** @param {BlockFinalized} block @param {TxAnchor[]} involvedAnchors */
    addBlock(block, involvedAnchors) {
		if (block.index !== this.lastBlockIndex + 1) throw new Error(`Block index mismatch: expected ${this.lastBlockIndex + 1}, got ${block.index}`);
		if (!this.#consumeUtxos(involvedAnchors)) throw new Error('Unable to consume UTXOs for the new block');

		// PREPARE DATA TO WRITE
		const utxosStates = BlockUtils.buildUtxosStatesOfFinalizedBlock(block);
		const blockBytes = serializer.serialize.block(block);
		const utxosStatesBytes = serializer.serialize.utxosStatesArray(utxosStates);
		const previousOffset = block.index % this.batchSize === 0 ? null
			: this.#getOffsetOfBlockData(this.lastBlockIndex);
		const start = previousOffset ? previousOffset.start + previousOffset.blockBytes + previousOffset.utxosStatesBytes : 0;
		const indexesBytes = serializer.serialize.blockIndexEntry(start, blockBytes.length, utxosStatesBytes.length);
		
		// UPDATE INDEXES and BLOCKCHAIN FILE, do not use "appendFileSync" => cursor position issues
		const blockchainHandler = this.#getBlockchainHandler(block.index);
		this.idxsHandler.write(indexesBytes);
		blockchainHandler.write(blockBytes);
		blockchainHandler.write(utxosStatesBytes);
		this.lastBlockIndex++;
    }
    getBlockBytes(height = 0, includeUtxosStates = false) {
        if (height > this.lastBlockIndex) return null;

		const offset = this.#getOffsetOfBlockData(height);
		if (!offset) return null;

		const { start, blockBytes, utxosStatesBytes } = offset;
		const blockchainHandler = this.#getBlockchainHandler(height);
		const totalBytes = blockBytes + (includeUtxosStates ? utxosStatesBytes : 0);
		const bytes = blockchainHandler.read(start, totalBytes);
		return {
			blockBytes: includeUtxosStates ? bytes.subarray(0, blockBytes) : bytes,
			utxosStatesBytes: includeUtxosStates ? bytes.subarray(blockBytes) : null,
			blockchainHandler, offset
		}
    }
	/** @param {number} height @param {number[]} txIndexes */
    getTransactions(height, txIndexes) {
		if (height > this.lastBlockIndex) return null;

		const { blockBytes } = this.getBlockBytes(height, false) || {};
		if (blockBytes) return this.#extractTransactionsFromBlockBytes(blockBytes, txIndexes);
	}
	/** @param {TxId} txId */
	getTransaction(txId) {
		const { height, txIndex } = serializer.parseTxId(txId);
		const { blockBytes } = this.getBlockBytes(height, false) || {};
		if (!blockBytes) return null;

		const extracted = this.#extractTransactionsFromBlockBytes(blockBytes, [txIndex]);
		return extracted?.txs[txIndex] || null;
	}
	/** @param {TxAnchor[]} anchors @param {boolean} breakOnSpent Specify if the function should return null when a spent UTXO is found (early abort) */
	getUtxos(anchors, breakOnSpent = false) {
		/** Key: Anchor, value: UTXO @type {Object<string, UTXO>} */
		const utxos = {};
		const search = this.#getUtxosSearchPattern(anchors);
		for (const height of search.keys()) {
			if (height > this.lastBlockIndex) return null;

			const { blockBytes, utxosStatesBytes } = this.getBlockBytes(height, true) || {};
			if (!blockBytes || !utxosStatesBytes) return null;
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point
			const txIndexes = Array.from(search.get(height).keys());
			const txs = this.#extractTransactionsFromBlockBytes(blockBytes, txIndexes)?.txs;
			if (!txs) return null;

			const searchPattern = new Uint8Array(4); // Search pattern: [txIndex(2), voutId(2)]
			for (const txIndex of txIndexes) {
				searchPattern.set(serializer.voutIdEncoder.encode(txIndex), 0);
				
				// @ts-ignore: search.get(height).get(txIndex) can only contain valid voutIds at this point
				for (const voutIndex of search.get(height).get(txIndex)) {
					if (!txs[txIndex]?.outputs[voutIndex]) return null; // unable to find the referenced tx/output
					
					let utxoSpent = true;
					searchPattern.set(serializer.voutIdEncoder.encode(voutIndex), 2);
					const stateOffset = utxosStatesBytes.indexOf(searchPattern);
					if (stateOffset !== -1) utxoSpent = utxosStatesBytes[stateOffset + 4] === 1;
					if (utxoSpent && breakOnSpent) return null; // UTXO is spent

					const anchor = `${height}:${txIndex}:${voutIndex}`;
					const amount = txs[txIndex].outputs[voutIndex].amount;
					const rule = txs[txIndex].outputs[voutIndex].rule;
					const address = txs[txIndex].outputs[voutIndex].address;
					utxos[anchor] = new UTXO(anchor, amount, rule, address, utxoSpent);
				}
			}
		}

		return utxos;
	}
    undoBlock() {
        const offset = this.#getOffsetOfBlockData(this.lastBlockIndex);
		if (!offset) return false;

		// TRUNCATE INDEXES, AND BLOCKCHAIN FILE
		const blockchainHandler = this.#getBlockchainHandler(this.lastBlockIndex);
		blockchainHandler.truncate(offset.start);
		this.idxsHandler.truncate(this.lastBlockIndex * ENTRY_BYTES);
		this.lastBlockIndex--;
    }
	/** Ensure the blockchain file length matches the last indexed block offset, used at startup only */
	checkBlockchainBytesLengthConsistency() {
		const lastOffset = this.#getOffsetOfBlockData(this.lastBlockIndex);
		if (!lastOffset) throw new Error('Blockchain storage is corrupted: unable to retrieve last block offset.');

		const blockchainHandler = this.#getBlockchainHandler(this.lastBlockIndex);
		const stats = fs.fstatSync(blockchainHandler.fd);
		const expectedSize = lastOffset.start + lastOffset.blockBytes + lastOffset.utxosStatesBytes;
		return stats.size === expectedSize;
    }
    reset() {
        if (fs.existsSync(this.storage.PATH.BLOCKCHAIN)) fs.rmSync(this.storage.PATH.BLOCKCHAIN, { recursive: true });
        fs.mkdirSync(this.storage.PATH.BLOCKCHAIN);
        this.lastBlockIndex = -1;
    }

	// INTERNAL METHODS
	/** @param {TxAnchor[]} anchors */
	#consumeUtxos(anchors) {
		if (anchors.length === 0) return true;

		const u = new Uint8Array(1); u[0] = 1; // spent state
		const search = this.#getUtxosSearchPattern(anchors);
		for (const height of search.keys()) {
			if (height > this.lastBlockIndex) return false;

			const { blockBytes, utxosStatesBytes, blockchainHandler, offset } = this.getBlockBytes(height, true) || {};
			if (!blockBytes || !utxosStatesBytes || !blockchainHandler || !offset) return false;

			const utxosStatesBytesStart = offset.start + offset.blockBytes;
			const searchPattern = new Uint8Array(4); // Search pattern: [txIndex(2), voutId(2)]
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point
			for (const txIndex of search.get(height).keys()) {
				searchPattern.set(serializer.voutIdEncoder.encode(txIndex), 0);
				
				// @ts-ignore: search.get(height).get(txIndex) can only contain valid voutIds at this point
				for (const voutIndex of search.get(height).get(txIndex)) {
					searchPattern.set(serializer.voutIdEncoder.encode(voutIndex), 2);
					const stateOffset = utxosStatesBytes.indexOf(searchPattern);
					if (stateOffset === -1) throw new Error(`UTXO not found (anchor: ${height}:${txIndex}:${voutIndex})`);
					if (utxosStatesBytes[stateOffset + 4] === 1) throw new Error(`UTXO already spent (anchor: ${height}:${txIndex}:${voutIndex})`);
					
					// MARK UTXO AS SPENT
					blockchainHandler.write(u, utxosStatesBytesStart + stateOffset + 4);
				}
			}
		}

		return true;
	}
	/** @param {TxAnchor[]} anchors */
	#getUtxosSearchPattern(anchors) {
		// GROUP ANCHORS BY BLOCK HEIGHT
		/** height, Map(txindex, vout[]) @type {Map<number, Map<number, number[]>>} */
		const search = new Map();
		for (const p of anchors) {
			const { height, txIndex, vout } = serializer.parseAnchor(p);
			if (!search.has(height)) search.set(height, new Map());
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point, if not, we want the error to be thrown
			if (!search.get(height).has(txIndex)) search.get(height)?.set(txIndex, []);
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point, if not, we want the error to be thrown
			search.get(height).get(txIndex).push(vout);
		}
		return search;
	}
	#getOffsetOfBlockData(height = -1) { // if reading is too slow, we can implement a caching system here
		if (height < 0 || height > this.lastBlockIndex) return null;
		const buffer = this.idxsHandler.read(height * ENTRY_BYTES, ENTRY_BYTES);
		return serializer.deserialize.blockIndexEntry(buffer);
	}
	#getBlockchainHandler(height = 0) {
		const batchIndex = Math.floor(height / this.batchSize);
		if (this.bcHandlers[batchIndex] === undefined)
			this.bcHandlers[batchIndex] = new BinaryHandler(path.join(this.storage.PATH.BLOCKCHAIN, `blockchain-${batchIndex}.bin`));
		return this.bcHandlers[batchIndex];
	}
	/** @param {Uint8Array} blockBytes @param {number[]} txIndexes */
	#extractTransactionsFromBlockBytes(blockBytes, txIndexes) {
		/** key: txIndex, value: transaction @type {Object<number, Transaction>} */
		const txs = {};
		/** @type {Object<number, 'miner' | 'validator'>} */
		const specialMode = { 0: 'miner', 1: 'validator' }; // finalized block only
		const nbOfTxs = this.converter.bytes2ToNumber(blockBytes.subarray(0, 2));
		const timestampOffset = serializer.dataPositions.timestampInFinalizedBlock;
		const timestamp = this.converter.bytes6ToNumber(blockBytes.subarray(timestampOffset, timestampOffset + 6));
		for (const i of txIndexes) {
			if (txs[i] !== undefined) continue; // already extracted
			if (i + 1 > nbOfTxs) return null;

			const pointerStart = serializer.lengths.blockFinalizedHeader.bytes + (i * 4);
			const pointerBuffer = blockBytes.subarray(pointerStart, pointerStart + 4);
			const offsetStart = this.converter.bytes4ToNumber(pointerBuffer);
			const offsetEnd = i + 1 === nbOfTxs ? blockBytes.length
				: this.converter.bytes4ToNumber(blockBytes.subarray(pointerStart + 4, pointerStart + 8));
			const txBuffer = blockBytes.subarray(offsetStart, offsetEnd);
			const tx = serializer.deserialize.transaction(txBuffer, specialMode[i] || 'tx');
			txs[i] = tx;
		}
		return { txs, timestamp };
    }
}