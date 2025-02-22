// A primitive way to store the blockchain data and wallet data etc...
// As usual, use Ctrl + k, Ctrl + 0 to fold all blocks of code

import { BlockData, BlockUtils } from "../node/src/block-classes.mjs";
import { FastConverter } from "./converters.mjs";
import { serializer } from './serializer.mjs';
import { MiniLogger } from '../miniLogger/mini-logger.mjs';
import { Breather } from './breather.mjs';

/*import AdmZip from 'adm-zip';
import * as crypto from 'crypto';
const fs = await import('fs');
const path = await import('path');
const url = await import('url');*/ // -> DEPRECATED
if (false) {
    const AdmZip = require('adm-zip');
}

// -> Imports compatibility for Node.js, Electron and browser

let AdmZip, crypto, fs, path, url;
(async () => {
    try { fs = await import('fs'); } catch (error) { fs = window.fs; }
    try { path = await import('path'); } catch (error) { path = window.path; }
    try { url = await import('url'); } catch (error) { url = window.url; }
    try { AdmZip = await import('adm-zip').then(module => module.default); } catch (error) { AdmZip = window.AdmZip; }
    try { crypto = await import('crypto'); } catch (error) { crypto = window.crypto; }
})();

/**
* @typedef {import("../node/src/block-classes.mjs").BlockInfo} BlockInfo
* @typedef {import("../node/src/node.mjs").Node} Node
* @typedef {import("../node/src/transaction.mjs").Transaction} Transaction
*/

// GLOBALS VARS
/** @type {MiniLogger} */
const storageMiniLogger = new MiniLogger('storage');
const BLOCK_PER_DIRECTORY = 1000;
let isProductionEnv = false;

async function targetStorageFolder() {
    let storagePath = '';

    while (!url) { await new Promise(resolve => setTimeout(resolve, 10)); }
    const filePath = url.fileURLToPath(import.meta.url).replace('app.asar', 'app.asar.unpacked'); // path to the storage-manager.mjs file
    if (!filePath.includes('app.asar')) {
        const rootFolder = path.dirname(path.dirname(filePath));
        storagePath = path.join(path.dirname(rootFolder), 'contrast-storage');
    } else {
        isProductionEnv = true; 
        const rootFolder = path.dirname(path.dirname(path.dirname(path.dirname(filePath))));
        storagePath = path.join(path.dirname(rootFolder), 'contrast-storage');
        console.log('-----------------------------');
        console.log('-----------------------------');
        console.log(storagePath);
        console.log('-----------------------------');
        console.log('-----------------------------');
    }

    return { filePath, storagePath };
}
export function copyFolderRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();

    if (exists && isDirectory) {
        if (!fs.existsSync(dest)) { fs.mkdirSync(dest); }
        fs.readdirSync(src).forEach(function(childItemName) {
            copyFolderRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

const basePath = await targetStorageFolder();
// CLEANUP v0.0.4
const oldStoragePath1 = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'node', 'storage');
if (fs.existsSync(oldStoragePath1)) { fs.rmSync(oldStoragePath1, { recursive: true }); }
if (fs.existsSync(path.join(basePath.storagePath, 'nodeSetting.json'))) fs.rmSync(path.join(basePath.storagePath, 'nodeSetting.json'));
if (fs.existsSync(path.join(basePath.storagePath, 'nodesSettings.json'))) fs.rmSync(path.join(basePath.storagePath, 'nodesSettings.json'));
if (fs.existsSync(path.join(basePath.storagePath, 'nodeSettings.json'))) fs.rmSync(path.join(basePath.storagePath, 'nodeSettings.json'));

export const PATH = {
    BASE_FILE: basePath.filePath, // path to the storage-manager.mjs file
    STORAGE: basePath.storagePath, // path to the storage folder (out of the root directory)
    TRASH: path.join(basePath.storagePath, 'trash'),
    TXS_REFS: path.join(basePath.storagePath, 'addresses-txs-refs'),
    BLOCKS: path.join(basePath.storagePath, 'blocks'),
    JSON_BLOCKS: path.join(basePath.storagePath, 'json-blocks'),
    BLOCKS_INFO: path.join(basePath.storagePath, 'blocks-info'),
    SNAPSHOTS: path.join(basePath.storagePath, 'snapshots'),
    CHECKPOINTS: path.join(basePath.storagePath, 'checkpoints'),
    TEST_STORAGE: path.join(basePath.storagePath, 'test')
}
if (isProductionEnv) { delete PATH.TEST_STORAGE; delete PATH.JSON_BLOCKS; }
// create the storage folder if it doesn't exist, and any other subfolder
for (const dirPath of Object.values(PATH)) { if (!fs.existsSync(dirPath)) { fs.mkdirSync(dirPath); } }

export class Storage {
    /** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
    static saveBinary(fileName, serializedData, directoryPath) {
        try {
            const directoryPath__ = directoryPath || PATH.STORAGE;
            if (!fs.existsSync(directoryPath__)) { fs.mkdirSync(directoryPath__); }
            
            const filePath = path.join(directoryPath__, `${fileName}.bin`);
            fs.writeFileSync(filePath, serializedData);
            return true;
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); }

        return false;
    }
    /** @param {string} fileName @param {string} directoryPath */
    static loadBinary(fileName, directoryPath) {
        const directoryPath__ = directoryPath || PATH.STORAGE;
        const filePath = path.join(directoryPath__, `${fileName}.bin`);
        try {
            const buffer = fs.readFileSync(filePath);
            // const serializedData = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            return buffer; // work as Uint8Array
        } catch (error) {
            if (error.code === 'ENOENT') {
                storageMiniLogger.log(`File not found: ${filePath}`, (m) => { console.error(m); });
            } else {
                storageMiniLogger.log(error.stack, (m) => { console.error(m); });
            }
        }
        return false;
    }
    static isFileExist(fileNameWithExtension = 'toto.bin', directoryPath) {
        const directoryPath__ = directoryPath || PATH.STORAGE;
        const filePath = path.join(directoryPath__, fileNameWithExtension);
        return fs.existsSync(filePath);
    }
    /** Save data to a JSON file @param {string} fileName - The name of the file */
    static saveJSON(fileName, data) {
        try {
            const filePath = path.join(PATH.STORAGE, `${fileName}.json`);
            const subFolder = path.dirname(filePath);
            if (!fs.existsSync(subFolder)) { fs.mkdirSync(subFolder); }
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            storageMiniLogger.log(error.stack, (m) => { console.error(m); });
            return false;
        }
    }
    /** Load data from a JSON file @param {string} fileName - The name of the file */
    static loadJSON(fileName) {
        try {
            const filePath = path.join(PATH.STORAGE, `${fileName}.json`);
            return JSON.parse(fs.readFileSync(filePath));
        } catch (error) {
            return false;
        }
    }

    static deleteFile(fileNameWithExtension = 'toto.bin', directoryPath = PATH.STORAGE) {
        const filePath = path.join(directoryPath, fileNameWithExtension);
        if (fs.existsSync(filePath)) { fs.rmSync(filePath); }
    }
}

export class CheckpointsStorage {
    /** @param {number} checkpointHeight @param {string} fromPath - used to archive a checkpoint from a ACTIVE_CHECKPOINT folder */
    static async archiveCheckpoint(checkpointHeight = 0, fromPath) {
        try {
            /** @type {AdmZip} */
            const zip = new AdmZip();
            const breather = new Breather();

            if (fromPath) {
                const snapshotsPath = path.join(fromPath, 'snapshots');
                if (!fs.existsSync(snapshotsPath)) { throw new Error(`Snapshots folder not found at ${snapshotsPath}`); }
                zip.addLocalFolder(snapshotsPath, 'snapshots');
            } else {
                // we only need the corresponding snapshot for the checkpoint
                //! important to have valid AddressesTransactionsReferences in the archive
                const snapshotPath = path.join(PATH.SNAPSHOTS, checkpointHeight.toString());
                if (!fs.existsSync(snapshotPath)) { throw new Error(`Snapshot ${checkpointHeight.toString()} not found at ${snapshotPath}`); }
                zip.addLocalFolder(snapshotPath, `snapshots/${checkpointHeight.toString()}`);
            }
            //! old method avoided because of inconsistency with the snapshots:
            //! we only can save snapshot that can't be modified in the checkpoint.
            //const snapshotsPath = fromPath ? path.join(fromPath, 'snapshots') : PATH.SNAPSHOTS;
            //zip.addLocalFolder(snapshotsPath, 'snapshots');

            await breather.breathe();
            const addTxsRefsPath = fromPath ? path.join(fromPath, 'addresses-txs-refs') : PATH.TXS_REFS;
            zip.addLocalFolder(addTxsRefsPath, 'addresses-txs-refs');
            
            await breather.breathe();
            const addTxsRefsConfigPath = fromPath ? path.join(fromPath, 'AddressesTxsRefsStorage_config.json') : path.join(PATH.STORAGE, 'AddressesTxsRefsStorage_config.json');
            zip.addLocalFile(addTxsRefsConfigPath);

            await breather.breathe();
            const buffer = zip.toBuffer();
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');

            await breather.breathe();
            const heightPath = path.join(PATH.CHECKPOINTS, checkpointHeight.toString());
            if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }
            fs.writeFileSync(path.join(heightPath, `${hash}.zip`), buffer);
            return hash;
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); }
        
        return false;
    }
    /** @param {Buffer} buffer @param {string} hashToVerify */
    static unarchiveCheckpointBuffer(checkpointBuffer, hashToVerify) {
        try {
            const buffer = Buffer.from(checkpointBuffer);
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            if (hash !== hashToVerify) { storageMiniLogger.log('<> Hash mismatch! <>', (m) => { console.error(m); }); return false; }
    
            const destPath = path.join(PATH.STORAGE, 'ACTIVE_CHECKPOINT');
            if (fs.existsSync(destPath)) { fs.rmSync(destPath, { recursive: true }); }
            fs.mkdirSync(destPath, { recursive: true });
            /** @type {AdmZip} */
            const zip = new AdmZip(buffer);
            zip.extractAllTo(destPath, true);
    
            return true;
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); }

        return false;
    }
    static reset() {
        if (fs.existsSync(PATH.CHECKPOINTS)) { fs.rmSync(PATH.CHECKPOINTS, { recursive: true }); }
    }
}

/** Transactions references are stored in binary format, folder architecture is optimized for fast access */
export class AddressesTxsRefsStorage {
    configPath = path.join(PATH.STORAGE, 'AddressesTxsRefsStorage_config.json');
    snapHeight = -1;
    /** @type {Object<string, Object<string, Object<string, boolean>>} */
    architecture = {}; // lvl0: { lvl1: { address: true } }
    constructor() { this.#load(); }

    #load() {
        if (!fs.existsSync(this.configPath)) {
            storageMiniLogger.log('no config file found', (m) => { console.error(m); });
            return;
        }

        try {
            /** @type {number} */
            const config = JSON.parse(fs.readFileSync(this.configPath));
            this.snapHeight = config.snapHeight;
            this.architecture = config.architecture;

            storageMiniLogger.log('[AddressesTxsRefsStorage] => config loaded', (m) => { console.log(m); });
        } catch (error) { storageMiniLogger.log(error, (m) => { console.error(m); }); }
    }
    save(indexEnd) {
        this.snapHeight = indexEnd;
        const config = { snapHeight: indexEnd, architecture: this.architecture };
        fs.writeFileSync(this.configPath, JSON.stringify(config));
    }
    #dirPathOfAddress(address = '') {
        const lvl0 = address.slice(0, 2);
        if (this.architecture[lvl0] === undefined) {
            this.architecture[lvl0] = {};
            if (!fs.existsSync(path.join(PATH.TXS_REFS, lvl0))) { fs.mkdirSync(path.join(PATH.TXS_REFS, lvl0)); }
        }

        const lvl1 = address.slice(2, 3);
        if (this.architecture[lvl0][lvl1] === undefined) {
            this.architecture[lvl0][lvl1] = {};
            if (!fs.existsSync(path.join(PATH.TXS_REFS, lvl0, lvl1))) { fs.mkdirSync(path.join(PATH.TXS_REFS, lvl0, lvl1)); }
        }

        return { lvl0, lvl1 };
    }
    getTxsReferencesOfAddress(address = '') {
        if (typeof address !== 'string' || address.length !== 20) { return []; }

        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        if (!this.architecture[lvl0][lvl1][address]) { return []; }

        const filePath = path.join(PATH.TXS_REFS, lvl0, lvl1, `${address}.bin`);
        if (!fs.existsSync(filePath)) { // Clean the architecture if the file is missing
            delete this.architecture[lvl0][lvl1][address];
            if (Object.keys(this.architecture[lvl0][lvl1]).length === 0) { delete this.architecture[lvl0][lvl1]; }
            if (Object.keys(this.architecture[lvl0]).length === 0) { delete this.architecture[lvl0]; }
            return [];
        }

        const serialized = fs.readFileSync(filePath);
        /** @type {Array<string>} */
        const txsRefs = serializer.deserialize.txsReferencesArray(serialized);
        return txsRefs;
    }
    setTxsReferencesOfAddress(address = '', txsRefs = []) {
        const serialized = serializer.serialize.txsReferencesArray(txsRefs);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        this.architecture[lvl0][lvl1][address] = true;

        const dirPath = path.join(PATH.TXS_REFS, lvl0, lvl1);
        if (!fs.existsSync(dirPath)){ fs.mkdirSync(dirPath, { recursive: true }); }

        const filePath = path.join(dirPath, `${address}.bin`);
        fs.writeFileSync(filePath, serialized);
    }
    reset() {
        if (fs.existsSync(PATH.TXS_REFS)) { fs.rmSync(PATH.TXS_REFS, { recursive: true }); }
        if (fs.existsSync(this.configPath)) { fs.rmSync(this.configPath); }
        
        fs.mkdirSync(PATH.TXS_REFS);
        this.architecture = {};
        this.snapHeight = -1;
    }
}

export class BlockchainStorage {
    lastBlockIndex = -1;
    fastConverter = new FastConverter();
    batchFolders = BlockchainStorage.getListOfFoldersInBlocksDirectory(PATH.BLOCKS);
    /** @type {Object<number, string>} */
    hashByIndex = {"-1": "0000000000000000000000000000000000000000000000000000000000000000"};
    /** @type {Object<string, number>} */
    indexByHash = {"0000000000000000000000000000000000000000000000000000000000000000": 0};

    constructor() { this.#init(); }
    static getListOfFoldersInBlocksDirectory(blocksPath = PATH.BLOCKS) {
        const blocksFolders = fs.readdirSync(blocksPath).filter(fileName => fs.lstatSync(path.join(blocksPath, fileName)).isDirectory());
    
        // named as 0-999, 1000-1999, 2000-2999, etc... => sorting by the first number
        const blocksFoldersSorted = blocksFolders.sort((a, b) => parseInt(a.split('-')[0], 10) - parseInt(b.split('-')[0], 10));
        return blocksFoldersSorted;
    }
    #init() {
        let currentIndex = -1;
        for (let i = 0; i < this.batchFolders.length; i++) {
            const batchFolderName = this.batchFolders[i];
            const files = fs.readdirSync(path.join(PATH.BLOCKS, batchFolderName));
            for (let j = 0; j < files.length; j++) {
                const fileName = files[j].split('.')[0];
                const blockIndex = parseInt(fileName.split('-')[0], 10);
                const blockHash = fileName.split('-')[1];
                if (currentIndex >= blockIndex) {
                    storageMiniLogger.log(`---! Duplicate block index !--- #${blockIndex}`, (m) => { console.error(m); });
                    throw new Error(`Duplicate block index #${blockIndex}`);
                }

                this.hashByIndex[blockIndex] = blockHash;
                this.indexByHash[blockHash] = blockIndex;
                this.lastBlockIndex = Math.max(this.lastBlockIndex, blockIndex);
            }
        }

        storageMiniLogger.log(`BlockchainStorage initialized with ${this.lastBlockIndex + 1} blocks`, (m) => { console.log(m); });
    }
    static batchFolderFromBlockIndex(blockIndex = 0) {
        const index = Math.floor(blockIndex / BLOCK_PER_DIRECTORY);
        const name = `${Math.floor(blockIndex / BLOCK_PER_DIRECTORY) * BLOCK_PER_DIRECTORY}-${Math.floor(blockIndex / BLOCK_PER_DIRECTORY) * BLOCK_PER_DIRECTORY + BLOCK_PER_DIRECTORY - 1}`;
        return { index, name };
    }
    #blockFilePathFromIndexAndHash(blockIndex = 0, blockHash = '') {
        const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(blockIndex).name;
        const batchFolderPath = path.join(PATH.BLOCKS, batchFolderName);
        const blockFilePath = path.join(batchFolderPath, `${blockIndex.toString()}-${blockHash}.bin`);
        return blockFilePath;
    }
    /** @param {BlockData} blockData */
    #saveBlockBinary(blockData) {
        try {
            /** @type {Uint8Array} */
            const binary = serializer.serialize.block_finalized(blockData);
            const batchFolder = BlockchainStorage.batchFolderFromBlockIndex(blockData.index);
            const batchFolderPath = path.join(PATH.BLOCKS, batchFolder.name);
            if (this.batchFolders[batchFolder.index] !== batchFolder.name) {
                fs.mkdirSync(batchFolderPath);
                this.batchFolders.push(batchFolder.name);
            }

            const filePath = path.join(batchFolderPath, `${blockData.index.toString()}-${blockData.hash}.bin`);
            fs.writeFileSync(filePath, binary);
        } catch (error) {
            storageMiniLogger.log(error.stack, (m) => { console.error(m); });
        }
    }
    /** @param {BlockData} blockData @param {string} dirPath */
    #saveBlockDataJSON(blockData, dirPath) {
        const blockFilePath = path.join(dirPath, `${blockData.index}.json`);
        fs.writeFileSync(blockFilePath, JSON.stringify(blockData, (key, value) => { return value; }));
    }
    #getBlock(blockIndex = 0, blockHash = '', deserialize = true) {
        const blockFilePath = this.#blockFilePathFromIndexAndHash(blockIndex, blockHash);

        /** @type {Uint8Array} */
        const serialized = fs.readFileSync(blockFilePath);
        if (!deserialize) { return serialized; }

        /** @type {BlockData} */
        const blockData = serializer.deserialize.block_finalized(serialized);
        return blockData;
    }
    #loadBlockDataJSON(blockIndex = 0, dirPath = '') {
        const blockFileName = `${blockIndex.toString()}.json`;
        const filePath = path.join(dirPath, blockFileName);
        const blockContent = fs.readFileSync(filePath);
        const blockData = BlockUtils.blockDataFromJSON(blockContent);
        return blockData;
    }

    /** @param {BlockData} blockData @param {boolean} saveJSON */
    addBlock(blockData, saveJSON = false) {
        const prevHash = this.hashByIndex[blockData.index - 1];
        if (blockData.prevHash !== prevHash) { throw new Error(`Block #${blockData.index} rejected: prevHash mismatch`); }

        const existingBlockHash = this.hashByIndex[blockData.index];
        //if (existingBlockHash) { throw new Error(`Block #${blockData.index} already exists with hash ${existingBlockHash}`); }
        if (existingBlockHash) { this.removeBlock(blockData.index); }

        this.#saveBlockBinary(blockData);
        this.hashByIndex[blockData.index] = blockData.hash;
        this.indexByHash[blockData.hash] = blockData.index;

        if (isProductionEnv) { return; } // Avoid saving heavy JSON format in production
        if (saveJSON || blockData.index < 200) { this.#saveBlockDataJSON(blockData, PATH.JSON_BLOCKS); }
    }
    /** @param {BlockInfo} blockInfo */
    addBlockInfo(blockInfo) {
        const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(blockInfo.header.index).name;
        const batchFolderPath = path.join(PATH.BLOCKS_INFO, batchFolderName);
        if (!fs.existsSync(batchFolderPath)) { fs.mkdirSync(batchFolderPath); }

        const binary = serializer.serialize.rawData(blockInfo);
        const filePath = path.join(batchFolderPath, `${blockInfo.header.index.toString()}-${blockInfo.header.hash}.bin`);
        fs.writeFileSync(filePath, binary);
    }
    #blockHashIndexFormHeightOrHash(heightOrHash) {
        const blockHash = typeof heightOrHash === 'number' ? this.hashByIndex[heightOrHash] : heightOrHash;
        const blockIndex = typeof heightOrHash === 'string' ? this.indexByHash[heightOrHash] : heightOrHash;
        return { blockHash, blockIndex };
    }
    /** @param {number | string} heightOrHash - The height or the hash of the block to retrieve */
    retreiveBlock(heightOrHash, deserialize = true) {
        if (typeof heightOrHash !== 'number' && typeof heightOrHash !== 'string') { return null; }

        const { blockHash, blockIndex } = this.#blockHashIndexFormHeightOrHash(heightOrHash);
        if (blockIndex === -1) { return null; }
        if (blockHash === undefined || blockIndex === undefined) { return null; }

        const block = this.#getBlock(blockIndex, blockHash, deserialize);
        return block;
    }
    getBlockInfoByIndex(blockIndex = 0, deserialize = true) {
        const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(blockIndex).name;
        const batchFolderPath = path.join(PATH.BLOCKS_INFO, batchFolderName);
        const blockHash = this.hashByIndex[blockIndex];

        try {
            const blockInfoFilePath = path.join(batchFolderPath, `${blockIndex.toString()}-${blockHash}.bin`);
            const buffer = fs.readFileSync(blockInfoFilePath);
            if (!deserialize) { return new Uint8Array(buffer); }

            /** @type {BlockInfo} */
            const blockInfo = serializer.deserialize.rawData(buffer);
            return blockInfo;
        } catch (error) {
            storageMiniLogger.log(`BlockInfo not found ${blockIndex.toString()}-${blockHash}.bin`, (m) => { console.error(m); });
            storageMiniLogger.log(error.stack, (m) => { console.error(m); });
            return null;
        }
    }

    /** @param {Uint8Array} serializedBlock @param {string} txRef - The reference of the transaction to retrieve */
    #findTxPointerInSerializedBlock(serializedBlock, txRef = '41:5fbcae93') {
        const targetTxId = txRef.split(':')[1];
        const targetUint8Array = this.fastConverter.hexToUint8Array(targetTxId);
        const nbOfTxs = this.fastConverter.uint82BytesToNumber(serializedBlock.slice(0, 2));
        const pointersStart = 2 + 4 + 8 + 4 + 4 + 2 + 32 + 6 + 6 + 32 + 4;
        const pointersEnd = (pointersStart + nbOfTxs * 8) - 1;
        const pointersBuffer = serializedBlock.slice(pointersStart, pointersEnd + 1);
        
        for (let i = 0; i < pointersBuffer.length; i += 8) {
            if (!pointersBuffer.slice(i, i + 4).every((v, i) => v === targetUint8Array[i])) { continue; }

            const index = i / 8;
            const offsetStart = this.fastConverter.uint84BytesToNumber(pointersBuffer.slice(i + 4, i + 8));
            i += 8;
            if (i >= pointersBuffer.length) { return { index, start: offsetStart, end: serializedBlock.length }; }
            
            const offsetEnd = this.fastConverter.uint84BytesToNumber(pointersBuffer.slice(i, i + 4));
            return { index, start: offsetStart, end: offsetEnd };
        }

        return null;
    }
    /** @param {Uint8Array} serializedBlock @param {number} index @param {number} start @param {number} end */
    #readTxInSerializedBlockUsingPointer(serializedBlock, index = 0, start = 0, end = 1) {
        const txBuffer = serializedBlock.slice(start, end);
        /** @type {Transaction} */
        const tx = index < 2
            ? serializer.deserialize.specialTransaction(txBuffer)
            : serializer.deserialize.transaction(txBuffer);
        
        return tx;
    }
    retreiveTx(txRef = '41:5fbcae93') {
        const blockIndex = parseInt(txRef.split(':')[0], 10);
        const serializedBlock = this.retreiveBlock(blockIndex, false);
        if (!serializedBlock) { return null; }

        const txOffset = this.#findTxPointerInSerializedBlock(serializedBlock, txRef);
        if (!txOffset) { return null; }

        const { index, start, end } = txOffset;
        const tx = this.#readTxInSerializedBlockUsingPointer(serializedBlock, index, start, end);

        return tx;
    }

    removeBlock(blockIndex = 0) {
        const blockHash = this.hashByIndex[blockIndex];
        const blockFilePath = this.#blockFilePathFromIndexAndHash(blockIndex, blockHash);
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
        if (fs.existsSync(PATH.BLOCKS)) { fs.rmSync(PATH.BLOCKS, { recursive: true }); }
        fs.mkdirSync(PATH.BLOCKS);
        this.batchFolders = [];
        this.hashByIndex = { "-1": "0000000000000000000000000000000000000000000000000000000000000000" };
        this.indexByHash = { "0000000000000000000000000000000000000000000000000000000000000000": -1 };
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
//test();

/* 1100 files of 200 bytes each or 220KB => 1 block
Time to load a big file: 0.74550ms
Time to load multiple small files: 194.24940ms (~0.17657ms per tx)

Time to read dir: 0.54700ms
Time to load multiple small files async: 361.34590ms (~0.32847ms per tx)
*/