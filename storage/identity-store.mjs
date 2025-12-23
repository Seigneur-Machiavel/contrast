// @ts-check
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
	}

	// API METHODS
	/** Initialize the identity store files and handlers @param {import("../node/src/node.mjs").ContrastNode} node */
	async init(node) {
		const chunkSize = 2 ** 30;
		const buffer = new Uint8Array(chunkSize);
		const batchCount = MAX_ENTRIES_PER_FILE * ENTRY_BYTES / chunkSize;
		for (const prefix of ADDRESS.AUTHORIZED_PREFIXES) {
			if (this.handlers[prefix]) continue;
			
			const filePath = path.join(this.basePath, `${prefix}.dat`);
			this.handlers[prefix] = new BinaryHandler(filePath);
			if (this.handlers[prefix].size === MAX_ENTRIES_PER_FILE * ENTRY_BYTES) continue; // READY
			
			// WRITE "0" IN FILE BY BUFFER OR 1GB CHUNKS. (1_073_741_824 bytes = 1 GB)
			// 24GB FILE WRITING TOOK 23s ON SSD
			this.handlers[prefix].cursor = 0; // RESET CURSOR
			const creationStart = Date.now();
			for (let i = 0; i < batchCount; i++) {
				const stateText = `IdentityStore: creating identity store for prefix '${prefix}' (${i + 1}/${batchCount}) ...`;
				node.updateState(stateText);
				this.bcStorage.logger.log(stateText, (m, c) => console.log(m, c));

				this.handlers[prefix].write(buffer);
				await new Promise(r => setImmediate(r)); // Yield to event loop
			}

			this.bcStorage.logger.log(`IdentityStore: created identity store for prefix '${prefix}' at: ${filePath} in ${Date.now() - creationStart}ms`, (m, c) => console.log(m, c));
		}
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

	// INTERNAL METHODS
	/** @param {string} address @param {TxId} txId */
	#register(address, txId) {
		if (!ADDRESS.checkConformity(address)) throw new Error(`IdentityStore.register: invalid address format: ${address}`);
		const a = ADDRESS.fromString(address);
		const handler = this.handlers[a.prefix];
		const entryBytes = serializer.serialize.txsIdsArray([txId]);
		handler.write(entryBytes, a.uint32 * ENTRY_BYTES);
	}
}