// @ts-check
import fs from 'fs';

export class BinaryHandler {
	fd; cursor;
	get size() { return this.cursor; }
	
	/** @param {string} filePath @param {boolean} [createIfMissing] Default: true */
	constructor(filePath, createIfMissing = true) {
		if (!fs.existsSync(filePath))
			if (createIfMissing) fs.writeFileSync(filePath, Buffer.alloc(0));
			else throw new Error(`File not found: ${filePath}`);

		this.fd = fs.openSync(filePath, 'r+');
		const stats = fs.fstatSync(this.fd);
		this.cursor = stats.size; // Start at end
	}

	/** @param {Uint8Array} data @param {number} [position] Default: this.cursor (append) */
	write(data, position = this.cursor) {
		fs.writeSync(this.fd, data, 0, data.length, position);
		if (position === this.cursor) this.cursor += data.length;
	}
	/** WILL NOT UPDATE CURSOR POSITION @param {Uint8Array} data @param {number} position */
	async writeAsync(data, position) {
		// use fs.write() with callback
		return new Promise((resolve, reject) => {
			fs.write(this.fd, data, 0, data.length, position, (err, bytesWritten) => {
				if (err) reject(err);
				else resolve(bytesWritten);
			});
		});
	}
	/** @param {number} position @param {number} length */
	read(position, length) {
		const buffer = Buffer.allocUnsafe(length);
		fs.readSync(this.fd, buffer, 0, length, position);
		return buffer; // Don't move cursor for reads
	}
	/** Truncate the file to a new size @param {number} newSize */
	truncate(newSize) {
		if (newSize < 0) throw new Error('Cannot truncate file below size 0');
		fs.ftruncateSync(this.fd, newSize);
		this.cursor = newSize;
	}
	/** Pre-touch all pages to force physical allocation (avoids cold-page cost on first random write)
	 * @param {number} size */
	preallocate(size) {
		const chunk = new Uint8Array(1024 * 1024);
		for (let offset = 0; offset < size; offset += chunk.length)
			fs.writeSync(this.fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
	}
	/** Close the file descriptor */
	close() {
		fs.closeSync(this.fd);
	}
}