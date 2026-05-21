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

	/** @param {string} address @param {'in' | 'out'} direction @param {TxId} txId @param {number} height @param {number} txIndex @param {number} vout @param {number} amount @param {string} rule */
	add(address, direction, txId, height, txIndex, vout, amount, rule) {
		const serializedUtxo = serializer.serialize.ledgerUtxo(height, txIndex, vout, amount, rule);
		if (!this.slotChanges[address].historyTxIds.has(txId))
			this.slotChanges[address].historyTxIds.add(txId);
		
		if (direction === 'out') {
			this.slotChanges[address].totalOutAmount += amount;
			this.slotChanges[address].out.push(serializedUtxo);
		} else {
			this.slotChanges[address].totalInAmount += amount;
			this.slotChanges[address].in.push(serializedUtxo);
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

const EMPTY_LEDGER_SIZE = 6 + 6 + 6 + 4 + 4;
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
		let count = 0;
		for (const walletId in changesByWallet) {

			// BUILD UPDATED LEDGERS
			/** @type {Record<string, Uint8Array>} */
			const serializedUpdatedLedgersByAddress = {};
			const { isNewLedger, serializedLedgers } = this.#getSerializedLedgers(walletId);
			const changes = changesByWallet[walletId];
			for (const address in changes.slotChanges) {
				const slotChanges = changes.slotChanges[address];
				const ledger = this.getAddressLedger(address, changes.addresses);
				const result = mode === 'APPLY'
					? ledger.applySlotChanges(slotChanges, safeMode)
					: ledger.reverseSlotChanges(slotChanges, safeMode);

				if (!result) continue;
				serializedUpdatedLedgersByAddress[address] = result;
			}
			
			// MERGE UPDATED LEDGERS
			let isEmpty = true;
			const serializedUpdatedLedgers = [];
			const addresses = ADDRESS.getAddressesFromWalletId(walletId);
			for (let i = 0; i < addresses.length; i++) {
				const sl = serializedUpdatedLedgersByAddress[addresses[i]] || serializedLedgers[i];
				serializedUpdatedLedgers.push(sl);
				if (sl.length > EMPTY_LEDGER_SIZE) isEmpty = false;
			}

			// SAVE FILE OR DELETE IF EMPTY
			if (!isEmpty) this.#serializeAndSaveLedgersAsBatch(walletId, serializedUpdatedLedgers, isNewLedger);
			else if (!isNewLedger) fs.rmSync(path.join(this.#pathOfAddressLedgerDir(walletId), `${walletId}.bin`), { force: true });
			count++;
		}

		return count;
	}
	/** Try cache first -> then storage @param {string} walletId */
	getSerializedBatch(walletId) {
		const dirPath = this.#pathOfAddressLedgerDir(walletId);
		let serializedBatch = this.cache.serializedBatches.get(walletId);
		if (serializedBatch === undefined) 
			serializedBatch = this.storage.loadBinary(walletId, dirPath, false);

		this.cache.serializedBatches.set(walletId, serializedBatch);
		return serializedBatch;
	}
	/** @param {string} address @param {string[]} [walletAddresses] addresses linked to walletId if known */
	getAddressLedger(address, walletAddresses) {
		const walletId = ADDRESS.getAddressRoot(address).walletId;
		const addressIndex = (walletAddresses || ADDRESS.getAddressesFromWalletId(walletId)).indexOf(address);
		if (addressIndex === -1) throw new Error(`Address ${address} not found in addresses ${ADDRESS.getAddressesFromWalletId(walletId)}`);
		
		return this.cache.ledgers.get(walletId)?.[addressIndex]
			|| new Ledger(this.#getSerializedLedgers(walletId).serializedLedgers[addressIndex]);
	}
	reset() {
		if (fs.existsSync(this.storage.PATH.LEDGERS)) fs.rmSync(this.storage.PATH.LEDGERS, { recursive: true });
		fs.mkdirSync(this.storage.PATH.LEDGERS);
	}

	// INTERNAL METHODS
	/** @param {string} address Base58 string address */
	#pathOfAddressLedgerDir(address) { // 58 * 58 = 3364 folders per folder
		return path.join(this.storage.PATH.LEDGERS, address.slice(0, 2), address.slice(2, 4));
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
				if (changes[walletId]) changes[walletId] = new WalletChanges(walletId);

				const txId = `${block.index}:${i}`;
				const { height, txIndex, vout } = serializer.parseAnchor(input);
				changes[walletId].add(address, 'out', txId, height, txIndex, vout, amount, rule);
			}

		for (let i = 0; i < block.Txs.length; i++)
			for (let voutIndex = 0; voutIndex < block.Txs[i].outputs.length; voutIndex++) {
				const { address, amount, rule } = block.Txs[i].outputs[voutIndex];
				const walletId = ADDRESS.getAddressRoot(address).walletId;
				if (!changes[walletId]) changes[walletId] = new WalletChanges(walletId);

				const txId = `${block.index}:${i}`;
				changes[walletId].add(address, 'in', txId, block.index, i, voutIndex, amount, rule);
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
				serializedLedgers.push(new Uint8Array(EMPTY_LEDGER_SIZE));
		
		this.cache.serializedLedgers.set(walletId, serializedLedgers);
		return { isNewLedger, serializedLedgers };
	}
	/** @param {string} walletId @param {Uint8Array[]} serializedLedgers */
	#serializeAndSaveLedgersAsBatch(walletId, serializedLedgers, isNewLedger = true) {
		const pointersSize = BinaryWriter.calculatePointersSize(serializedLedgers.length, 'pointer32');
		const totalSize = serializedLedgers.reduce((sum, b) => sum + b.length, 0);
		const w = new BinaryWriter(pointersSize + totalSize);
		w.writePointersAndDataChunks(serializedLedgers, 'pointer32');

		const dirPath = this.#pathOfAddressLedgerDir(walletId);
		this.storage.saveBinary(walletId, w.getBytesOrThrow(), dirPath, !isNewLedger);
	}
}