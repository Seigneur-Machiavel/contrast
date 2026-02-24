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
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized */

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

	// API METHODS
	/** @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs @param {boolean} [safeMode] If enabled: check the history before writing, default: false */
	digestBlock(block, involvedUTXOs, safeMode = false) {
		/** @type {Set<string>} */
		const dirsToCreate = new Set();
		const changesByAddress = this.#extractChangesByAddress(block, involvedUTXOs);
		let applyCount = 0;
		for (const address in changesByAddress) dirsToCreate.add(this.#pathOfAddressLedgerDir(address));
		for (const dirPath of dirsToCreate) fs.mkdirSync(dirPath, { recursive: true });
		for (const address in changesByAddress)
			applyCount += this.#applyAddressChanges(address, changesByAddress[address], safeMode);
		/*for (const address in changesByAddress) {
			const changes = changesByAddress[address];
			console.log('(digest) historyTxIds:', [...changes.historyTxIds], 'size:', changes.historyTxIds.size);
			applyCount += this.#applyAddressChanges(address, changes, safeMode);
		}*/

		return applyCount;
	}
	/** @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs */
	undoBlock(block, involvedUTXOs) { // UNDO WILL NOT BE PERFECT, UTXO ORDER MAY CHANGE
		let undoCount = 0;
		const changesByAddress = this.#extractChangesByAddress(block, involvedUTXOs);
		for (const address in changesByAddress)
			undoCount += this.#reverseAddressChanges(address, changesByAddress[address], true, true);
		/*for (const address in changesByAddress) {
			const changes = changesByAddress[address];
			console.log('(undo) historyTxIds:', [...changes.historyTxIds], 'size:', changes.historyTxIds.size);
			undoCount += this.#reverseAddressChanges(address, changes, true, true);
		}*/

		return undoCount;
	}
	/** @param {string} address @param {boolean} [deserializeUtxosAndHistory] Default: true */
	getAddressLedger(address, deserializeUtxosAndHistory = true) {
		const l = this.#readAddressLedger(address);
		const ledgerUtxos = deserializeUtxosAndHistory ? serializer.deserialize.ledgerUtxosArray(l.utxosBuffer) : undefined;
		const history = 	deserializeUtxosAndHistory ? serializer.deserialize.txsIdsArray(l.historyBytes) : undefined;
		return new AddressLedger(l.balance, l.totalSent, l.totalReceived, l.nbUtxos, l.nbHistory, ledgerUtxos, history, l.utxosBuffer, l.historyBytes);
	}
	reset() {
		if (fs.existsSync(this.storage.PATH.LEDGERS)) fs.rmSync(this.storage.PATH.LEDGERS, { recursive: true });
		fs.mkdirSync(this.storage.PATH.LEDGERS);
	}

	// INTERNAL METHODS
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
	/** @param {string} address @param {AddressChanges} changes @param {boolean} [safeMode] If enabled: check the history before writing, default: false */
	#applyAddressChanges(address, changes, safeMode = false) {
		const l = this.#readAddressLedger(address);

		// PREPARE HISTORY TO ADD & CONTROL FOR SAFE MODE
		const newHistoryBytes = serializer.serialize.txsIdsArray(changes.historyTxIds);
		if (safeMode) { // CHECK IF ALREADY UPDATED => NO WRITE
			if (l.historyBytes.length >= newHistoryBytes.length) return 0;
			const existingHistoryEnd = l.historyBytes.subarray(l.historyBytes.length - newHistoryBytes.length);
			if (Buffer.from(existingHistoryEnd).compare(Buffer.from(newHistoryBytes)) === 0) return 0;
		}

		// PREPARE NEW LEDGER VALUES
		const newNbUtxos = l.nbUtxos + changes.in.length - changes.out.length;
		const newNbHistory = l.nbHistory + changes.historyTxIds.size;
		l.balance += (changes.totalInAmount - changes.totalOutAmount);
		l.totalSent += changes.totalOutAmount;
		l.totalReceived += changes.totalInAmount;

		const w = new BinaryWriter(6 + 6 + 6 + 4 + 4 + (newNbUtxos * 15) + (newNbHistory * 6));
		w.writeBytes(this.converter.numberTo6Bytes(l.balance));
		w.writeBytes(this.converter.numberTo6Bytes(l.totalSent));
		w.writeBytes(this.converter.numberTo6Bytes(l.totalReceived));
		w.writeBytes(this.converter.numberTo4Bytes(newNbUtxos));
		w.writeBytes(this.converter.numberTo4Bytes(newNbHistory));
		
		// WRITE KEPT UTXOS
		const indexesToSkip = this.#extractIndexesOfMatches(l.utxosBuffer, changes.out);
		for (let i = 0; i < l.nbUtxos * 15; i += 15)
			if (!indexesToSkip.has(i)) w.writeBytes(l.utxosBuffer.subarray(i, i + 15));

		// WRITE NEW UTXOS
		for (const entryBytes of changes.in) w.writeBytes(entryBytes);

		// WRITE HISTORY TXIDS
		w.writeBytes(l.historyBytes);
		w.writeBytes(newHistoryBytes);

		// IF EVERYTHING OK => SAVE
		const dirPath = this.#pathOfAddressLedgerDir(address);
		if (w.isWritingComplete) this.storage.saveBinary(address, w.getBytes(), dirPath, true);
		else throw new Error(`Ledger for address ${address} writing incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
	
		return 1;
	}
	/** @param {string} address @param {AddressChanges} changes @param {boolean} [safeMode] If enabled: check the history before writing, default: false @param {boolean} [cleanupEmpty] delete the ledger file if empty, default: true */
	#reverseAddressChanges(address, changes, safeMode = false, cleanupEmpty = true) {
		const l = this.#readAddressLedger(address);

		// PREPARE HISTORY TO ADD & CONTROL FOR SAFE MODE
		const newHistoryBytes = serializer.serialize.txsIdsArray(changes.historyTxIds);
		if (safeMode) { // CHECK IF END HISTORY DOESN'T MATCH => NO WRITE (unable to undo)
			if (l.historyBytes.length < newHistoryBytes.length) return 0;
			const existingHistoryEnd = l.historyBytes.subarray(l.historyBytes.length - newHistoryBytes.length);
			if (Buffer.from(existingHistoryEnd).compare(Buffer.from(newHistoryBytes)) !== 0) return 0;
		}

		// PREPARE NEW LEDGER VALUES
		const newNbUtxos = l.nbUtxos - changes.in.length + changes.out.length;
		const newNbHistory = l.nbHistory - changes.historyTxIds.size;
		l.balance -= (changes.totalInAmount - changes.totalOutAmount);
		l.totalSent -= changes.totalOutAmount;
		l.totalReceived -= changes.totalInAmount;

		// IF EMPTY & CLEANUP ACTIVE => DELETE FILE AND RETURN
		const dirPath = this.#pathOfAddressLedgerDir(address);
		const isEmpty = (newNbUtxos === 0 && newNbHistory === 0 && l.balance === 0);
		if (isEmpty && cleanupEmpty) {
			fs.rmSync(path.join(dirPath, `${address}.bin`), { force: true });
			return 1;
		}

		const w = new BinaryWriter(6 + 6 + 6 + 4 + 4 + (newNbUtxos * 15) + (newNbHistory * 6));
		w.writeBytes(this.converter.numberTo6Bytes(l.balance));
		w.writeBytes(this.converter.numberTo6Bytes(l.totalSent));
		w.writeBytes(this.converter.numberTo6Bytes(l.totalReceived));
		w.writeBytes(this.converter.numberTo4Bytes(newNbUtxos));
		w.writeBytes(this.converter.numberTo4Bytes(newNbHistory));
		
		// WRITE KEPT UTXOS
		const indexesToSkip = this.#extractIndexesOfMatches(l.utxosBuffer, changes.in);
		for (let i = 0; i < l.nbUtxos * 15; i += 15)
			if (!indexesToSkip.has(i)) w.writeBytes(l.utxosBuffer.subarray(i, i + 15));

		// WRITE NEW UTXOS
		for (const entryBytes of changes.out) w.writeBytes(entryBytes);

		// WRITE HISTORY TXIDS
		w.writeBytes(l.historyBytes.subarray(0, l.historyBytes.length - newHistoryBytes.length));

		// IF EVERYTHING OK => SAVE
		if (w.isWritingComplete) this.storage.saveBinary(address, w.getBytes(), dirPath, true);
		else throw new Error(`Ledger for address ${address} writing incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		
		return 1;
	}
	/** @param {string} address */
	#readAddressLedger(address) {
		const dirPath = this.#pathOfAddressLedgerDir(address);
		const r = new BinaryReader(this.cache.get(address)		// Try cache first
			|| this.storage.loadBinary(address, dirPath, false) // Then storage
			|| new Uint8Array(6 + 6 + 6 + 4 + 4)); 				// Else empty ledger
		let balance = 		this.converter.bytes6ToNumber(r.read(6));
		let totalSent = 	this.converter.bytes6ToNumber(r.read(6));
		let totalReceived = this.converter.bytes6ToNumber(r.read(6));
		const nbUtxos = 	this.converter.bytes4ToNumber(r.read(4));
		const nbHistory = 	this.converter.bytes4ToNumber(r.read(4)); // don't update before reading history
		const utxosBuffer = Buffer.from(r.read(nbUtxos * 15));
		const historyBytes= r.read(nbHistory * 6);
		if (!r.isReadingComplete) throw new Error(`Ledger for address ${address} reading incomplete: read ${r.cursor} of ${r.view.length} bytes`);
		this.cache.set(address, r.view); // CACHE THE RAW BYTES
		return { balance, totalSent, totalReceived, nbUtxos, nbHistory, utxosBuffer, historyBytes };
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