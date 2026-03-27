// @ts-check
import fs from 'fs';
import path from 'path';
import HiveP2P from 'hive-p2p';
import { UTXO } from '../types/transaction.mjs';
import { serializer, BinaryReader, BinaryWriter } from '../utils/serializer.mjs';

/**
 * @typedef {import("../types/transaction.mjs").LedgerUtxo} LedgerUtxo
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/transaction.mjs").VoutId} VoutId
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized 
 * 
 * @typedef {Object} RawLedger
 * @property {number} balance
 * @property {number} totalSent
 * @property {number} totalReceived
 * @property {number} nbUtxos
 * @property {number} nbHistory
 * @property {Buffer} utxosBuffer
 * @property {Uint8Array} historyBytes */

/*{ // SAMPLE LEDGER BINARY FORMAT
  balance				(6b)
  totalSent				(6b)
  totalReceived			(6b)
  nbUtxos				(4b)
  nbHistory				(4b)
  utxos					(15b x nb)
  history-TxIds 		(6b x nb)
}*/

export class AddressLedger {
	/** 
	 * @param {number} balance @param {number} totalSent @param {number} totalReceived @param {number} nbUtxos @param {number} nbHistory
	 * @param {LedgerUtxo[]} [ledgerUtxos] @param {TxId[]} [history] @param {Buffer} [utxosBuffer] @param {Uint8Array} [historyBytes] */
	constructor(balance, totalSent, totalReceived, nbUtxos, nbHistory, ledgerUtxos, history, utxosBuffer, historyBytes) {
		this.balance = balance;
		this.totalSent = totalSent;
		this.totalReceived = totalReceived;
		this.nbUtxos = nbUtxos;
		this.nbHistory = nbHistory;
		this.ledgerUtxos = ledgerUtxos;
		this.history = history;
		this.utxosBuffer = utxosBuffer;
		this.historyBytes = historyBytes;
	}
}

class AddressChanges {
	/** Incoming UTXOs entries @type {Uint8Array[]} */ 			in = [];
	/** Outgoing UTXOs entries @type {Uint8Array[]} */ 			out = [];
	/** Incoming total amount @type {number} */ 				totalInAmount = 0;
	/** Outgoing total amount @type {number} */ 				totalOutAmount = 0;
	/** History txIds @type {Set<TxId>} */						historyTxIds = new Set();

	/** @param {'in' | 'out'} direction @param {TxId} txId @param {number} height @param {number} txIndex @param {number} vout @param {number} amount @param {string} rule */
	add(direction, txId, height, txIndex, vout, amount, rule) {
		const serializedUtxo = serializer.serialize.ledgerUtxo(height, txIndex, vout, amount, rule);
		//const txId = `${height}:${txIndex}`;
		if (!this.historyTxIds.has(txId)) this.historyTxIds.add(txId);
		
		if (direction === 'out') {
			this.totalOutAmount += amount;
			this.out.push(serializedUtxo);
		} else {
			this.totalInAmount += amount;
			this.in.push(serializedUtxo);
		}
	}
}

export class LedgersStorage {
	/** @type {Map<string, Uint8Array>} */
	cache = new Map(); // clear on new block & undo block
	storage;
	get logger() { return this.storage.miniLogger; }
	converter = new HiveP2P.Converter();

	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) { this.storage = storage; }

	// API METHODS - SORRY FOR SYNC+ASYNC METHODS, TOO MUCH OF CODE, I HAVEN'T DECIDED YET */
	/** @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs @param {'APPLY' | 'REVERT'} mode @param {boolean} [safeMode] If enabled: check the history before writing, default: false */
	digestBlockSync(block, involvedUTXOs, mode, safeMode = false) {
		const changesByAddress = this.#extractChangesByAddress(block, involvedUTXOs);
		let count = 0;
		for (const address in changesByAddress) {
			const rawLedger = this.#readAddressLedgerSync(address);
			const result = mode === 'APPLY'
				? this.#applyAddressChanges(address, rawLedger, changesByAddress[address], safeMode)
				: this.#reverseAddressChanges(address, rawLedger, changesByAddress[address], safeMode, true);
			if (!result) continue;
			
			const isExistingLedger = rawLedger.nbHistory !== 0; 
			const dirPath = this.#pathOfAddressLedgerDir(address);
			this.storage.saveBinary(address, result, dirPath, isExistingLedger);
			count++;
		}

		return count;
	}
	/** @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs @param {'APPLY' | 'REVERT'} mode @param {boolean} [safeMode] If enabled: check the history before writing, default: false */
	async digestBlock(block, involvedUTXOs, mode, safeMode = false) {
		const changesByAddress = this.#extractChangesByAddress(block, involvedUTXOs);
		const ledgersByAddress = await this.#getAddressesLedgers(changesByAddress);
		
		// Phase 1: prepare bytes
		/** @type {Object<string, Uint8Array>} */
		const results = {};
		for (const address in changesByAddress) {
			const rawLedger = ledgersByAddress[address];
			const result = mode === 'APPLY'
				? this.#applyAddressChanges(address, rawLedger, changesByAddress[address], safeMode)
				: this.#reverseAddressChanges(address, rawLedger, changesByAddress[address], safeMode, true);
			if (!result) continue;

			results[address] = result;
		}

		// Phase 2: parallel writes
		const promises = [];
		for (const address in results) {
			const isExistingLedger = ledgersByAddress[address].nbHistory !== 0;
			const dirPath = this.#pathOfAddressLedgerDir(address);
			promises.push(this.storage.saveBinaryAtomicAsync(address, results[address], dirPath, isExistingLedger));
		}

		// Phase 3: sequential atomic commits
		const writeResults = await Promise.all(promises);
		let applyCount = 0;
		for (const r of writeResults)
			if (!r) continue;
			else { applyCount += this.storage.commitAtomic(r.tempFilePath, r.finalFilePath) ? 1 : 0; };

		return applyCount;
	}
	/** @param {string} address @param {boolean} [deserializeUtxosAndHistory] Default: true */
	async getAddressLedger(address, deserializeUtxosAndHistory = true) {
		const l = await this.#readAddressLedger(address);
		const ledgerUtxos = deserializeUtxosAndHistory ? serializer.deserialize.ledgerUtxosArray(l.utxosBuffer) : undefined;
		const history = 	deserializeUtxosAndHistory ? serializer.deserialize.txsIdsArray(l.historyBytes) : undefined;
		return new AddressLedger(l.balance, l.totalSent, l.totalReceived, l.nbUtxos, l.nbHistory, ledgerUtxos, history, l.utxosBuffer, l.historyBytes);
	}
	reset() {
		if (fs.existsSync(this.storage.PATH.LEDGERS)) fs.rmSync(this.storage.PATH.LEDGERS, { recursive: true });
		fs.mkdirSync(this.storage.PATH.LEDGERS);
	}

	// INTERNAL METHODS
	/** @param {string} address @param {RawLedger} rawLedger @param {AddressChanges} changes @param {boolean} [safeMode] If enabled: check the history before writing, default: false */
	#applyAddressChanges(address, rawLedger, changes, safeMode = false) {
		// PREPARE HISTORY TO ADD & CONTROL FOR SAFE MODE
		const newHistoryBytes = serializer.serialize.txsIdsArray(changes.historyTxIds);
		if (safeMode) { // CHECK IF ALREADY UPDATED => NO WRITE
			if (rawLedger.historyBytes.length >= newHistoryBytes.length) return null;
			const existingHistoryEnd = rawLedger.historyBytes.subarray(rawLedger.historyBytes.length - newHistoryBytes.length);
			if (Buffer.from(existingHistoryEnd).compare(Buffer.from(newHistoryBytes)) === 0) return null;
		}

		// PREPARE NEW LEDGER VALUES
		const newNbUtxos = rawLedger.nbUtxos + changes.in.length - changes.out.length;
		const newNbHistory = rawLedger.nbHistory + changes.historyTxIds.size;
		rawLedger.balance += (changes.totalInAmount - changes.totalOutAmount);
		rawLedger.totalSent += changes.totalOutAmount;
		rawLedger.totalReceived += changes.totalInAmount;

		const w = new BinaryWriter(6 + 6 + 6 + 4 + 4 + (newNbUtxos * 15) + (newNbHistory * 6));
		w.writeBytes(this.converter.numberTo6Bytes(rawLedger.balance));
		w.writeBytes(this.converter.numberTo6Bytes(rawLedger.totalSent));
		w.writeBytes(this.converter.numberTo6Bytes(rawLedger.totalReceived));
		w.writeBytes(this.converter.numberTo4Bytes(newNbUtxos));
		w.writeBytes(this.converter.numberTo4Bytes(newNbHistory));
		
		// WRITE KEPT UTXOS
		const indexesToSkip = this.#extractIndexesOfMatches(rawLedger.utxosBuffer, changes.out);
		for (let i = 0; i < rawLedger.nbUtxos * 15; i += 15)
			if (!indexesToSkip.has(i)) w.writeBytes(rawLedger.utxosBuffer.subarray(i, i + 15));

		// WRITE NEW UTXOS
		for (const entryBytes of changes.in) w.writeBytes(entryBytes);

		// WRITE HISTORY TXIDS
		w.writeBytes(rawLedger.historyBytes);
		w.writeBytes(newHistoryBytes);

		// IF EVERYTHING OK => RETURN BYTES TO SAVE
		return w.getBytesOrThrow(`Ledger for address ${address} writing incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
	}
	/** @param {string} address @param {RawLedger} rawLedger @param {AddressChanges} changes @param {boolean} [safeMode] If enabled: check the history before writing, default: false @param {boolean} [cleanupEmpty] delete the ledger file if empty, default: true */
	#reverseAddressChanges(address, rawLedger, changes, safeMode = false, cleanupEmpty = true) {
		// PREPARE HISTORY TO ADD & CONTROL FOR SAFE MODE
		const newHistoryBytes = serializer.serialize.txsIdsArray(changes.historyTxIds);
		if (safeMode) { // CHECK IF END HISTORY DOESN'T MATCH => NO WRITE (unable to undo)
			if (rawLedger.historyBytes.length < newHistoryBytes.length) return null;
			const existingHistoryEnd = rawLedger.historyBytes.subarray(rawLedger.historyBytes.length - newHistoryBytes.length);
			if (Buffer.from(existingHistoryEnd).compare(Buffer.from(newHistoryBytes)) !== 0) return null;
		}

		// PREPARE NEW LEDGER VALUES
		const newNbUtxos = rawLedger.nbUtxos - changes.in.length + changes.out.length;
		const newNbHistory = rawLedger.nbHistory - changes.historyTxIds.size;
		rawLedger.balance -= (changes.totalInAmount - changes.totalOutAmount);
		rawLedger.totalSent -= changes.totalOutAmount;
		rawLedger.totalReceived -= changes.totalInAmount;

		// IF EMPTY & CLEANUP ACTIVE => DELETE FILE AND RETURN
		const dirPath = this.#pathOfAddressLedgerDir(address);
		const isEmpty = (newNbUtxos === 0 && newNbHistory === 0 && rawLedger.balance === 0);
		if (isEmpty && cleanupEmpty) {
			fs.rmSync(path.join(dirPath, `${address}.bin`), { force: true });
			return null;
		}
		
		const w = new BinaryWriter(6 + 6 + 6 + 4 + 4 + (newNbUtxos * 15) + (newNbHistory * 6));
		w.writeBytes(this.converter.numberTo6Bytes(rawLedger.balance));
		w.writeBytes(this.converter.numberTo6Bytes(rawLedger.totalSent));
		w.writeBytes(this.converter.numberTo6Bytes(rawLedger.totalReceived));
		w.writeBytes(this.converter.numberTo4Bytes(newNbUtxos));
		w.writeBytes(this.converter.numberTo4Bytes(newNbHistory));
		
		// WRITE KEPT UTXOS
		const indexesToSkip = this.#extractIndexesOfMatches(rawLedger.utxosBuffer, changes.in);
		for (let i = 0; i < rawLedger.nbUtxos * 15; i += 15)
			if (!indexesToSkip.has(i)) w.writeBytes(rawLedger.utxosBuffer.subarray(i, i + 15));

		// WRITE NEW UTXOS
		for (const entryBytes of changes.out) w.writeBytes(entryBytes);

		// WRITE HISTORY TXIDS
		w.writeBytes(rawLedger.historyBytes.subarray(0, rawLedger.historyBytes.length - newHistoryBytes.length));

		// IF EVERYTHING OK => RETURN BYTES TO SAVE
		return w.getBytesOrThrow(`Ledger for address ${address} writing incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
	}
	/** @param {string} address Base58 string address */
	#pathOfAddressLedgerDir(address) {
		return path.join(this.storage.PATH.LEDGERS, address.slice(0, 2), address.slice(2, 4));
    }
	/** @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs */
	#extractChangesByAddress(block, involvedUTXOs) {
		/** @type {Object<string, AddressChanges>} */
		const r = {}; // RESULT
		for (let i = 2; i < block.Txs.length; i++)
			for (const input of block.Txs[i].inputs) {
				const utxo = involvedUTXOs[input];
				if (!utxo) throw new Error(`UTXO with anchor ${input} not found in involvedUTXOs while extracting changes for block ${block.index}`);
				
				if (!r[utxo.address]) r[utxo.address] = new AddressChanges();
				const txId = `${block.index}:${i}`;
				const { height, txIndex, vout } = serializer.parseAnchor(input);
				r[utxo.address].add('out', txId, height, txIndex, vout, utxo.amount, utxo.rule);
			}

		for (let i = 0; i < block.Txs.length; i++)
			for (let voutIndex = 0; voutIndex < block.Txs[i].outputs.length; voutIndex++) {
				const { address, amount, rule } = block.Txs[i].outputs[voutIndex];
				if (!r[address]) r[address] = new AddressChanges();

				const txId = `${block.index}:${i}`;
				r[address].add('in', txId, block.index, i, voutIndex, amount, rule);
			}
		
		return r;
	}
	/** @param {string} address */
	#readAddressLedgerSync(address) {
		const dirPath = this.#pathOfAddressLedgerDir(address);
		const r = new BinaryReader(this.cache.get(address)		// Try cache first
			|| this.storage.loadBinary(address, dirPath, false) // Then storage
			|| new Uint8Array(6 + 6 + 6 + 4 + 4)); 				// Else empty ledger
		return this.#deserializeAddressLedger(r, address);
	}
	/** @param {string} address */
	async #readAddressLedger(address) {
		const dirPath = this.#pathOfAddressLedgerDir(address);
		const r = new BinaryReader(this.cache.get(address)					// Try cache first
			|| await this.storage.loadBinaryAsync(address, dirPath, false) 	// Then storage
			|| new Uint8Array(6 + 6 + 6 + 4 + 4)); 							// Else empty ledger
		return this.#deserializeAddressLedger(r, address);
	}
	/** @param {BinaryReader} r @param {string} address */
	#deserializeAddressLedger(r, address) {
		const balance = 	this.converter.bytes6ToNumber(r.read(6));
		const totalSent = 	this.converter.bytes6ToNumber(r.read(6));
		const totalReceived = this.converter.bytes6ToNumber(r.read(6));
		const nbUtxos = 	this.converter.bytes4ToNumber(r.read(4));
		const nbHistory = 	this.converter.bytes4ToNumber(r.read(4)); // don't update before reading history
		const utxosBuffer = Buffer.from(r.read(nbUtxos * 15));
		const historyBytes= r.read(nbHistory * 6);
		if (!r.isReadingComplete) throw new Error(`Ledger for address ${address} reading incomplete: read ${r.cursor} of ${r.view.length} bytes`);
		this.cache.set(address, r.view); // CACHE THE RAW BYTES
		return { balance, totalSent, totalReceived, nbUtxos, nbHistory, utxosBuffer, historyBytes };
	}
	/** @param {Object<string, AddressChanges>} changesByAddress */
	async #getAddressesLedgers(changesByAddress) {
		const promises = [];
		for (const address in changesByAddress)
			promises.push(this.#readAddressLedger(address)); // READ AND CACHE ALL LEDGERS BEFORE WRITING
		
		/** @type {Object<string, RawLedger>} */
		const ledgersByAddress = {};
		const results = await Promise.all(promises);

		let i = 0;
		for (const address in changesByAddress) ledgersByAddress[address] = results[i++];
		return ledgersByAddress;
	}
	/** @param {Buffer} buffer @param {Uint8Array[]} entriesToSkip */
	#extractIndexesOfMatches(buffer, entriesToSkip) {
		/** @type {Set<number>} */
		const indexes = new Set();
		for (const entryBytes of entriesToSkip) {
			const idx = buffer.indexOf(entryBytes);
			if (idx === -1) throw new Error(`UTXO entry not found: ${Buffer.from(entryBytes).toString('hex')}`);
			if (idx % 15 !== 0) throw new Error(`UTXO found at invalid offset: ${idx}`);
			indexes.add(idx);
		}
		return indexes;
	}
}