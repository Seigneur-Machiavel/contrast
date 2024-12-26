import { BlockData, BlockUtils } from "../node/src/block-classes.mjs";
import { serializer } from './serializer.mjs';
import { MiniLogger } from '../miniLogger/mini-logger.mjs';

/**
* @typedef {import("../node/src/block-classes.mjs").BlockData} BlockData
* @typedef {import("../node/src/block-classes.mjs").BlockInfo} BlockInfo
* @typedef {import("../node/src/node.mjs").Node} Node
*/

/** @type {MiniLogger} */
const storageMiniLogger = new MiniLogger('storage');
const fs = await import('fs');
const path = await import('path');
const url = await import('url');
const __filename = url.fileURLToPath(import.meta.url);
const parentFolder = path.dirname(__filename);
const __dirname = path.join(path.dirname(parentFolder), 'node');

// A primitive way to store the blockchain data and wallet data etc...
// Only few functions are exported, the rest are used internally
// As usual, use Ctrl + k, Ctrl + 0 to fold all blocks of code

// GLOBALS
const BLOCK_PER_DIRECTORY = 1000;

// PATHS
const PATH = {
    STORAGE: path.join(__dirname, 'storage'),
    BLOCKS: path.join(__dirname, 'storage', 'blocks'),
    BLOCKS_INFO: path.join(__dirname, 'storage', 'blocks-info'),
    //SNAPSHOTS: path.join(__dirname, 'storage', 'snapshots'),
    //TRASH: path.join(__dirname, 'storage', 'trash'),
    TEST_STORAGE: path.join(__dirname, 'test-storage'),
}
if (path && !fs.existsSync(PATH.STORAGE)) { fs.mkdirSync(PATH.STORAGE); }
if (path && !fs.existsSync(PATH.BLOCKS)) { fs.mkdirSync(PATH.BLOCKS); }
if (path && !fs.existsSync(PATH.BLOCKS_INFO)) { fs.mkdirSync(PATH.BLOCKS_INFO); }
//if (path && !fs.existsSync(PATH.SNAPSHOTS)) { fs.mkdirSync(PATH.SNAPSHOTS); }
//if (path && !fs.existsSync(PATH.TRASH)) { fs.mkdirSync(PATH.TRASH); }
if (path && !fs.existsSync(PATH.TEST_STORAGE)) { fs.mkdirSync(PATH.TEST_STORAGE); }

function getListOfFoldersInBlocksDirectory() {
    const blocksFolders = fs.readdirSync(PATH.BLOCKS).filter(fileName => fs.lstatSync(path.join(PATH.BLOCKS, fileName)).isDirectory());
    
    // named as 0-999, 1000-1999, 2000-2999, etc... => sorting by the first number
    const blocksFoldersSorted = blocksFolders.sort((a, b) => parseInt(a.split('-')[0], 10) - parseInt(b.split('-')[0], 10));
    return blocksFoldersSorted;
}

// DEV FONCTIONS (USING JSON FORMAT - slow but useful for debugging)
/** @param {number} blockIndex @param {string} dirPath */
function loadBlockDataJSON(blockIndex, dirPath) {
    const blockFileName = `${blockIndex.toString()}.json`;
    const filePath = path.join(dirPath, blockFileName);
    const blockContent = fs.readFileSync(filePath, 'utf8');
    const blockData = BlockUtils.blockDataFromJSON(blockContent);
    
    return blockData;
}
/** @param {BlockData} blockData @param {string} dirPath */
function saveBlockDataJSON(blockData, dirPath) {
    const blockFilePath = path.join(dirPath, `${blockData.index}.json`);
    fs.writeFileSync(blockFilePath, JSON.stringify(blockData, (key, value) => {
        if (value === undefined) {
          return undefined; // Exclude from the result
        }
        return value; // Include in the result
      }), 'utf8');
}

export class Storage {
    /** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
    static saveBinary(fileName, serializedData, directoryPath) {
        try {
            const directoryPath__ = directoryPath || PATH.STORAGE;
            if (!fs.existsSync(directoryPath__)) { fs.mkdirSync(directoryPath__); }
            
            const filePath = path.join(directoryPath__, `${fileName}.bin`);
            fs.writeFileSync(filePath, serializedData, 'binary');
        } catch (error) {
            storageMiniLogger.log(error.stack, (m) => { console.error(m); });
            return false;
        }
    }
    /** @param {string} fileName @param {string} directoryPath */
    static loadBinary(fileName, directoryPath) {
        try {
            const directoryPath__ = directoryPath || PATH.STORAGE;
            const filePath = path.join(directoryPath__, `${fileName}.bin`);
            const buffer = fs.readFileSync(filePath);
            // const serializedData = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            return buffer; // work as Uint8Array
        }
        catch (error) {
            storageMiniLogger.log(error.stack, (m) => { console.error(m); });
            return false;
        }
    }
    /** Save data to a JSON file @param {string} fileName - The name of the file */
    static saveJSON(fileName, data) {
        try {
            const filePath = path.join(PATH.STORAGE, `${fileName}.json`);
            const subFolder = path.dirname(filePath);
            if (!fs.existsSync(subFolder)) { fs.mkdirSync(subFolder); }
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            storageMiniLogger.log(error.stack, (m) => { console.error(m); });
            return false;
        }
    }
    /** Load data from a JSON file @param {string} fileName - The name of the file */
    static loadJSON(fileName) {
        try {
            const filePath = path.join(PATH.STORAGE, `${fileName}.json`);
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            return false;
        }
    }
}

export class BlockchainStorage {
    batchFolders = getListOfFoldersInBlocksDirectory();
    /** @type {Object<number, string>} */
    hashByIndex = {};
    /** @type {Object<string, number>} */
    indexByHash = {};
    lastBlockIndex = -1;

    constructor() { this.#init(); }
    #init() {
        for (let i = 0; i < this.batchFolders.length; i++) {
            const batchFolderPath = this.batchFolders[i];
            const files = fs.readdirSync(path.join(PATH.BLOCKS, batchFolderPath));
            for (let j = 0; j < files.length; j++) {
                const fileName = files[j].split('.')[0];
                const blockIndex = parseInt(fileName.split('-')[0], 10);
                const blockHash = fileName.split('-')[1];
                this.hashByIndex[blockIndex] = blockHash;
                this.indexByHash[blockHash] = blockIndex;
                this.lastBlockIndex = Math.max(this.lastBlockIndex, blockIndex);
            }
        }

        storageMiniLogger.log(`BlockchainStorage initialized with ${this.lastBlockIndex + 1} blocks`, (m) => { console.log(m); });
    }
    #batchFolderFromBlockIndex(blockIndex = 0) {
        return `${Math.floor(blockIndex / BLOCK_PER_DIRECTORY) * BLOCK_PER_DIRECTORY}-${Math.floor(blockIndex / BLOCK_PER_DIRECTORY) * BLOCK_PER_DIRECTORY + BLOCK_PER_DIRECTORY - 1}`;
    }

    /** @param {BlockData} blockData */
    #saveBlockBinary(blockData) {
        try {
            const binary = serializer.rawData.toBinary_v1(blockData);

            const batchFolderName = this.#batchFolderFromBlockIndex(blockData.index);
            const batchFolderPath = path.join(PATH.BLOCKS, batchFolderName);
            if (!this.batchFolders.includes(batchFolderName)) {
                fs.mkdirSync(batchFolderPath);
                this.batchFolders.push(batchFolderName);
            }

            const filePath = path.join(batchFolderPath, `${blockData.index.toString()}-${blockData.hash}.bin`);
            fs.writeFileSync(filePath, binary);
        } catch (error) {
            storageMiniLogger.log(error.stack, (m) => { console.error(m); });
        }
    }
    #getBlock(blockIndex = 0, blockHash = '', deserialize = true) {
        const batchFolderPath = path.join(PATH.BLOCKS, this.#batchFolderFromBlockIndex(blockIndex));
        const blockFilePath = path.join(batchFolderPath, `${blockIndex.toString()}-${blockHash}.bin`);

        /** @type {Uint8Array} */
        const serialized = fs.readFileSync(blockFilePath);
        if (!deserialize) { return serialized; }

        /** @type {BlockData} */
        const blockData = serializer.rawData.fromBinary_v1(serialized);
        return blockData;
    }

    /** @param {BlockData} blockData @param {boolean} saveJSON */
    addBlock(blockData, saveJSON = false) {
        this.#saveBlockBinary(blockData);
        this.hashByIndex[blockData.index] = blockData.hash;
        this.indexByHash[blockData.hash] = blockData.index;
        if (saveJSON) { saveBlockDataJSON(blockData, PATH.BLOCKS); }
    }
    /** @param {BlockInfo} blockInfo */
    addBlockInfo(blockInfo) {
        const batchFolderName = this.#batchFolderFromBlockIndex(blockInfo.header.index);
        const batchFolderPath = path.join(PATH.BLOCKS_INFO, batchFolderName);
        if (!fs.existsSync(batchFolderPath)) { fs.mkdirSync(batchFolderPath); }

        const binary = serializer.rawData.toBinary_v1(blockInfo);
        const filePath = path.join(batchFolderPath, `${blockInfo.header.index.toString()}-${blockInfo.header.hash}.bin`);
        fs.writeFileSync(filePath, binary);
    }
    /** @param {number | string} heightOrHash - The height or the hash of the block to retrieve */
    retreiveBlock(heightOrHash, deserialize = true) {
        if (typeof heightOrHash !== 'number' && typeof heightOrHash !== 'string') { return null; }

        const blockHash = typeof heightOrHash === 'number' ? this.hashByIndex[heightOrHash] : heightOrHash;
        const blockIndex = typeof heightOrHash === 'string' ? this.indexByHash[heightOrHash] : heightOrHash;
        if (blockHash === undefined || blockIndex === undefined) { return null; }

        return this.#getBlock(blockIndex, blockHash, deserialize);
    }
    getBlockInfoByIndex(blockIndex = 0) {
        const batchFolderName = this.#batchFolderFromBlockIndex(blockIndex);
        const batchFolderPath = path.join(PATH.BLOCKS_INFO, batchFolderName);

        try {
            const blockHash = this.hashByIndex[blockIndex];
            const blockInfoFilePath = path.join(batchFolderPath, `${blockIndex.toString()}-${blockHash}.bin`);
            const buffer = fs.readFileSync(blockInfoFilePath);
            /** @type {BlockInfo} */
            const blockInfo = serializer.rawData.fromBinary_v1(buffer);
            return blockInfo;
        } catch (error) {
            storageMiniLogger.log(error.stack, (m) => { console.error(m); });
            return null;
        }
    }
    removeBlock(blockIndex = 0) {
        const blockHash = this.hashByIndex[blockIndex];
        const batchFolderPath = path.join(PATH.BLOCKS, this.#batchFolderFromBlockIndex(blockIndex));
        const blockFilePath = path.join(batchFolderPath, `${blockIndex.toString()}-${blockHash}.bin`);
        fs.unlinkSync(blockFilePath);

        delete this.hashByIndex[blockIndex];
        delete this.indexByHash[blockHash];
        this.lastBlockIndex = Math.max(...Object.keys(this.hashByIndex)); // optional
    }
    removeBlocksHigherThan(blockIndex = 0) {
        for (let i = blockIndex + 1; i <= this.lastBlockIndex; i++) {
            if (this.hashByIndex[i] === undefined) { break; }
            this.removeBlock(i);
        }
    }
    reset() {
        fs.rmSync(PATH.BLOCKS, { recursive: true });
        fs.mkdirSync(PATH.BLOCKS);
        this.batchFolders = [];
        this.hashByIndex = {};
        this.indexByHash = {};
        this.lastBlockIndex = -1;
    }
}

// used to settle the difference between loading a big file and loading multiple small files
class TestStorage {
    txBinaryWeight = 200; // in bytes
    txCount = 1100; // tx in a simulated block

    // erase all blocks
    reset() {
        fs.rmSync(PATH.TEST_STORAGE, { recursive: true });
        fs.mkdirSync(PATH.TEST_STORAGE);
    }
    #createRandomTx() {
        const tx = new Uint8Array(this.txBinaryWeight);
        crypto.getRandomValues(tx);
        return tx;
    }
    #createRandomBlock() {
        const block = [];
        for (let i = 0; i < this.txCount; i++) { block.push(this.#createRandomTx()); }
        return block;
    }
    saveBlock(block, index) {
        const totalSize = block.reduce((acc, tx) => acc + tx.length, 0);
        const concatenated = new Uint8Array(totalSize);
        let offset = 0;
        for (let i = 0; i < block.length; i++) {
            concatenated.set(block[i], offset);
            offset += block[i].length;
        }

        Storage.saveBinary(index.toString(), concatenated, PATH.TEST_STORAGE);
    }
    saveBlockDecomposed(block, index) {
        const blockDir = path.join(PATH.TEST_STORAGE, index.toString());
        for (let i = 0; i < block.length; i++) { Storage.saveBinary(`${index}-${i}`, block[i], blockDir); }
    }
    createAndSaveBlocks(num = 100) {
        for (let i = 0; i < num; i++) {
            const block = this.#createRandomBlock();
            this.saveBlock(block, i);
            this.saveBlockDecomposed(block, i);
        }
    }

    loadBlock(index) {
        return Storage.loadBinary(index.toString(), PATH.TEST_STORAGE);
    }
    loadBlockDecomposed(index) {
        const blockDir = path.join(PATH.TEST_STORAGE, index.toString());
        const files = fs.readdirSync(blockDir);
        const block = [];
        for (let i = 0; i < files.length; i++) { block.push(Storage.loadBinary(`${index}-${i}`, blockDir)); }
        return block;
    }
}
async function test() {
    //await new Promise(resolve => setTimeout(resolve, 1000));

    const testStorage = new TestStorage();
    testStorage.reset();
    testStorage.createAndSaveBlocks(1);

    const timeStart_A = performance.now();
    const loadedBlock_A = testStorage.loadBlock(0);
    console.log(`Time to load a big file: ${(performance.now() - timeStart_A).toFixed(5)}ms`);

    const timeStart_B = performance.now();
    const loadedBlock_B = testStorage.loadBlockDecomposed(0);
    const avgSmallTime = ((performance.now() - timeStart_B) / testStorage.txCount).toFixed(5);
    console.log(`Time to load multiple small files: ${(performance.now() - timeStart_B).toFixed(5)}ms (~${avgSmallTime}ms per tx)`);
}
test();

/* 1100 txs
Time to load a big file: 0.74550ms
Time to load multiple small files: 194.24940ms (~0.17657ms per tx)

Time to read dir: 0.54700ms
Time to load multiple small files async: 361.34590ms (~0.32847ms per tx)
*/