// @ts-check
import fs, { read } from 'fs';
import path from 'path';
import { ADDRESS } from '../types/address.mjs';
import { BinaryHandler } from './binary-handler.mjs';
import { QsafeHelper } from '../node/src/conCrypto.mjs';
import { BLOCKCHAIN_SETTINGS } from '../config/blockchain-settings.mjs';
import { BinaryReader, serializer, SIZES } from '../utils/serializer.mjs';

/** 
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("./bc-store.mjs").BlockchainStorage} BlockchainStorage */

// Each wallet has 1 pubKey, who 9 adresses are attributed to.
// 256^4b = 4 294 967 296 entries * 9 = 38 654 705 664 adresses.
// 58^6 = 38 068 692 544 adresses => The real limit of adresses imposed by b58 encoding.
// 4 294 967 296 * 7b = 30 064 771 072 bytes = ~30GB for the whole file in the worst case (all addresses created).

const ENTRY_BYTES = SIZES.stamp.bytes; // blockIndex(4b):txIndex(2b):identityIndex(1b)> (total: 7b)

/** Build identity entry, used to declare/record the pubkey(s) associated with an address in the identities filed of a transaction, to be retrieved later for identity resolution.
 * @param {string[]} pubKeysHex @param {number} [threshold] (1b) number of required signatures for multi-sig */
export function buildEntry(pubKeysHex, threshold = 1) {
	if (threshold < 1) throw new Error(`buildEntry(): threshold must be at least 1`);
	if (pubKeysHex.length === 0) throw new Error(`buildEntry(): at least one pubkey is required`);
	if (pubKeysHex.length > BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig) throw new Error(`buildEntry(): maximum number of pubkeys is ${BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig}`);
	if (threshold > 255) throw new Error(`buildEntry(): threshold cannot be higher than 255`);
	
	for (const pk of pubKeysHex)
		if (!QsafeHelper.checkFormat(serializer.converter.hexToBytes(pk)))
			throw new Error(`buildEntry(): invalid pubkey ${serializer.converter.hexToBytes(pk)}`);

	return serializer.serialize.identityEntry(threshold, pubKeysHex); // throws if non conform
}

export class IdentityStore {
	buildEntry = buildEntry;

	/** The identities file handles by prefix @type {Object<string, BinaryHandler>} */
	handlers = {};
	bcStorage;
	basePath;
	
	/** @param {BlockchainStorage} blockchainStorage */
	constructor(blockchainStorage) {
		this.bcStorage = blockchainStorage;
		this.basePath = blockchainStorage.storage.PATH.IDENTITIES;
	}

	/** Generate the next 9 addresseses to create based on the number of entries already in the file for the given prefix. */
	nextRootAddressToCreate(prefix = 'C', count = 1) {
		/** @type {string[]} */
		const rootAddresses = [];
		const handler = this.#getHandler(prefix);
		const ADDRESSES_PER_ROOT = ADDRESS.CRITERIA.ADDRESSES_PER_ROOT;
		let pointer = handler.size / ENTRY_BYTES; // Number of entries already in the file for this prefix
		for (pointer; pointer < count * ADDRESSES_PER_ROOT; pointer += ADDRESSES_PER_ROOT)
			rootAddresses.push(`${prefix}${ADDRESS.uint32ToB58(pointer, prefix.length)}`);

		return rootAddresses;
	}
	/** Check if the address has an associated identity @param {string} address */
	hasIdentity(address) {
		const { prefix, rootUint32 } = ADDRESS.getAddressRoot(address);
		const handler = this.#getHandler(prefix);
		const offset = rootUint32 * ENTRY_BYTES;
		return offset < handler.size; // if offset is out of range, it means no identity entry has been registered for this address
	}
	/** Return the pubkeys associated with an address @param {string} address */
	getIdentity(address) {
		if (!ADDRESS.checkConformity(address)) return null;

		// RETRIEVE POINTER
		const pointer = this.#getPointer(address);
		if (!pointer) return null; // UNKNOWN ADDRESS

		// RETRIEVE TX AND PARSE IDENTITY ENTRY ASSOCIATED WITH THE ADDRESS
		const { blockIndex, txIndex, identityIndex } = pointer;
		const readableTx = this.bcStorage.getTransactionReaderWithCursors(blockIndex, txIndex);
		if (!readableTx) throw new Error(`IdentityStore.get: no data found for transaction at ${blockIndex}:${txIndex} for address ${address} - unable to resolve identity`);

		const { reader, cursors, sizes } = readableTx;
		reader.cursor = cursors.identities;
		
		const identities = reader.readPointersAndExtractDataChunks();
		if (!identities[identityIndex]) throw new Error(`IdentityStore.get: no identity entry found at index ${identityIndex} for transaction at ${blockIndex}:${txIndex} - unable to resolve identity`);
		
		const { pubKeysHex, threshold } = serializer.deserialize.identityEntry(identities[identityIndex]);
		const { prefix } = ADDRESS.splitAddress(address);
		if (ADDRESS.LEXICON[prefix]?.threshold !== threshold) throw new Error(`IdentityStore.get: threshold mismatch for address ${address} in transaction at ${blockIndex}:${txIndex} - expected ${ADDRESS.LEXICON[prefix]?.threshold} but got ${threshold}`);
		return { address, pubKeysHex, threshold, serializedEntry: identities[identityIndex] };
	}
	/** Lookup at the store to verify identity.
	 * - 'UNKNOWN' if the address is not known in the store (no pointer, no entry)
	 * - 'KNOWN' if the address is known but no pubkeys provided to verify
	 * - 'MISMATCH' if the address is known but the pubkey(s) do not match the entry
	 * - 'MATCH' if the address is known and the pubkey(s) match the entry
	 * @param {string} address @param {string[]} [pubKeysHex] - optional array of pubkeys to verify against the stored identity @param {number} [threshold] - optional threshold to verify against the stored identity (only relevant for multi-sig addresses) */
	verify(address, pubKeysHex, threshold) {
		const parsedEntry = this.getIdentity(address);
		if (!parsedEntry) return 'UNKNOWN';
		if (!pubKeysHex?.length) return 'KNOWN'; // early return if no pubkeys provided

		if (parsedEntry.pubKeysHex.length !== pubKeysHex.length) return 'MISMATCH';
		for (const pk of parsedEntry.pubKeysHex) if (!pubKeysHex.includes(pk)) return 'MISMATCH';
		if (threshold !== undefined && parsedEntry.threshold !== threshold) return 'MISMATCH';
		return 'MATCH';
	}
	/** Create the new identities entries for the addresses involved in the block (pointers) @param {BlockFinalized} block */
	digestBlock(block) {
		let discoveryCount = 0;
		for (let txIndex = 0; txIndex < block.Txs.length; txIndex++) {
			const tx = block.Txs[txIndex];
			for (let entryIndex = 0; entryIndex < tx.identities.length; entryIndex++) {
				discoveryCount++;
				const { pubKeysHex, threshold } = serializer.deserialize.identityEntry(tx.identities[entryIndex]);
				const isMultiSig = pubKeysHex.length > 1;
				if (!isMultiSig) {
					this.#register('C', block.index, txIndex, entryIndex);
					continue;
				}

				if (!threshold) throw new Error(`IdentityStore: multi-sig entry without threshold in transaction at ${block.index}:${txIndex} - unable to extract discovery information`);
				const prefix = ADDRESS.getPrefixForMultisig(threshold);
				this.#register(prefix, block.index, txIndex, entryIndex);
			}
		}

		return discoveryCount;
	}
	/** Undo the identities entries for the addresses involved in the block (pointers) @param {BlockFinalized} block */
	revertBlock(block) {
		for (let txIndex = 0; txIndex < block.Txs.length; txIndex++) {
			const tx = block.Txs[txIndex];
			for (let entryIndex = 0; entryIndex < tx.identities.length; entryIndex++) {
				const { pubKeysHex, threshold } = serializer.deserialize.identityEntry(tx.identities[entryIndex]);
				const isMultiSig = pubKeysHex.length > 1;
				if (!isMultiSig) this.#unregister('C');
				else if (!threshold) throw new Error(`IdentityStore: multi-sig entry without threshold in transaction at ${block.index}:${txIndex} - unable to extract discovery information for revert`);
				else this.#unregister(ADDRESS.getPrefixForMultisig(threshold));
			}
		}
	}
	reset() {
		for (const identifier in this.handlers) this.handlers[identifier].close();
		this.handlers = {};

		if (fs.existsSync(this.basePath)) fs.rmSync(this.basePath, { recursive: true });
		fs.mkdirSync(this.basePath);
	}

	// INTERNAL METHODS
	#getHandler(prefix = 'C') {
		if (this.handlers[prefix]) return this.handlers[prefix];
		// CREATE AND OPEN NEW FILE FOR THIS PREFIX
		this.handlers[prefix] = new BinaryHandler(path.join(this.basePath, `${prefix}.bin`));
		return this.handlers[prefix]; // READY
	}
	/** Return the pointer for an address @param {string} address */
	#getPointer(address) { // READ ENTRY
		const { prefix, rootUint32 } = ADDRESS.getAddressRoot(address);
		const handler = this.#getHandler(prefix);
		const offset = rootUint32 * ENTRY_BYTES;
		if (offset >= handler.size) return null; // NO ENTRY FOR THIS ADDRESS

		const entryBytes = handler.read(offset, ENTRY_BYTES);
		const blockIndex = serializer.converter.bytes4ToNumber(entryBytes.subarray(0, 4));
		const txIndex = serializer.converter.bytes2ToNumber(entryBytes.subarray(4, 6));
		const identityIndex = entryBytes[6];
		return { blockIndex, txIndex, identityIndex };
	}
	/** Write the pointer, return the address @param {string} prefix @param {number} blockIndex @param {number} txIndex @param {number} identityIndex */
	#register(prefix, blockIndex, txIndex, identityIndex) { // WRITE ENTRY
		const handler = this.#getHandler(prefix);
		const rootAddress = this.nextRootAddressToCreate(prefix, 1)[0];
		const entryBytes = serializer.serialize.stamp(blockIndex, txIndex, identityIndex); // throws if non conform
		handler.cursor = handler.size; // APPEND TO THE END OF THE FILE
		handler.write(entryBytes);

		// RETURN THE NEW ADDRESS
		return rootAddress;
	}
	/** Truncate the end of file for one entry @param {string} prefix */
	#unregister(prefix) {
		const handler = this.#getHandler(prefix);
		handler.truncate(handler.size - ENTRY_BYTES);
	}
}