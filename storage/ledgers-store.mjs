// @ts-check
import fs from 'fs';
import path from 'path';
import { Ledger } from '../types/ledger.mjs';
import { ADDRESS } from '../types/address.mjs';
import { UTXO } from '../types/transaction.mjs';
import { serializer, BinaryReader, BinaryWriter } from '../utils/serializer.mjs';

/**
 * @typedef {import("../types/transaction.mjs").LedgerUtxo} LedgerUtxo
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/transaction.mjs").VoutId} VoutId
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized */

class WalletChanges {
	/** key: address @type {Record<string, SlotChanges>} */
	slotChanges = {};
	addresses;

	/** @param {string} walletId */
	constructor(walletId) {
		this.addresses = ADDRESS.getAddressesFromWalletId(walletId);
		for (const address of this.addresses) this.slotChanges[address] = new SlotChanges();
	}

	/** @param {string} address @param {'in' | 'out'} direction @param {number} height @param {number} txIndex @param {number} vout @param {number} amount @param {string} rule */
	add(address, direction, height, txIndex, vout, amount, rule) {
		const txId = `${height}:${txIndex}`;
		const serializedUtxo = serializer.serialize.ledgerUtxo(height, txIndex, vout, amount, rule);
		const slotChanges = this.slotChanges[address];
		if (!slotChanges.historyTxIds.has(txId)) slotChanges.historyTxIds.add(txId);

		if (direction === 'out') {
			slotChanges.totalOutAmount += amount;
			slotChanges.out.push(serializedUtxo);
		} else {
			slotChanges.totalInAmount += amount;
			slotChanges.in.push(serializedUtxo);
		}
	}
}
export class SlotChanges {
	/** Incoming UTXOs entries @type {Uint8Array[]} */ 			in = [];
	/** Outgoing UTXOs entries @type {Uint8Array[]} */ 			out = [];
	/** Incoming total amount @type {number} */ 				totalInAmount = 0;
	/** Outgoing total amount @type {number} */ 				totalOutAmount = 0;
	/** History txIds @type {Set<TxId>} */						historyTxIds = new Set();
}
class LedgersCache { // clear on new block & undo block
	/** Cache of serialized LedgersBatches by walletId @type {Map<string, Uint8Array | null>} */
	serializedBatches = new Map();
	/** Cache of serialized Ledgers by walletId @type {Map<string, Uint8Array[]>} */
	serializedLedgers = new Map();
	/** Cache of Ledgers by walletId @type {Map<string, Ledger[]>} */
	ledgers = new Map();

	clear() {
		this.serializedBatches.clear();
		this.serializedLedgers.clear();
		this.ledgers.clear();
	}
}

const ADDRESS_PER_ROOT = ADDRESS.CRITERIA.ADDRESSES_PER_ROOT;
export class LedgersStorage {
	cache = new LedgersCache();

	storage;
	get logger() { return this.storage.miniLogger; }

	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) { this.storage = storage; }

	// API METHODS
	/** @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs @param {'APPLY' | 'REVERT'} mode @param {boolean} [safeMode] If enabled: check the history before writing, default: false */
	digestBlock(block, involvedUTXOs, mode, safeMode = false) {
		const changesByWallet = this.#extractChangesByWallet(block, involvedUTXOs);
		let count = 0; // BUILD UPDATED LEDGERS
		for (const walletId in changesByWallet) {
			/** @type {Map<string, Uint8Array>} */
			const serializedUpdatedLedgersByAddress = new Map();
			const changes = changesByWallet[walletId];
			for (const address in changes.slotChanges) {
				const slotChanges = changes.slotChanges[address];
				if (slotChanges.historyTxIds.size === 0) continue; // Nothing new

				const ledger = this.getAddressLedger(address, changes.addresses);
				const result = mode === 'APPLY'
					? ledger.applySlotChanges(slotChanges, safeMode)
					: ledger.reverseSlotChanges(slotChanges, safeMode);

				if (!result) continue;
				serializedUpdatedLedgersByAddress.set(address, result);
			}

			if (serializedUpdatedLedgersByAddress.size === 0) continue; // No modification.

			// MERGE UPDATED LEDGERS
			let isEmpty = true;
			const serializedUpdatedLedgers = [];
			const addresses = ADDRESS.getAddressesFromWalletId(walletId);
			const { isNewLedger, serializedLedgers } = this.#getSerializedLedgers(walletId); // ensure all non-updated ledgers presence.
			for (let i = 0; i < addresses.length; i++) {
				const updated = serializedUpdatedLedgersByAddress.get(addresses[i]);
				const loaded = serializedLedgers[i]; // fallback (original)
				const serialized = updated || loaded; // Choose the right ledger
				serializedUpdatedLedgers.push(serialized);
				if (serialized.length > Ledger.EMPTY_LEDGER_SIZE) isEmpty = false;
			}

			// SAVE FILE OR DELETE IF EMPTY
			count++;
			if (!isEmpty) this.#serializeAndSaveLedgersAsBatch(walletId, serializedUpdatedLedgers, isNewLedger);
			else if (!isNewLedger) {
				const { dirPath, fileName } = this.#pathOfAddressLedger(walletId);
				fs.rmSync(path.join(dirPath, `${fileName}.bin`), { force: true });
			}
		}

		return count;
	}
	/** Try cache first -> then storage @param {string} walletId */
	getSerializedBatch(walletId) {
		if (!this.cache.serializedBatches.has(walletId)) {
			const { dirPath, fileName } = this.#pathOfAddressLedger(walletId);
			const serializedBatch = this.storage.loadBinary(fileName, dirPath, false);
			this.cache.serializedBatches.set(walletId, serializedBatch);
		}

		return this.cache.serializedBatches.get(walletId);
	}
	/** @param {string} address @param {string[]} [walletAddresses] addresses linked to walletId if known */
	getAddressLedger(address, walletAddresses) {
		const walletId = ADDRESS.getAddressRoot(address).walletId;
		const addresses = walletAddresses || ADDRESS.getAddressesFromWalletId(walletId);
		const addressIndex = addresses.indexOf(address);
		if (addressIndex === -1) throw new Error(`Address ${address} not found in addresses ${ADDRESS.getAddressesFromWalletId(walletId)}`);

		return this.cache.ledgers.get(walletId)?.[addressIndex]
			|| new Ledger(this.#getSerializedLedgers(walletId).serializedLedgers[addressIndex]);
	}
	reset() {
		if (fs.existsSync(this.storage.PATH.LEDGERS)) fs.rmSync(this.storage.PATH.LEDGERS, { recursive: true });
		fs.mkdirSync(this.storage.PATH.LEDGERS);
	}

	// INTERNAL METHODS
	/** @param {string} walletId Base58 string address */
	#pathOfAddressLedger(walletId) { // 58 * 58 = 3364 folders per folder
		const bytes = ADDRESS.addressToBytes(walletId);
		const hex = serializer.converter.bytesToHex(bytes);
		const [ dir1, dir2, fileName ] = [ hex.slice(0, 4), hex.slice(4, 8), hex.slice(8) ]
		const dirPath = path.join(this.storage.PATH.LEDGERS, dir1, dir2);
		return { dir1, dir2, dirPath, fileName };
	}
	/** @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs */
	#extractChangesByWallet(block, involvedUTXOs) {
		/** key: walletId @type {Record<string, WalletChanges>} */
		const changes = {};
		for (let i = 2; i < block.Txs.length; i++)
			for (const input of block.Txs[i].inputs) {
				const utxo = involvedUTXOs[input];
				if (!utxo) throw new Error(`UTXO with anchor ${input} not found in involvedUTXOs while extracting changes for block ${block.index}`);

				const { address, amount, rule } = utxo;
				const walletId = ADDRESS.getAddressRoot(address).walletId;
				if (!changes[walletId]) changes[walletId] = new WalletChanges(walletId);

				const { height, txIndex, vout } = serializer.parseAnchor(input);
				changes[walletId].add(address, 'out', height, txIndex, vout, amount, rule);
			}

		for (let i = 0; i < block.Txs.length; i++)
			for (let voutIndex = 0; voutIndex < block.Txs[i].outputs.length; voutIndex++) {
				const { address, amount, rule } = block.Txs[i].outputs[voutIndex];
				const walletId = ADDRESS.getAddressRoot(address).walletId;
				if (!changes[walletId]) changes[walletId] = new WalletChanges(walletId);

				changes[walletId].add(address, 'in', block.index, i, voutIndex, amount, rule);
			}

		return changes;
	}
	/** Retreive or create ledgers associated to walletId @param {string} walletId */
	#getSerializedLedgers(walletId) {
		const serializedBatch = this.getSerializedBatch(walletId);
		const serializedLedgers = this.cache.serializedLedgers.get(walletId) || (serializedBatch
			? new BinaryReader(serializedBatch).readPointersAndExtractDataChunks('pointer32')
			: []) // init or extract

		const isNewLedger = serializedBatch === null;
		if (isNewLedger) // fill empty batch
			for (let i = 0; i < ADDRESS_PER_ROOT; i++)
				serializedLedgers.push(new Uint8Array(Ledger.EMPTY_LEDGER_SIZE));

		this.cache.serializedLedgers.set(walletId, serializedLedgers);
		return { isNewLedger, serializedLedgers };
	}
	/** @param {string} walletId @param {Uint8Array[]} serializedLedgers */
	#serializeAndSaveLedgersAsBatch(walletId, serializedLedgers, isNewLedger = true) {
		const s = BinaryWriter.serializedBytesArray(serializedLedgers, 'pointer32');
		this.cache.serializedBatches.set(walletId, s);

		const { dirPath, fileName } = this.#pathOfAddressLedger(walletId);
		this.storage.saveBinary(fileName, s, dirPath, !isNewLedger);
	}
}