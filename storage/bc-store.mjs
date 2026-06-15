// @ts-check
import fs from 'fs';
import path from 'path';
import HiveP2P from "hive-p2p";
import { BinaryHandler } from './binary-handler.mjs';
import { BLOCK, BlockFinalizedHeader } from '../types/block.mjs';
import { TransactionReader, UTXO } from '../types/transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from '../config/blockchain-settings.mjs';
import { BinaryReader, serializer, SIZES } from '../utils/serializer.mjs';

/**
 * @typedef {import("hive-p2p").Converter} Converter
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/transaction.mjs").VoutId} VoutId
 * @typedef {import("../types/transaction.mjs").TxAnchor} TxAnchor
 * @typedef {import("../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized */

const ENTRY_BYTES = SIZES.indexEntry.bytes;

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
    store(block, involvedAnchors) {
		if (block.index !== this.lastBlockIndex + 1) throw new Error(`Block index mismatch: expected ${this.lastBlockIndex + 1}, got ${block.index}`);

		// PREPARE DATA TO WRITE
		const previousOffset = block.index % this.batchSize === 0 ? null
		: this.#getOffsetOfBlockData(this.lastBlockIndex);
		const start = previousOffset ? previousOffset.start + previousOffset.blockBytes + previousOffset.utxosStatesBytes : 0;
		const blockBytes = serializer.serialize.block(block, 'finalized');
		const utxosStatesBytes = serializer.serialize.utxosStatesOfBlock(block);
		const indexesBytes = serializer.serialize.blockIndexEntry(start, blockBytes.length, utxosStatesBytes.length);
		
		// UPDATE INDEXES and BLOCKCHAIN FILE, do not use "appendFileSync" => cursor position issues
		const blockchainHandler = this.#getBlockchainHandler(block.index);
		this.idxsHandler.write(indexesBytes);
		blockchainHandler.write(blockBytes);
		blockchainHandler.write(utxosStatesBytes);

		// MARK UTXOS AS SPENT
		if (!this.#digestUtxos(involvedAnchors, 'consume')) throw new Error('Unable to consume UTXOs for the new block');
		this.lastBlockIndex++;
    }
    getBlockBytes(height = 0, includeUtxosStates = false) {
        if (height < 0 || height > this.lastBlockIndex) return null;

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
		if (!blockBytes) return null;

		const { txsBytes, timestamp } = this.#extractTransactionsBytesFromBlockBytes(blockBytes, txIndexes) || {};
		if (!txsBytes || !timestamp) return null;

		const txs = [];
		for (const txIndex in txsBytes)
			txs.push(serializer.deserialize.transaction(txsBytes[txIndex], txIndex === '0' ? 'solver' : txIndex === '1' ? 'validator' : 'tx'));

		return { txs, timestamp};
	}
	/** @param {TxId[]} txIds */
	getTransactionsByIds(txIds) {
		// Sort request by block height to minimize disk reads
		/** @type {Map<number, number[]>} */
		const txIdByHeight = new Map();
		for (const txId of txIds) {
			const { height, txIndex } = serializer.parseTxId(txId);
			if (!txIdByHeight.has(height)) txIdByHeight.set(height, []); // @ts-ignore
			txIdByHeight.get(height).push(txIndex);
		}

		/** key: txId, value: transaction @type {Record<TxId, Transaction>} */
		const transactions = {};
		for (const [height, txIndexes] of txIdByHeight.entries()) {
			const { txs, timestamp } = this.getTransactions(height, txIndexes) || {};
			if (!txs || txs.length !== txIndexes.length) return null;

			for (let i = 0; i < txIndexes.length; i++)
				transactions[`${height}:${txIndexes[i]}`] = txs[i];
		}

		return transactions;
	}
	/** @param {number} height @param {number[]} txIndexes */
	getSerializedTransactions(height, txIndexes) {
		const { blockBytes } = this.getBlockBytes(height, false) || {};
		if (!blockBytes) return null;

		return this.#extractTransactionsBytesFromBlockBytes(blockBytes, txIndexes);
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
			const serializedTxs = this.#extractTransactionsBytesFromBlockBytes(blockBytes, txIndexes)?.txsBytes;
			if (!serializedTxs) return null;

			const searchPattern = new Uint8Array(4); // Search pattern: [txIndex(2), voutId(2)]
			for (const txIndex of txIndexes) {
				const mode = txIndex === 0 ? 'solver' : txIndex === 1 ? 'validator' : 'tx';
				const outputs = new TransactionReader(serializedTxs[txIndex], mode).getOutputs();
				searchPattern.set(serializer.nonZeroUint16.encode(txIndex), 0);
				
				// @ts-ignore: search.get(height).get(txIndex) can only contain valid voutIds at this point
				for (const voutIndex of search.get(height).get(txIndex)) {
					if (!outputs[voutIndex]) return null; // unable to find the referenced tx/output

					let utxoSpent = true;
					searchPattern.set(serializer.nonZeroUint16.encode(voutIndex), 2);

					const stateOffset = utxosStatesBytes.indexOf(searchPattern);
					if (stateOffset !== -1) utxoSpent = utxosStatesBytes[stateOffset + 4] === 1;
					if (utxoSpent && breakOnSpent) return null; // UTXO is spent

					const anchor = `${height}:${txIndex}:${voutIndex}`;
					const amount = outputs[voutIndex].amount;
					const rule = outputs[voutIndex].rule;
					const address = outputs[voutIndex].address;
					utxos[anchor] = new UTXO(anchor, amount, rule, address, utxoSpent);
				}
			}
		}

		return utxos;
	}
	getSerializedBlocksHeaders(fromHeight = this.lastBlockIndex - 1, toHeight = this.lastBlockIndex) {
		if (fromHeight < 0 || toHeight > this.lastBlockIndex || fromHeight > toHeight) return null;
		if (toHeight - fromHeight > 120) return null; // limit to 120 blocks at a time

		const offsets = this.#getOffsetsOfRangeOfBlocksData(fromHeight, toHeight);
		if (!offsets) return null;

		/** @type {Uint8Array[]} */ const headers = [];
		for (let h = fromHeight; h <= toHeight; h++)
			headers.push(this.#getBlockchainHandler(h).read(offsets[h].start, SIZES.blockFinalizedHeader.bytes));
		return headers;
	}
	getBlocksHeaders(fromHeight = this.lastBlockIndex - 1, toHeight = this.lastBlockIndex) {
		const serializedHeaders = this.getSerializedBlocksHeaders(fromHeight, toHeight);
		if (!serializedHeaders) return null;

		/** @type {BlockFinalizedHeader[]} */ const headers = [];
		for (const headerBuffer of serializedHeaders) {
			const r = new BinaryReader(headerBuffer);
			const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce } = serializer.deserialize.blockHeader(r, 'finalized');
			if (!timestamp || !hash || !nonce) throw new Error(`Corrupted block header`);
			headers.push(new BlockFinalizedHeader(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce));
		}
		return headers;
	}
	/** Undo the last block added to the blockchain @param {TxAnchor[]} [involvedAnchors] If missing: will erase block without restoring UTXOs */
    unstore(involvedAnchors) {
        const offset = this.#getOffsetOfBlockData(this.lastBlockIndex);
		if (!offset) throw new Error('Blockchain.undoBlock: unable to retrieve last block offset.');

		// RESTORE UTXOs TO UNSPENT
		if (involvedAnchors && !this.#digestUtxos(involvedAnchors, 'restore')) throw new Error('Unable to restore UTXOs for the undone block');
		if (offset.start < 0) throw new Error('Blockchain.undoBlock: invalid block offset.');

		// TRUNCATE BLOCKCHAIN AND INDEXES FILE
		const blockchainHandler = this.#getBlockchainHandler(this.lastBlockIndex);
		blockchainHandler.truncate(offset.start);

		const idxOffsetStart = this.lastBlockIndex * ENTRY_BYTES;
		this.idxsHandler.truncate(idxOffsetStart);
		this.lastBlockIndex--;
    }
	/** Ensure the blockchain file length matches the last indexed block offset, used at startup only */
	checkBlockchainBytesLengthConsistency() {
		const lastOffset = this.#getOffsetOfBlockData(this.lastBlockIndex);
		if (!lastOffset) throw new Error('Blockchain storage is corrupted: unable to retrieve last block offset.');
		if (lastOffset.start < 0) throw new Error('Blockchain storage is corrupted: invalid last block offset.');

		const blockchainHandler = this.#getBlockchainHandler(this.lastBlockIndex);
		const stats = fs.fstatSync(blockchainHandler.fd);
		const expectedSize = lastOffset.start + lastOffset.blockBytes + lastOffset.utxosStatesBytes;
		return stats.size === expectedSize;
    }
    reset() {
		for (const index in this.bcHandlers) this.bcHandlers[index].close();
		this.idxsHandler.close();
		this.bcHandlers = {};
		
        if (fs.existsSync(this.storage.PATH.BLOCKCHAIN)) fs.rmSync(this.storage.PATH.BLOCKCHAIN, { recursive: true });
        fs.mkdirSync(this.storage.PATH.BLOCKCHAIN);

        this.lastBlockIndex = -1;
		this.idxsHandler = new BinaryHandler(path.join(this.storage.PATH.BLOCKCHAIN, 'blockchain.idx'));
    }

	// INTERNAL METHODS
	#getBlockchainHandler(height = 0) {
		const batchIndex = Math.floor(height / this.batchSize);
		if (this.bcHandlers[batchIndex] === undefined)
			this.bcHandlers[batchIndex] = new BinaryHandler(path.join(this.storage.PATH.BLOCKCHAIN, `blockchain-${batchIndex}.bin`));
		return this.bcHandlers[batchIndex];
	}
	/** @param {TxAnchor[]} anchors @param {'consume' | 'restore'} mode Default: 'consume' */
	#digestUtxos(anchors, mode = 'consume') {
		if (anchors.length === 0) return true;

		const m = mode === 'consume' ? 1 : 0;
		const u = new Uint8Array(1); u[0] = m;
		const search = this.#getUtxosSearchPattern(anchors);
		for (const height of search.keys()) {
			if (height > this.lastBlockIndex) return false;

			const { blockBytes, utxosStatesBytes, blockchainHandler, offset } = this.getBlockBytes(height, true) || {};
			if (!blockBytes || !utxosStatesBytes || !blockchainHandler || !offset) return false;

			const utxosStatesBytesStart = offset.start + offset.blockBytes;
			const searchPattern = new Uint8Array(4); // Search pattern: [txIndex(2), voutId(2)]
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point
			for (const txIndex of search.get(height).keys()) {
				searchPattern.set(serializer.nonZeroUint16.encode(txIndex), 0);
				
				// @ts-ignore: search.get(height).get(txIndex) can only contain valid voutIds at this point
				for (const voutIndex of search.get(height).get(txIndex)) {
					searchPattern.set(serializer.nonZeroUint16.encode(voutIndex), 2);
					const stateOffset = utxosStatesBytes.indexOf(searchPattern);
					if (stateOffset === -1) throw new Error(`UTXO not found (anchor: ${height}:${txIndex}:${voutIndex})`);

					// CHECK CURRENT STATE
					const state = utxosStatesBytes[stateOffset + 4];
					if (state === m) throw new Error(`UTXO already ${m ? 'spent' : 'restored'} (anchor: ${height}:${txIndex}:${voutIndex})`);

					// MARK UTXO AS SPENT OR RESTORED
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
	/** Optimized version to get offsets of a range of blocks data => one disk read only */
	#getOffsetsOfRangeOfBlocksData(fromHeight = 0, toHeight = 0) {
		if (fromHeight < 0 || toHeight > this.lastBlockIndex || fromHeight > toHeight) return null;
		/** @type {Object<number, {start: number, blockBytes: number, utxosStatesBytes: number}>} */
		const offsets = {};
		const nbOfEntries = toHeight - fromHeight + 1;
		const buffer = this.idxsHandler.read(fromHeight * ENTRY_BYTES, nbOfEntries * ENTRY_BYTES);
		for (let i = 0; i < nbOfEntries; i++) {
			const entryBuffer = buffer.subarray(i * ENTRY_BYTES, (i + 1) * ENTRY_BYTES);
			offsets[i + fromHeight] = serializer.deserialize.blockIndexEntry(entryBuffer);
		}
		return offsets;
	}
	/** @param {Buffer} blockBytes @param {number[]} txIndexes */
	#extractTransactionsBytesFromBlockBytes(blockBytes, txIndexes) {
		/** key: txIndex, value: transaction @type {Object<number, Uint8Array>} */
		const txsBytes = {};
		const timestampOffset = serializer.dataPositions.timestampInFinalizedBlock;
		const timestamp = this.converter.bytes6ToNumber(blockBytes.subarray(timestampOffset, timestampOffset + 6));
		const nbOfTxs = this.converter.bytes2ToNumber(blockBytes.subarray(0, 2));
		const pointerSectionlength = BinaryReader.calculatePointersSize(nbOfTxs, 'pointer32');
		const pointersBytes = blockBytes.subarray(SIZES.blockFinalizedHeader.bytes, SIZES.blockFinalizedHeader.bytes + pointerSectionlength);
		const r = new BinaryReader(pointersBytes);
		const { pointers, endOfLastDataChunk } = r.readPointers('pointer32');
		for (const i of txIndexes) {
			if (txsBytes[i] !== undefined) continue; // already extracted
			if (i + 1 > nbOfTxs) return null;

			const offsetStart = pointers[i];
			const offsetEnd = i + 1 !== nbOfTxs ? pointers[i + 1] : endOfLastDataChunk;
			const txBytes = blockBytes.subarray(offsetStart, offsetEnd);
			txsBytes[i] = new Uint8Array(txBytes);
		}

		return { txsBytes, timestamp };
	}
}