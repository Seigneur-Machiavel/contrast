// @ts-check

import { SIZES } from "./serializer-schema.mjs";
const isNode = typeof self === 'undefined';

/** BinaryWriter is used to write data to a Uint8Array buffer. It has a cursor that moves forward as data is written.
 * - Made to improve clarity and performance of serialization functions in serializer.js by minimizing garbage and avoiding array concatenations.
 * - Caution 1: writing functions must ensure that the buffer is large enough for the data to write, otherwise it will throw an error or write incomplete data without warning.
 * - Caution 2: avoid race conditions by not sharing the same BinaryWriter instance across different functions or asynchronous operations. */
export class BinaryWriter {
	get isWritingComplete() { return this.cursor === this.view.length; }
	cursor = 0;
	buffer;
	view;

	/** @param {number} size */
	constructor(size) {
		this.buffer = isNode ? Buffer.allocUnsafe(size) : new ArrayBuffer(size);
		this.view = new Uint8Array(this.buffer);
	}
	/** @param {number} v Should be a 16-bit unsigned integer (0-65535) */
	#writeU16BE(v, offset = this.cursor) {
		this.view[offset] = (v >> 8) & 0xff; this.view[offset + 1] = v & 0xff;
	}

	/** @param {number} byte */
	writeByte(byte) {
		this.view[this.cursor] = byte;
		this.cursor++;
	}
	/** @param {Uint8Array} data */
	writeBytes(data) {
		this.view.set(data, this.cursor);
		this.cursor += data.length;
	}

	// WRITE LIST OF DATA CHUNKS WITH POINTERS
	/** Calculate the total size in bytes of the pointer map for a given list of data chunks.
	 * + The number of pointers (2 bytes)
	 * + Each pointer (2 bytes)
	 * + Pointer at the end of the map to indicate the end of the last data chunk. (2 bytes)
	 * @param {Uint8Array[]} listOfData */
	static calculatePointersSize(listOfData) {
		return SIZES.pointer.bytes + (listOfData.length * SIZES.pointer.bytes) + SIZES.pointer.bytes;
	}
	/** Write a pointer, which is a list of offsets pointing to the start of each data chunk in the final serialized buffer.
	 * @param {Uint8Array[]} listOfData */
	writePointers(listOfData) {
		// write the number of pointers at the beginning of the pointer map (2b)
		this.#writeU16BE(listOfData.length, this.cursor);
		
		const pointersBytes = BinaryWriter.calculatePointersSize(listOfData);
		let o = this.cursor + pointersBytes; // calculate the offset where the data chunks will start (after the pointer map)
		for (let i = 0; i < listOfData.length; i++) { // WRITE POINTERS (2b each)
			const dataChunkLength = listOfData[i].length;
			const offsetPosition = this.cursor + 2 + (i * SIZES.pointer.bytes);
			this.#writeU16BE(o, offsetPosition); // write the offset of the current data chunk in the pointer map
			o += dataChunkLength; // increment the offset for the next pointer by the length of the current data chunk
		}

		// write end of the last data chunk at the end of the pointer map for easier reading
		this.#writeU16BE(o, this.cursor + 2 + (listOfData.length * SIZES.pointer.bytes));
		this.cursor += pointersBytes; // move the cursor after the pointers
	}
	/** Convenience function to write the pointers and the data chunks in one call. @param {Uint8Array[]} listOfData */
	writePointersAndDataChunks(listOfData) {
		this.writePointers(listOfData);
		for (const data of listOfData) this.writeBytes(data);
	}

	// RESULT AND ERROR HANDLING
	getBytes() { return this.view; }
	getBytesOrThrow(errorMessage = 'BinaryWriter: Not enough data written') {
		if (this.cursor === this.view.length) return this.view;
		else throw new Error(errorMessage);
	}
}

/** BinaryReader is used to read data from a Uint8Array buffer. It has a cursor that moves forward as data is read.
 * - Made to improve clarity and performance of deserialization functions in serializer.js by minimizing garbage and avoiding array slicing.
 * - Caution 1: reading functions must ensure that they do not read beyond the buffer length, otherwise it will throw an error or read incomplete data without warning.
 * - Caution 2: avoid race conditions by not sharing the same BinaryReader instance across different functions or asynchronous operations. */
export class BinaryReader {
	get isReadingComplete() { return this.cursor === this.view.length; }
	cursor = 0;
	view;

	/** @param {ArrayBuffer | Uint8Array} buffer */
	constructor(buffer) { this.view = new Uint8Array(buffer); }

	/** @returns {number} A 16-bit unsigned integer read from the buffer at the current cursor position, in big-endian format. */
	#readU16BE(offset = this.cursor) {
		return (this.view[offset] << 8) | this.view[offset + 1];
	}

	/** @param {number} length */
	read(length) {
		const [start, end] = [this.cursor, this.cursor + length];
		this.cursor = end;
		return this.view.slice(start, end);
	}
	/** Read a pointer, which is a list of offsets pointing to the start of each data chunk in the serialized buffer. */
	readPointers() {
		const numberOfPointers = this.#readU16BE(); // read the number of pointers at the beginning of the pointer map
		const pointers = []; // read each pointer (2b each)
		for (let i = 0; i < numberOfPointers; i++) pointers.push(this.#readU16BE());
		const endOfLastDataChunk = this.#readU16BE(); // read the end of the last data chunk at the end of the pointer map for easier reading
		return { pointers, endOfLastDataChunk };
	}
	/** @param {number[]} pointers @param {number} endOfLastDataChunk */
	readFollowingThePointers(pointers, endOfLastDataChunk) {
		const dataChunks = [];
		for (let i = 0; i < pointers.length; i++) {
			const start = pointers[i];
			const end = pointers[i + 1] || endOfLastDataChunk; // pointer can only be > 0 or -1 (so => endOfLastDataChunk)
			dataChunks.push(this.read(end - start));
		}
		return dataChunks;
	}
	/** Convenience function to read the pointers and the following data chunks in one call. */
	readPointersAndExtractDataChunks() {
		const { pointers, endOfLastDataChunk } = this.readPointers();
		return this.readFollowingThePointers(pointers, endOfLastDataChunk);
	}
}