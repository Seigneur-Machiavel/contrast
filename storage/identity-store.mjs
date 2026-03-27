// @ts-check
import fs from 'fs';
import path from 'path';
import { ADDRESS } from '../types/address.mjs';
import { BinaryHandler } from './binary-handler.mjs';
import { serializer, SIZES } from '../utils/serializer.mjs';

/** 
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("./bc-store.mjs").BlockchainStorage} BlockchainStorage */


const ENTRY_BYTES = SIZES.txId.bytes;
const MAX_ENTRIES_PER_FILE = (0xFFFFFFFF + 1) / 8; // 2^32 / 8 = 536,870,912 entries per file (8 files per prefix)
const MAX_BYTES_PER_FILE = MAX_ENTRIES_PER_FILE * ENTRY_BYTES; // 24GB / 8 = 3GB per file

/** Build identity entry, ex: [address: 5b][nb_pubkeys: 1b][threshold: 1b][pubkey x nb_pubkeys: 32b each]
 * @param {string} address @param {string[]} pubKeysHex @param {number} [threshold] number of required signatures for multi-sig */
export function buildIdentityEntry(address, pubKeysHex, threshold = 1) {
	const a = ADDRESS.fromString(address);
	if (!a.isMultiSig && pubKeysHex.length > 1) throw new Error(`IdentityRecordInterpreter.buildEntry: non multi-sig address ${address} cannot have multiple pubkeys`);
	if (!a.isMultiSig && threshold !== 1) throw new Error(`IdentityRecordInterpreter.buildEntry: non multi-sig address ${address} cannot have threshold different from 1`);
	if (threshold < 1) throw new Error(`IdentityRecordInterpreter.buildEntry: threshold must be at least 1 for address ${address}`);
	if (pubKeysHex.length === 0) throw new Error(`IdentityRecordInterpreter.buildEntry: at least one pubkey is required for address ${address}`);
	if (pubKeysHex.length > 255) throw new Error(`IdentityRecordInterpreter.buildEntry: maximum number of pubkeys is 255 for address ${address}`);
	if (threshold > 255) throw new Error(`IdentityRecordInterpreter.buildEntry: threshold cannot be higher than 255`);
	for (const pk of pubKeysHex) if (pk.length !== SIZES.pubKey.str) throw new Error(`IdentityRecordInterpreter.buildEntry: invalid pubkey length for pubkey ${pk} in address ${address}`);

	return serializer.serialize.identityEntry(a, pubKeysHex, threshold); // throws if non conform
}
/** Find and parse the identity entry in the data field of a transaction for a given address, throws if non conform or not found
 * @param {Uint8Array | undefined} data @param {string} address */
export function findAndParseEntry(data, address, throwIfNot = true) {
	try {
		if (!data) throw new Error(`IdentityRecordInterpreter.findAndParseEntry: no data to parse for address ${address}`);

		const a = ADDRESS.fromString(address);
		const index = Buffer.from(data).indexOf(a.bytes); // use C++ indexOf() to find the address bytes
		if (index === -1) throw new Error(`IdentityRecordInterpreter.findAndParseEntry: no identity entry found in data for address ${address}`);

		const nbOfPubKeys = data[index + 5];
		const entryBytesLength = 5 + 1 + 1 + nbOfPubKeys * SIZES.pubKey.bytes;
		if (index + entryBytesLength > data.length) throw new Error(`IdentityRecordInterpreter.findAndParseEntry: non conform identity entry for address ${address} - not enough data for the declared number of pubkeys`);
		
		const entryBytes = data.subarray(index, index + entryBytesLength);
		const identity = serializer.deserialize.identityEntry(entryBytes);
		return identity;
	} catch (error) {
		if (throwIfNot) throw error;
		return null; // NOT FOUND (non conform entry)
	}
}

export class IdentityStore {
	static buildEntry = buildIdentityEntry;
	buildIdentityEntry = buildIdentityEntry;
	static findAndParseEntry = findAndParseEntry;
	findAndParseEntry = findAndParseEntry;

	/** The identities file handles by identifier @type {Object<string, BinaryHandler>} */
	handlers = {};
	bcStorage;
	basePath;
	
	/** @param {BlockchainStorage} blockchainStorage */
	constructor(blockchainStorage) {
		this.bcStorage = blockchainStorage;
		this.basePath = blockchainStorage.storage.PATH.IDENTITIES;
	}

	/** Return the pubkeys associated with an address @param {string} address */
	getIdentity(address) {
		if (!ADDRESS.checkConformity(address)) return null;

		// RETRIEVE POINTER
		const pointer = this.#getPointer(address);
		if (!pointer) return null; // UNKNOWN ADDRESS

		// RETRIEVE TX AND PARSE IDENTITY ENTRY ASSOCIATED WITH THE ADDRESS
		const { blockIndex, txIndex } = pointer;
		const data = this.bcStorage.getTransactionData(blockIndex, txIndex);
		if (!data) throw new Error(`IdentityStore.get: no data found for transaction at ${blockIndex}:${txIndex} for address ${address} - unable to resolve identity`);

		return findAndParseEntry(data, address);
	}
	/** Lookup at the store to resolve identity, helper to know if we needs to include reservation data in transaction.
	 * - 'UNKNOWN' if the address is not known in the store (no pointer, no entry)
	 * - 'MISMATCH' if the address is known but the pubkey(s) do not match the entry
	 * - 'MATCH' if the address is known and the pubkey(s) match the entry
	 * @param {string} address @param {string[]} pubKeysHex */
	resolveIdentity(address, pubKeysHex) {
		const parsedEntry = this.getIdentity(address);
		if (!parsedEntry) return 'UNKNOWN';

		if (parsedEntry.pubKeysHex.length !== pubKeysHex.length) return 'MISMATCH';
		for (const pk of parsedEntry.pubKeysHex) if (!pubKeysHex.includes(pk)) return 'MISMATCH';
		return 'MATCH';
	}
	/** Create the new identities entries for the addresses involved in the block (pointers) @param {BlockFinalized} block */
	digestBlock(block) {
		const discovery = this.#extractDiscovery(block).discovery;
		for (const [address, txIndex] of discovery) this.#register(address, block.index, txIndex);
		return discovery;
	}
	/** Undo the identities entries for the addresses involved in the block (pointers) @param {BlockFinalized} block */
	revertBlock(block) {
		const { discovery, known } = this.#extractDiscovery(block);
		if (discovery.size > 0) throw new Error(`IdentityStore.revertBlock: corrupted state - found ${discovery.size} unregistered identities in block ${block.index} (should be empty)`);

		for (const [address, blockIndex] of known)
			if (blockIndex === block.index) this.#unregister(address);
	}
	reset() {
		for (const identifier in this.handlers) this.handlers[identifier].close();
		this.handlers = {};

		if (fs.existsSync(this.basePath)) fs.rmSync(this.basePath, { recursive: true });
		fs.mkdirSync(this.basePath);
	}

	// INTERNAL METHODS
	/** Extract discovery information from block @param {BlockFinalized} block */
	#extractDiscovery(block) {
		/** Key: address, value: TxIndex @type {Map<string, number>} */
		const discovery = new Map();
		/** Key: address, value: blockIndex @type {Map<string, number>} */
		const known = new Map();

		// OUTPUTS SCAN (IDENTITIES DISCOVERY)
		for (let txIndex = 0; txIndex < block.Txs.length; txIndex++) {
			for (const output of block.Txs[txIndex].outputs) {
				const address = output.address;
				if (discovery.has(address) || known.has(address)) continue;
	
				const pointer = this.#getPointer(address);
				if (pointer) known.set(address, pointer.blockIndex);
				else discovery.set(address, txIndex);
			}
		}
		
		return { discovery, known };
	}
	/** Return the pointer for an address @param {string} address */
	#getPointer(address) { // READ ENTRY
		const a = ADDRESS.fromString(address);
		const handler = this.#getHandler(a);
		const offset = (a.uint32 % MAX_ENTRIES_PER_FILE) * ENTRY_BYTES;
		const entryBytes = handler.read(offset, ENTRY_BYTES);
		if (entryBytes.every(b => b === 0)) return null; // EMPTY ENTRY

		const blockIndex = serializer.converter.bytes4ToNumber(entryBytes.subarray(0, 4));
		const txIndex = serializer.nonZeroUint16.decode(entryBytes.subarray(4, 6));
		return { blockIndex, txIndex };
	}
	/** Write the pointer for an address @param {string} address @param {number} blockIndex @param {number} txIndex */
	#register(address, blockIndex, txIndex) { // WRITE ENTRY
		if (!ADDRESS.checkConformity(address)) throw new Error(`IdentityStore.register: invalid address format: ${address}`);
		const a = ADDRESS.fromString(address);
		const handler = this.#getHandler(a);
		const entryBytes = new Uint8Array(ENTRY_BYTES);
		entryBytes.set(serializer.converter.numberTo4Bytes(blockIndex), 0);
		entryBytes.set(serializer.nonZeroUint16.encode(txIndex), 4);

		const offset = (a.uint32 % MAX_ENTRIES_PER_FILE) * ENTRY_BYTES;
		handler.write(entryBytes, offset);
		//console.log(`[REGISTER] Address ${address} - ${a.uint32} - #${offset} - pointer set to ${txId}.`);
	}
	/** Write an empty pointer for an address @param {string} address */
	#unregister(address) { // WRITE EMPTY ENTRY
		if (!ADDRESS.checkConformity(address)) throw new Error(`IdentityStore.unregister: invalid address format: ${address}`);
		const a = ADDRESS.fromString(address);
		const handler = this.#getHandler(a);
		const offset = (a.uint32 % MAX_ENTRIES_PER_FILE) * ENTRY_BYTES;
		handler.write(new Uint8Array(ENTRY_BYTES), offset);
		//console.warn(`[UNREGISTER] Address ${address} - ${a.uint32} - #${offset} - entry cleared.`);
	}
	/** @param {ADDRESS} a */
	#getHandler(a) {
		// Divide in 8 files per prefix (uint32 max value is 4,294,967,295 => 8 files of 536,870,912 entries each)
		const identifier = `${a.prefix}-${Math.floor(a.uint32 / MAX_ENTRIES_PER_FILE)}`;
		if (this.handlers[identifier]) return this.handlers[identifier];
		
		// OPEN AND CONTROL FILE
		const filePath = path.join(this.basePath, `${identifier}.bin`);
		this.handlers[identifier] = new BinaryHandler(filePath);

		if (this.handlers[identifier].size !== MAX_BYTES_PER_FILE) {
			// CREATE EMPTY FILE OF MAX SIZE (VERY FAST)
			this.handlers[identifier].truncate(MAX_BYTES_PER_FILE); // ~3GB
			this.handlers[identifier].preallocate(MAX_BYTES_PER_FILE); // pre-touch pages to force physical allocation and avoid slow writes later on when the OS needs to allocate pages on the fly (which can cause huge latency spikes for the write that triggers it)
		}
		
		if (this.handlers[identifier].size !== MAX_BYTES_PER_FILE) throw new Error('IdentityStore.init: unable to create identity store file of correct size.');
		return this.handlers[identifier]; // READY
	}
}