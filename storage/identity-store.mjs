// @ts-check
import fs from 'fs';
import path from 'path';
import { ADDRESS } from '../types/address.mjs';
import { buildEntry } from '../types/identity.mjs';
import { BinaryHandler } from './binary-handler.mjs';
import { OwnershipStorage } from './ownership-store.mjs';
import { serializer, SIZES } from '../utils/serializer.mjs';
import { TransactionReader } from '../types/transaction.mjs';

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
		const walletIds = [];
		const handler = this.#getHandler(prefix);
		const ADDRESSES_PER_ROOT = ADDRESS.CRITERIA.ADDRESSES_PER_ROOT;
		const start = handler.size / ENTRY_BYTES * ADDRESSES_PER_ROOT; // Number of entries already in the file for this prefix
		const end = start + (count * ADDRESSES_PER_ROOT);
		for (let i = start; i < end; i += ADDRESSES_PER_ROOT)
			walletIds.push(`${prefix}${ADDRESS.uint32ToSuffix(i, prefix.length)}`);

		return walletIds;
	}
	/** Check if the address has an associated identity @param {string} address */
	hasIdentity(address) {
		const { prefix, rootUint32 } = ADDRESS.getAddressRoot(address);
		const handler = this.#getHandler(prefix);
		const rootIndex = rootUint32 / ADDRESS.CRITERIA.ADDRESSES_PER_ROOT;
		const offset = rootIndex * ENTRY_BYTES;
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
		const serializedTx = this.bcStorage.getSerializedTransactions(blockIndex, [txIndex])?.txsBytes[txIndex];
		if (!serializedTx) throw new Error(`IdentityStore.get: no data found for transaction at ${blockIndex}:${txIndex} for address ${address} - unable to resolve identity`);

		const mode = txIndex === 0 ? 'solver' : txIndex === 1 ? 'validator' : 'tx';
		const txReader = new TransactionReader(serializedTx, mode);
		const identities = txReader.getIdentities();
		if (!identities[identityIndex]) throw new Error(`IdentityStore.get: no identity entry found at index ${identityIndex} for transaction at ${blockIndex}:${txIndex} - unable to resolve identity`);
		
		const { pubKeysHex, threshold } = serializer.deserialize.identityEntry(identities[identityIndex]);
		const { prefix } = ADDRESS.splitAddress(address);
		if (ADDRESS.LEXICON[prefix]?.threshold !== threshold) throw new Error(`IdentityStore.get: threshold mismatch for address ${address} in transaction at ${blockIndex}:${txIndex} - expected ${ADDRESS.LEXICON[prefix]?.threshold} but got ${threshold}`);
		return { address, pubKeysHex, threshold, serializedEntry: identities[identityIndex] };
	}
	/** Create the new identities entries for the addresses involved in the block (pointers)
	 * @param {BlockFinalized} block @param {OwnershipStorage} ownershipStorage */
	digestBlock(block, ownershipStorage, throwOnConflict = true) {
		let discoveryCount = 0;
		for (let txIndex = 0; txIndex < block.Txs.length; txIndex++) {
			const tx = block.Txs[txIndex];
			for (let entryIndex = 0; entryIndex < tx.identities.length; entryIndex++) {
				const { pubKeysHex, threshold } = serializer.deserialize.identityEntry(tx.identities[entryIndex]);
				if (!threshold) throw new Error(`IdentityStore: entry without threshold in transaction at ${block.index}:${txIndex} - unable to extract discovery information`);
				
				const isMultisig = pubKeysHex.length > 1;
				if (isMultisig) throw new Error("MULTISIG ISN'T ENABLED YET!");
				
				const prefix = isMultisig ? ADDRESS.getPrefixForMultisig(threshold) : 'C';
				if (ownershipStorage.getOwnedRootAddress(pubKeysHex))
					if (throwOnConflict) throw new Error(`New identity declaration conflict!`);
					else continue;
				
				const walletId = this.#register(prefix, block.index, txIndex, entryIndex);
				ownershipStorage.saveOwnership(pubKeysHex, walletId);
				discoveryCount++;
			}
		}

		return discoveryCount;
	}
	/** Undo the identities entries for the addresses involved in the block (pointers)
	 * @param {BlockFinalized} block @param {OwnershipStorage} ownershipStorage */
	revertBlock(block, ownershipStorage) {
		for (let txIndex = 0; txIndex < block.Txs.length; txIndex++) {
			const tx = block.Txs[txIndex];
			for (let entryIndex = 0; entryIndex < tx.identities.length; entryIndex++) {
				const { pubKeysHex, threshold } = serializer.deserialize.identityEntry(tx.identities[entryIndex]);
				if (!threshold) throw new Error('IdentityStore: entry without threshold in transaction');
				if (!ownershipStorage.getOwnedRootAddress(pubKeysHex)) throw new Error('Identity declaration: missing');

				const isMultiSig = pubKeysHex.length > 1;
				const prefix = isMultiSig ? ADDRESS.getPrefixForMultisig(threshold) : 'C';
				this.#unregister(prefix);
				ownershipStorage.deleteOwnership(pubKeysHex);
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
		const rootIndex = rootUint32 / ADDRESS.CRITERIA.ADDRESSES_PER_ROOT;
		const offset = rootIndex * ENTRY_BYTES;
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
		const walletId = this.nextRootAddressToCreate(prefix, 1)[0];
		const entryBytes = serializer.serialize.stamp(blockIndex, txIndex, identityIndex); // throws if non conform
		handler.cursor = handler.size; // APPEND TO THE END OF THE FILE
		handler.write(entryBytes);

		// RETURN THE NEW ADDRESS
		return walletId;
	}
	/** Truncate the end of file for one entry @param {string} prefix */
	#unregister(prefix) {
		const handler = this.#getHandler(prefix);
		handler.truncate(handler.size - ENTRY_BYTES);
	}
}