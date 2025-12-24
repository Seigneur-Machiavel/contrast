// @ts-check
import fs from 'fs';
import path from 'path';
import { ADDRESS } from '../types/address.mjs';
import { BinaryHandler } from './binary-handler.mjs';
import { serializer, BinaryReader, BinaryWriter } from '../utils/serializer.mjs';

/** 
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("./bc-store.mjs").BlockchainStorage} BlockchainStorage */

const ENTRY_BYTES = serializer.lengths.txId.bytes;
const MAX_ENTRIES_PER_FILE = 0xFFFFFFFF + 1; // 2^32

export class IdentityStore {
	/** The identities file handles by prefix @type {Object<string, BinaryHandler>} */
	handlers = {};
	bcStorage;
	basePath;

	/** @param {BlockchainStorage} blockchainStorage */
	constructor(blockchainStorage) {
		this.bcStorage = blockchainStorage;
		this.basePath = blockchainStorage.storage.PATH.IDENTITIES;

		for (const prefix of ADDRESS.AUTHORIZED_PREFIXES)
			if (this.handlers[prefix]) continue;
			else this.#createHandlerForPrefix(prefix);
	}

	/** Create the new identities entries for the addresses involved in the block (pointers)
	 * @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs */
	digestBlock(block, involvedUTXOs) {
		// Starting from txIndex = 1 to skip coinbase
		const treatedAddresses = new Set();
		const discoveryAddresses = [];
		for (let txIndex = 1; txIndex < block.Txs.length; txIndex++)
			for (const input of block.Txs[txIndex].inputs) {
				const address = txIndex === 1 // validator tx
					? input.split(':')[0] // Validator: address is in the input
					: involvedUTXOs[input]?.address; // Normal tx: address is in the UTXO

				if (!address) throw new Error(`Unable to find address to verify for input: ${input}`);
				if (treatedAddresses.has(address)) continue;

				treatedAddresses.add(address); // Mark as treated
				if (this.get(address)) continue; // EXISTING => SKIP

				// NEW IDENTITY => REGISTER
				this.#register(address, `${block.index}:${txIndex}`);
				discoveryAddresses.push(address);
			}
		
		return discoveryAddresses;
	}
	/** Return the pubkeys associated with an address @param {string} address */
	get(address) {
		if (!ADDRESS.checkConformity(address)) return null;

		// READ ENTRY
		const a = ADDRESS.fromString(address);
		const handler = this.handlers[a.prefix];
		const entryBytes = handler.read(a.uint32 * ENTRY_BYTES, ENTRY_BYTES);
		if (entryBytes.every(b => b === 0)) return null; // EMPTY ENTRY

		// RETRIEVE TX
		const blockIndex = serializer.converter.bytes4ToNumber(entryBytes.subarray(0, 4));
		const txIndex = serializer.converter.bytes2ToNumber(entryBytes.subarray(4, 6));
		const tx = this.bcStorage.getTransaction(`${blockIndex}:${txIndex}`);
		if (!tx) throw new Error(`IdentityStore.get: unable to retrieve transaction at ${blockIndex}:${txIndex} for address ${address}`);

		// EXTRACT PUBKEYS
		/** @type {Set<string>} */
		const pubKeys = new Set();
		for (const w of tx.witnesses) pubKeys.add(w.split(':')[1]);
		return pubKeys;
	}
	reset() {
		if (fs.existsSync(this.basePath)) fs.rmSync(this.basePath, { recursive: true });
		fs.mkdirSync(this.basePath);

		for (const prefix of ADDRESS.AUTHORIZED_PREFIXES)
			if (this.handlers[prefix]) continue;
			else this.#createHandlerForPrefix(prefix);
	}

	// INTERNAL METHODS
	/** @param {string} address @param {TxId} txId */
	#register(address, txId) {
		if (!ADDRESS.checkConformity(address)) throw new Error(`IdentityStore.register: invalid address format: ${address}`);
		const a = ADDRESS.fromString(address);
		const handler = this.handlers[a.prefix];
		const entryBytes = serializer.serialize.txsIdsArray([txId]);
		handler.write(entryBytes, a.uint32 * ENTRY_BYTES);
	}
	#createHandlerForPrefix(prefix = 'C') {
		if (this.handlers[prefix]) this.handlers[prefix].close();
		
		// OPEN OR CREATE FILE
		const filePath = path.join(this.basePath, `${prefix}.dat`);
		this.handlers[prefix] = new BinaryHandler(filePath);
		if (this.handlers[prefix].size === MAX_ENTRIES_PER_FILE * ENTRY_BYTES) return; // READY

		// CREATE EMPTY FILE OF MAX SIZE (VERY FAST)
		this.handlers[prefix].truncate(MAX_ENTRIES_PER_FILE * ENTRY_BYTES); // 24GB FILE
		this.handlers[prefix].close();
		this.handlers[prefix] = new BinaryHandler(filePath);
		if (this.handlers[prefix].size !== MAX_ENTRIES_PER_FILE * ENTRY_BYTES) throw new Error('IdentityStore.init: unable to create identity store file of correct size.');
	}
}