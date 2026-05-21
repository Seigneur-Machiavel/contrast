// @ts-check
import { SIZES, serializer, BinaryReader, BinaryWriter } from '../utils/serializer.mjs';

/**
 * @typedef {import('../storage/ledgers-store.mjs').SlotChanges} SlotChanges
 */

/*{ // SAMPLE LEDGER BINARY FORMAT
  balance				(6b) - start: 0
  totalSent				(6b) - start: 6
  totalReceived			(6b) - start: 12
  nbUtxos				(4b) - start: 18
  nbHistory				(4b) - start: 22
  ledgerUtxos			(15b x nb)
  historyBytes 			(6b x nb)
}*/

const converter = serializer.converter;
export class Ledger {
	writer;

	/** @param {Uint8Array} serializedLedger */
	constructor(serializedLedger) {
		this.writer = new BinaryWriter(serializedLedger.length);
		this.writer.writeBytes(serializedLedger);
	}

	// GETTERS
	/** @param {number} start @param {number} length */
	#readBytes(start, length) { return this.writer.view.slice(start, start + length); }
	get getBalance() { return converter.bytes6ToNumber(this.#readBytes(0, 6)); }
	get getTotalSent() { return converter.bytes6ToNumber(this.#readBytes(6, 6)); }
	get getTotalReceived() { return converter.bytes6ToNumber(this.#readBytes(12, 6)); }
	get getNbUtxos() { return converter.bytes4ToNumber(this.#readBytes(18, 4)); }
	get getNbHistory() { return converter.bytes4ToNumber(this.#readBytes(22, 4)); }
	get getUtxosBuffer() {
		const nbUtxos = this.getNbUtxos;
		if (!nbUtxos) return Buffer.from([]);
		return Buffer.from(this.#readBytes(26, nbUtxos * SIZES.ledgerUtxo.bytes));
	}
	get getHistoryBytes() {
		const nbHistory = this.getNbHistory;
		if (!nbHistory) return new Uint8Array();
		return this.#readBytes(26 + (this.getNbUtxos * SIZES.ledgerUtxo.bytes), nbHistory * 6);
	}
	get getUtxos() {
		return serializer.deserialize.ledgerUtxosArray(this.getUtxosBuffer);
	}
	get getHistory() {
		return serializer.deserialize.txsIdsArray(this.getHistoryBytes);
	}

	// SETTERS
	/** @param {SlotChanges} changes @param {boolean} [safeMode] If enabled: check the history before writing, default: false */
	applySlotChanges(changes, safeMode = false) {
		// PREPARE HISTORY TO ADD & CONTROL FOR SAFE MODE
		const newHistoryBytes = serializer.serialize.txsIdsArray(changes.historyTxIds);
		const historyBytes = this.getHistoryBytes;
		if (safeMode) { // CHECK IF ALREADY UPDATED => NO WRITE
			if (historyBytes.length >= newHistoryBytes.length) return null;
			const existingHistoryEnd = historyBytes.subarray(historyBytes.length - newHistoryBytes.length);
			if (Buffer.from(existingHistoryEnd).compare(Buffer.from(newHistoryBytes)) === 0) return null;
		}

		// PREPARE NEW LEDGER VALUES
		const newNbUtxos = this.getNbUtxos + changes.in.length - changes.out.length;
		const newNbHistory = this.getNbHistory + changes.historyTxIds.size;
		const newBalance = this.getBalance + (changes.totalInAmount - changes.totalOutAmount);
		const newTotalSent = this.getTotalSent + changes.totalOutAmount;
		const newTotalReceived = this.getTotalReceived + changes.totalInAmount;

		const w = new BinaryWriter(6 + 6 + 6 + 4 + 4 + (newNbUtxos * 15) + (newNbHistory * 6));
		w.writeBytes(serializer.converter.numberTo6Bytes(newBalance));
		w.writeBytes(serializer.converter.numberTo6Bytes(newTotalSent));
		w.writeBytes(serializer.converter.numberTo6Bytes(newTotalReceived));
		w.writeBytes(serializer.converter.numberTo4Bytes(newNbUtxos));
		w.writeBytes(serializer.converter.numberTo4Bytes(newNbHistory));
		
		// WRITE KEPT UTXOS
		const utxosBuffer = this.getUtxosBuffer;
		const indexesToSkip = this.#extractIndexesOfMatches(utxosBuffer, changes.out);
		for (let i = 0; i < newNbUtxos * 15; i += 15)
			if (!indexesToSkip.has(i)) w.writeBytes(utxosBuffer.subarray(i, i + 15));

		// WRITE NEW UTXOS
		for (const entryBytes of changes.in) w.writeBytes(entryBytes);

		// WRITE HISTORY TXIDS
		w.writeBytes(historyBytes);
		w.writeBytes(newHistoryBytes);

		// IF EVERYTHING OK => RETURN BYTES TO SAVE
		return w.getBytesOrThrow(`Ledger: writing incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
	}
	/** @param {SlotChanges} changes @param {boolean} [safeMode] If enabled: check the history before writing, default: false */
	reverseSlotChanges(changes, safeMode = false) {
		// PREPARE HISTORY TO ADD & CONTROL FOR SAFE MODE
		const newHistoryBytes = serializer.serialize.txsIdsArray(changes.historyTxIds);
		const historyBytes = this.getHistoryBytes;
		if (safeMode) { // CHECK IF END HISTORY DOESN'T MATCH => NO WRITE (unable to undo)
			if (historyBytes.length < newHistoryBytes.length) return null;
			const existingHistoryEnd = historyBytes.subarray(historyBytes.length - newHistoryBytes.length);
			if (Buffer.from(existingHistoryEnd).compare(Buffer.from(newHistoryBytes)) !== 0) return null;
		}

		// PREPARE NEW LEDGER VALUES
		const newNbUtxos = this.getNbUtxos - changes.in.length + changes.out.length;
		const newNbHistory = this.getNbHistory - changes.historyTxIds.size;
		const newBalance = this.getBalance - (changes.totalInAmount - changes.totalOutAmount);
		const newTotalSent = this.getTotalSent - changes.totalOutAmount;
		const newTotalReceived = this.getTotalReceived - changes.totalInAmount;
		
		const w = new BinaryWriter(6 + 6 + 6 + 4 + 4 + (newNbUtxos * 15) + (newNbHistory * 6));
		w.writeBytes(serializer.converter.numberTo6Bytes(newBalance));
		w.writeBytes(serializer.converter.numberTo6Bytes(newTotalSent));
		w.writeBytes(serializer.converter.numberTo6Bytes(newTotalReceived));
		w.writeBytes(serializer.converter.numberTo4Bytes(newNbUtxos));
		w.writeBytes(serializer.converter.numberTo4Bytes(newNbHistory));
		
		// WRITE KEPT UTXOS
		const utxosBuffer = this.getUtxosBuffer;
		const indexesToSkip = this.#extractIndexesOfMatches(utxosBuffer, changes.in);
		for (let i = 0; i < newNbUtxos * 15; i += 15)
			if (!indexesToSkip.has(i)) w.writeBytes(utxosBuffer.subarray(i, i + 15));

		// WRITE NEW UTXOS
		for (const entryBytes of changes.out) w.writeBytes(entryBytes);

		// WRITE HISTORY TXIDS
		w.writeBytes(historyBytes.subarray(0, historyBytes.length - newHistoryBytes.length));

		// IF EVERYTHING OK => RETURN BYTES TO SAVE
		return w.getBytesOrThrow(`Ledger: writing incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
	}

	// INTERNALS
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