// @ts-check
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ContrastStorage } from '../../storage/storage.mjs';

// used to settle the difference between loading a big file and loading multiple small files
// also compare reading methods: sync, async, partial read, etc...
class TestStorage extends ContrastStorage {
	txBinaryWeight = 200; // in bytes
	txCount = 1100; // tx in a simulated block
	/** @param {string|null} masterHex - master hex string to generate local identifier */
	constructor(masterHex = '') { super(masterHex); }

	// erase all blocks
	reset() {
		fs.rmSync(this.PATH.TEST_STORAGE, { recursive: true });
		fs.mkdirSync(this.PATH.TEST_STORAGE);
	}
	#createRandomTx() {
		//const tx = new Uint8Array(this.txBinaryWeight);
		//crypto.getRandomValues(tx);
		const tx = crypto.randomBytes(this.txBinaryWeight);
		return tx;
	}
	#createRandomBlock() {
		const block = [];
		for (let i = 0; i < this.txCount; i++) block.push(this.#createRandomTx());
		return block;
	}
	/** @param {Uint8Array[]} block @param {number} index */
	async saveBlock(block, index) {
		const totalSize = block.reduce((acc, tx) => acc + tx.length, 0);
		const concatenated = new Uint8Array(totalSize);
		let offset = 0;
		for (let i = 0; i < block.length; i++) {
			concatenated.set(block[i], offset);
			offset += block[i].length;
		}

		await this.saveBinaryAsync(index.toString(), concatenated, this.PATH.TEST_STORAGE);
	}
	/** @param {Uint8Array[]} block @param {number} index */
	saveBlockDecomposed(block, index) {
		const blockDir = path.join(this.PATH.TEST_STORAGE, index.toString());
		for (let i = 0; i < block.length; i++) this.saveBinary(`${index}-${i}`, block[i], blockDir);
	}
	/** @param {Uint8Array[]} block @param {number} index */
	async saveBlockDecomposedAsync(block, index) {
		const blockDir = path.join(this.PATH.TEST_STORAGE, index.toString());
		const promises = [];
		for (let i = 0; i < block.length; i++)
			promises.push(this.saveBinaryAsync(`${index}-${i}`, block[i], blockDir));
		await Promise.all(promises);
	}
	async createAndSaveBlocks(num = 100, { unified = true, decomposed = true, async = false } = {}) {
		for (let i = 0; i < num; i++) {
			const block = this.#createRandomBlock();
			if (unified) await this.saveBlock(block, i);
			if (decomposed) this.saveBlockDecomposed(block, i);
		}
	}
	loadBlock(index = 0, count = this.txCount) {
		const block = [];
		const buffer = this.loadBinary(index.toString(), this.PATH.TEST_STORAGE);
		if (!buffer) throw new Error(`Unable to load block #${index}`);
		for (let i = 0; i < count; i++) {
			const start = i * this.txBinaryWeight;
			const end = start + this.txBinaryWeight;
			block.push(buffer.slice(start, end));
		}
		return block;
	}
	async loadBlockAsync(index = 0) {
		return await this.loadBinaryAsync(index.toString(), this.PATH.TEST_STORAGE);
	}
	getFilesInBlockDir(index = 0) {
		const blockDir = path.join(this.PATH.TEST_STORAGE, index.toString());
		return { blockDir, files: fs.readdirSync(blockDir) };
	}
	loadBlockDecomposed(index = 0, blockDir = '', filesCount = 0) {
		const block = [];
		for (let i = 0; i < filesCount; i++)
			block.push(this.loadBinary(`${index}-${i}`, blockDir));
		return block;
	}
	async loadBlockDecomposedAsync(index = 0, blockDir = '', filesCount = 0) {
		const loadPromises = [];
		for (let i = 0; i < filesCount; i++)
			loadPromises.push(this.loadBinaryAsync(`${index}-${i}`, blockDir));
		return await Promise.all(loadPromises);
	}
	readSpecificTxsFromBlock(index = 0, count = 1, log = true) {
		const logs = [];
		const block = [];
		let s = 0;
		if (log) s = performance.now();
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		if (log) logs.push(`Time to join path: ${(performance.now() - s).toFixed(5)}ms`);

		if (log) s = performance.now();
		const fd = fs.openSync(p, 'r');
		if (log) logs.push(`Time to open file: ${(performance.now() - s).toFixed(5)}ms`);

		if (log) s = performance.now();
		for (let i = 0; i < count; i++) {
			block.push(Buffer.allocUnsafe(this.txBinaryWeight));
			fs.readSync(fd, block[i], 0, this.txBinaryWeight, i * this.txBinaryWeight);
		}
		if (log) logs.push(`Time to read files: ${(performance.now() - s).toFixed(5)}ms`);

		if (log) s = performance.now();
		fs.closeSync(fd);
		if (log) logs.push(`Time to close file: ${(performance.now() - s).toFixed(5)}ms`);
		return { block, logs };
	}
	readXPercentOfBlockBytesTest(index = 0, percentRead = 10) {
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		const fd = fs.openSync(p, 'r');
		const size = fs.fstatSync(fd).size;
		const start = performance.now();
		const readSize = Math.floor(size * (percentRead / 100));
		const buffer = Buffer.allocUnsafe(readSize);
		fs.readSync(fd, buffer, 0, readSize, 0);
		console.log(`Time to read ${percentRead}% of block bytes: ${(performance.now() - start).toFixed(5)}ms`);
		fs.closeSync(fd);
		return buffer;
	}
	truncateBlock(index = 0, offset = 0) {
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		fs.truncateSync(p, offset);
	}
	truncateBlockByDesc(index = 0, newSize = 0) {
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		const fd = fs.openSync(p, 'r+');
		fs.ftruncateSync(fd, newSize);
		fs.closeSync(fd);
	}
	getBlockFileSize(index = 0) {
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		const fd = fs.openSync(p, 'r');
		const getSizeStart = performance.now();
		const stats = fs.fstatSync(fd);
		console.log(`Block size: ${stats.size} bytes (calculated in ${(performance.now() - getSizeStart).toFixed(5)}ms)`);
		fs.closeSync(fd);
		return stats.size;
	}
}
async function test() {
	const testStorage = new TestStorage('00000000000000000000000000000000000000000000000000000000000000ff');
	testStorage.txBinaryWeight *= 1;
	testStorage.txCount = 1100; //100 * 1024;
	testStorage.reset();
	const nbOfTxsToRead = 100;
	const wStart1 = performance.now();
	await testStorage.createAndSaveBlocks(2, { unified: true, decomposed: false });
	console.log(`Time to write test block (unified-sync): ${(performance.now() - wStart1).toFixed(5)}ms`);

	const wStart2 = performance.now();
	await testStorage.createAndSaveBlocks(2, { unified: true, decomposed: true });
	console.log(`Time to write test block (decomposed-sync): ${(performance.now() - wStart2).toFixed(5)}ms`);

	const wStart3 = performance.now();
	await testStorage.createAndSaveBlocks(2, { unified: false, decomposed: true, async: true });
	console.log(`Time to write test block (decomposed-async): ${(performance.now() - wStart3).toFixed(5)}ms`);

	testStorage.getBlockFileSize(0);
	testStorage.readXPercentOfBlockBytesTest(0, 1);
	testStorage.readXPercentOfBlockBytesTest(0, 10);
	testStorage.readXPercentOfBlockBytesTest(0, 100);

	//const { blockDir, files } = testStorage.getFilesInBlockDir(0);
	console.log(`Test with ${testStorage.txCount} txs of ${testStorage.txBinaryWeight} bytes each (~${(testStorage.txCount * testStorage.txBinaryWeight / 1024).toFixed(2)}KB total)`);
	
	console.log('--- SYNC Test start ---');
	
	const timeStart_C = performance.now();
	const loadedBlock_C = testStorage.loadBlock(0, nbOfTxsToRead); // for detailled timing
	const avgBigTime = ((performance.now() - timeStart_C) / nbOfTxsToRead).toFixed(5);
	console.log(`Time to read ${nbOfTxsToRead} txs (big block): ${(performance.now() - timeStart_C).toFixed(5)}ms (~${avgBigTime}ms per tx)`);
	
	// -------------------------------------
	console.log('--- Partial Read Test start ---');
	const { block, logs } = testStorage.readSpecificTxsFromBlock(1, 1); // for detailled timing
	//logs.push(`Time to read 1 tx: ${(performance.now() - timeStart_G).toFixed(5)}ms`);
	logs.forEach(log => console.log(log));
	const timeStart_G = performance.now();
	const r = testStorage.readSpecificTxsFromBlock(0, 1, false);
	console.log(`Time to read 1 tx: ${(performance.now() - timeStart_G).toFixed(5)}ms`);

	//testStorage.loadBlockDecomposed(0, blockDir, testStorage.txCount); // to reset OS cache
	
	const timeStart_H = performance.now();
	const { block: block2, logs: logs2 } = testStorage.readSpecificTxsFromBlock(1, nbOfTxsToRead, false);
	//logs2.push(`Time to read all txs: ${(performance.now() - timeStart_H).toFixed(5)}ms`);
	const avgPartialReadTime = ((performance.now() - timeStart_H) / nbOfTxsToRead).toFixed(5);
	console.log(`Time to read ${nbOfTxsToRead} txs: ${(performance.now() - timeStart_H).toFixed(5)}ms (~${avgPartialReadTime}ms per tx)`);



	const timeStart_T = performance.now();
	const truncatedOffset = Math.floor((testStorage.txBinaryWeight * testStorage.txCount) / 2);
	testStorage.truncateBlock(1, truncatedOffset);
	console.log(`Time to truncate block at offset ${truncatedOffset}: ${(performance.now() - timeStart_T).toFixed(5)}ms`);

	const timeStart_U = performance.now();
	testStorage.truncateBlockByDesc(0, truncatedOffset);
	console.log(`Time to truncate block by desc to new size ${truncatedOffset}: ${(performance.now() - timeStart_U).toFixed(5)}ms`);

	console.log('--- Test end ---');
}
//test();

/* 1100 files of 200 bytes each or 220KB => 1 block
Time to load a big file: 0.74550ms
Time to load multiple small files: 194.24940ms (~0.17657ms per tx)

Time to read dir: 0.54700msJe
Time to load multiple small files async: 361.34590ms (~0.32847ms per tx)
*/