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
  pubKey				(32b)
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
	 * @param {string} pubKey @param {number} balance @param {number} totalSent @param {number} totalReceived @param {number} nbUtxos @param {number} nbHistory
	 * @param {LedgerUtxo[]} [ledgerUtxos] @param {TxId[]} [history] @param {Buffer} [utxosBuffer] @param {Uint8Array} [historyBytes] */
	constructor(pubKey, balance, totalSent, totalReceived, nbUtxos, nbHistory, ledgerUtxos, history, utxosBuffer, historyBytes) {
		this.pubKey = pubKey;
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

	/** @param {'in' | 'out'} direction @param {number} height @param {number} txIndex @param {number} vout @param {number} amount @param {string} rule */
	add(direction, height, txIndex, vout, amount, rule) {
		// COUNT AMOUNT
		if (direction === 'in') this.totalInAmount += amount;
		else this.totalOutAmount += amount;
		
		// ADD THE UTXO TO THE CORRECT DIRECTION
		const serializedUtxo = serializer.serialize.ledgerUtxo(height, txIndex, vout, amount, rule);
		if (direction === 'in') this.in.push(serializedUtxo);
		else this.out.push(serializedUtxo);

		// ADD THE TxId TO THE HISTORY IF NOT EXISTS
		if (direction === 'out') return; // out = consumed = already in history
		const txId = `${height}:${txIndex}`;
		if (!this.historyTxIds.has(txId)) this.historyTxIds.add(txId);
	}
}

export class LedgersStorage {
	storage;
	get logger() { return this.storage.miniLogger; }
	converter = new HiveP2P.Converter();

	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) { this.storage = storage; }

	// API METHODS
	/** @param {BlockFinalized} block @param {Object<string, UTXO>} involvedUTXOs @param {Object<string, AddressLedger>} involvedLedgers */
	digestBlock(block, involvedUTXOs, involvedLedgers) {
		const changesByAddress = this.#extractChangesByAddress(block, involvedUTXOs);
		for (const address in changesByAddress)
			this.#applyAddressChanges(address, changesByAddress[address], involvedLedgers[address]);
	}
	/** @param {string} address @param {boolean} [deserializeUtxosAndHistory] Default: true */
	getAddressLedger(address, deserializeUtxosAndHistory = true) {
		const l = this.#readAddressLedger(address);
		const ledgerUtxos = deserializeUtxosAndHistory ? serializer.deserialize.ledgerUtxosArray(l.utxosBuffer) : undefined;
		const history = 	deserializeUtxosAndHistory ? serializer.deserialize.txsIdsArray(l.historyBytes) : undefined;
		return new AddressLedger(l.pubKey, l.balance, l.totalSent, l.totalReceived, l.nbUtxos, l.nbHistory, ledgerUtxos, history, l.utxosBuffer, l.historyBytes);
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
		for (const utxoAnchor in involvedUTXOs) {
			const utxo = involvedUTXOs[utxoAnchor];
			if (!r[utxo.address]) r[utxo.address] = new AddressChanges();

			const { height, txIndex, vout } = serializer.parseAnchor(utxoAnchor);
			r[utxo.address].add('out', height, txIndex, vout, utxo.amount, utxo.rule);
		}

		for (let txIndex = 0; txIndex < block.Txs.length; txIndex++)
			for (let voutIndex = 0; voutIndex < block.Txs[txIndex].outputs.length; voutIndex++) {
				const { address, amount, rule } = block.Txs[txIndex].outputs[voutIndex];
				if (!r[address]) r[address] = new AddressChanges();

				r[address].add('in', block.index, txIndex, voutIndex, amount, rule);
			}
		
		return r;
	}
	/** @param {string} address @param {AddressChanges} changes @param {AddressLedger} [addressLedger] */
	#applyAddressChanges(address, changes, addressLedger) {
		const l = addressLedger || this.#readAddressLedger(address);
		if (!l || !l.utxosBuffer || !l.historyBytes) throw new Error(`Ledger for address ${address} not found or corrupted`);

		// PREPARE NEW LEDGER VALUES
		const newNbUtxos = l.nbUtxos + changes.in.length - changes.out.length;
		const newNbHistory = l.nbHistory + changes.historyTxIds.size;
		l.balance += (changes.totalInAmount - changes.totalOutAmount);
		l.totalSent += changes.totalOutAmount;
		l.totalReceived += changes.totalInAmount;
		const w = new BinaryWriter(32 + 6 + 6 + 6 + 4 + 4 + (newNbUtxos * 15) + (newNbHistory * 6));
		w.writeBytes(this.converter.hexToBytes(l.pubKey));
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
		for (const txId of changes.historyTxIds) {
			const { height, txIndex } = serializer.parseTxId(txId);
			w.writeBytes(this.converter.numberTo4Bytes(height));
			w.writeBytes(this.converter.numberTo2Bytes(txIndex));
		}

		const dirPath = this.#pathOfAddressLedgerDir(address);
		if (w.isWritingComplete) this.storage.saveBinary(address, w.getBytes(), dirPath);
		else throw new Error(`Ledger for address ${address} writing incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
	}
	/** @param {string} address */
	#readAddressLedger(address) {
		const dirPath = this.#pathOfAddressLedgerDir(address);
		const r = new BinaryReader(this.storage.loadBinary(address, dirPath) || new Uint8Array(32 + 6 + 6 + 6 + 4 + 4));
		let pubKey = 		this.converter.bytesToHex(r.read(32));
		let balance = 		this.converter.bytes6ToNumber(r.read(6));
		let totalSent = 	this.converter.bytes6ToNumber(r.read(6));
		let totalReceived = this.converter.bytes6ToNumber(r.read(6));
		const nbUtxos = 	this.converter.bytes4ToNumber(r.read(4));
		const nbHistory = 	this.converter.bytes4ToNumber(r.read(4)); // don't update before reading history
		const utxosBuffer = Buffer.from(r.read(nbUtxos * 15));
		const historyBytes= r.read(nbHistory * 6);
		if (!r.isReadingComplete) this.logger.log(`Ledger for address ${address} is corrupted`, (m, c) => console.error(m, c));
		return { pubKey, balance, totalSent, totalReceived, nbUtxos, nbHistory, utxosBuffer, historyBytes };
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