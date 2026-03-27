// @ts-check

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
	constructor(buffer) {
		this.view = new Uint8Array(buffer);
	}
	
	/** @param {number} length */
	read(length) {
		const [start, end] = [this.cursor, this.cursor + length];
		this.cursor = end;
		return this.view.slice(start, end);
	}
}