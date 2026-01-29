// @ts-check
import fs from 'fs';
import path from 'path';
import { serializer } from '../utils/serializer.mjs';
import { BinaryHandler } from './binary-handler.mjs';

/**
 * @typedef {import('../types/transaction.mjs').TxAnchor} TxAnchor
 */

const ENTRY_BYTES = serializer.lengths.anchor.bytes;

export class VssStorage {
	storage;
	get logger() { return this.storage.miniLogger; }
	get stakesCount() { return this.vssHandler.size / ENTRY_BYTES; }

	/** VSS (vss.bin) handler @type {BinaryHandler} */
	vssHandler;

	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) {
		this.storage = storage;
		this.vssHandler = new BinaryHandler(path.join(this.storage.PATH.STORAGE, 'vss.bin'));
		if (this.vssHandler.size % ENTRY_BYTES !== 0) throw new Error(`vss.bin file is corrupted (size: ${this.vssHandler.size})`);
		this.logger.log(`VssStorage initialized with ${this.stakesCount} stakes`, (m, c) => console.info(m, c));
	}

	// API METHODS
	/** @param {TxAnchor} anchor */
	addStake(anchor) {
		const { height, txIndex, vout } = serializer.parseAnchor(anchor);
		this.vssHandler.cursor = this.vssHandler.size; // move to the end
		this.vssHandler.write(this.#anchorToBytes(anchor));
		this.logger.log(`Added stake: ${anchor} (height: ${height}, txIndex: ${txIndex}, vout: ${vout})`, (m, c) => console.info(m, c));
	}
	/** @param {TxAnchor[]} anchors */
	hasStakes(anchors) {
		const vssBytes = this.vssHandler.read(0, this.vssHandler.size);
		for (const anchor of anchors)
			if (vssBytes.indexOf(this.#anchorToBytes(anchor)) === -1) return false;
		return true;
	}
	/** @param {TxAnchor[]} anchors */
	removeStakes(anchors) {
		const vssBytes = this.vssHandler.read(0, this.vssHandler.size);

		// FIND OFFSETS OF ANCHORS TO REMOVE
		const offsets = [];
		for (const anchor of anchors) {
			const anchorBytes = this.#anchorToBytes(anchor);
			const offset = vssBytes.indexOf(anchorBytes);
			if (offset !== -1) offsets.push(offset);
		}

		// WRITE A TEMP FILE WITHOUT THE REMOVED ANCHORS
		const tempPath = path.join(this.storage.PATH.STORAGE, 'vss_temp.bin');
		const tempHandler = new BinaryHandler(tempPath);
		let readCursor = 0;
		for (const offset of offsets) {
			tempHandler.write(vssBytes.subarray(readCursor, offset));
			readCursor = offset + ENTRY_BYTES;
		}

		// WRITE REMAINING BYTES
		if (readCursor < vssBytes.length) tempHandler.write(vssBytes.subarray(readCursor));

		// REPLACE ORIGINAL FILE
		tempHandler.close();
		this.vssHandler.close();
		fs.renameSync(tempPath, path.join(this.storage.PATH.STORAGE, 'vss.bin'));
		this.vssHandler = new BinaryHandler(path.join(this.storage.PATH.STORAGE, 'vss.bin'));
		this.logger.log(`Removed ${anchors.length} stakes`, (m, c) => console.info(m, c));
	}
	/** @param {number} index */
	getStakeAnchor(index) {
		if (index < 0 || index >= this.stakesCount) return null;
		const bytes = this.vssHandler.read(index * ENTRY_BYTES, ENTRY_BYTES);
		return this.#bytesToAnchor(bytes);
	}
	reset() {
		this.vssHandler.close();
		fs.unlinkSync(path.join(this.storage.PATH.STORAGE, 'vss.bin'));
		this.vssHandler = new BinaryHandler(path.join(this.storage.PATH.STORAGE, 'vss.bin'));
		this.logger.log('VssStorage reset complete', (m, c) => console.info(m, c));
	}

	// INTERNAL METHODS
	/** @param {TxAnchor} anchor */
	#anchorToBytes(anchor) {
		const { height, txIndex, vout } = serializer.parseAnchor(anchor);
		const b = new Uint8Array(ENTRY_BYTES);
		b.set(serializer.converter.numberTo4Bytes(height), 0);
		b.set(serializer.voutIdEncoder.encode(txIndex), 4);
		b.set(serializer.voutIdEncoder.encode(vout), 6);
		return b;
	}
	/** @param {Uint8Array} bytes */
	#bytesToAnchor(bytes) {
		const height = serializer.converter.bytes4ToNumber(bytes.slice(0, 4));
		const txIndex = serializer.voutIdEncoder.decode(bytes.slice(4, 6));
		const vout = serializer.voutIdEncoder.decode(bytes.slice(6, 8));
		return `${height}:${txIndex}:${vout}`;
	}
}