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
    const fs = require('fs');
    const path = require('path');
    const url = require('url');
    const crypto = require('crypto');
    const AdmZip = require('adm-zip');
}

// -> Imports compatibility for Node.js, Electron and browser

let archiver, AdmZip, crypto, fs, path, url;
(async () => {
    try { fs = await import('fs'); } catch (error) { fs = window.fs; }
    try { path = await import('path'); } catch (error) { path = window.path; }
    try { url = await import('url'); } catch (error) { url = window.url; }
    try { crypto = await import('crypto'); } catch (error) { crypto = window.crypto; }
    try { AdmZip = await import('adm-zip').then(module => module.default); }
    catch (error) { try { AdmZip = window.AdmZip; } catch (error) {} };
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
    TEST_STORAGE: path.join(basePath.storagePath, 'test'),
    //APPS_STORAGE: path.join(basePath.storagePath, 'apps'),
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
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); return false; }
    }
    /** @param {string} fileName @param {string} directoryPath */
    static loadBinary(fileName, directoryPath) {
        const directoryPath__ = directoryPath || PATH.STORAGE;
        const filePath = path.join(directoryPath__, `${fileName}.bin`);
        try { return fs.readFileSync(filePath) } // work as Uint8Array
        catch (error) {
            if (error.code === 'ENOENT') storageMiniLogger.log(`File not found: ${filePath}`, (m) => { console.error(m); });
            else storageMiniLogger.log(error.stack, (m) => { console.error(m); });
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
            if (!fs.existsSync(subFolder)) fs.mkdirSync(subFolder);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); return false }
    }
    /** Load data from a JSON file @param {string} fileName - The name of the file */
    static loadJSON(fileName) {
        try { return JSON.parse(fs.readFileSync( path.join(PATH.STORAGE, `${fileName}.json`) )) }
        catch (error) { return false }
    }
    static deleteFile(fileNameWithExtension = 'toto.bin', directoryPath = PATH.STORAGE) {
        const filePath = path.join(directoryPath, fileNameWithExtension);
        if (fs.existsSync(filePath)) fs.rmSync(filePath);
    }
    static dumpTrashFolder() {
        if (fs.existsSync(PATH.TRASH)) fs.rmSync(PATH.TRASH, { recursive: true });
        fs.mkdirSync(PATH.TRASH);
    }
}
export class StorageAsync {
    // savebin and loadbin only
    /** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
    static async saveBinary(fileName, serializedData, directoryPath) {
        try {
            const directoryPath__ = directoryPath || PATH.STORAGE;
            if (!fs.existsSync(directoryPath__)) { fs.mkdirSync(directoryPath__); }

            const filePath = path.join(directoryPath__, `${fileName}.bin`);
            await fs.promises.writeFile(filePath, serializedData);
            return true;
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); }

        return false;
    }
    /** @param {string} fileName @param {string} directoryPath */
    static async loadBinary(fileName, directoryPath) {
        const directoryPath__ = directoryPath || PATH.STORAGE;
        const filePath = path.join(directoryPath__, `${fileName}.bin`);
        try {
            const buffer = await fs.promises.readFile(filePath);
            return buffer;
        } catch (error) {
            if (error.code !== 'ENOENT') storageMiniLogger.log(error.stack, (m) => { console.error(m); });
            else storageMiniLogger.log(`File not found: ${filePath}`, (m) => { console.error(m); });
        }
        return false;
    }
}

export class CheckpointsStorage {
    static maxSnapshotsInCheckpoints = 3; // number of snapshots to keep in checkpoints
    static hashOfSnapshotFolder(folderPath) {
        // load files (.bin) of snapshot folder to hash them
        const files = fs.readdirSync(folderPath);
        let hashBin = Buffer.alloc(0);
        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const bin = fs.readFileSync(filePath);
            const fileHash = crypto.createHash('sha256').update(bin).digest();
            // addition of hashes to create a unique hash for the folder
            hashBin = Buffer.concat([hashBin, fileHash]);
        }

        /** @type {Buffer} */
        const folderHash = crypto.createHash('sha256').update(hashBin).digest();
        return folderHash;
    }
    /** 
     * @param {number} checkpointHeight
     * @param {string} fromPath
     * @param {number[]} snapshotsHeights - used to archive a checkpoint from a ACTIVE_CHECKPOINT folder
     * @param {number[]} neededSnapHeights */
    static async archiveCheckpoint(checkpointHeight = 0, fromPath, snapshotsHeights, neededSnapHeights) {
        try {
            /** @type {AdmZip} */
            const zip = new AdmZip();
            const breather = new Breather();
            const fromSnapshotsPath = fromPath ? path.join(fromPath, 'snapshots') : PATH.SNAPSHOTS;
            if (!fs.existsSync(fromSnapshotsPath)) throw new Error(`Snapshots folder not found at ${fromSnapshotsPath}`);

            /** @type {Buffer[]} */
            const snapshotsHashes = [];
            for (let i = snapshotsHeights.length - 1; i >= 0; i--) {
                if (snapshotsHashes.length >= CheckpointsStorage.maxSnapshotsInCheckpoints) break;
                if (!neededSnapHeights.includes(snapshotsHeights[i])) continue; // skip the needed snapshots
                const snapshotHeight = snapshotsHeights[i].toString();
                const snapshotPath = path.join(fromSnapshotsPath, snapshotHeight);
                if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot ${snapshotHeight} not found at ${snapshotPath}`);

                snapshotsHashes.push(CheckpointsStorage.hashOfSnapshotFolder(snapshotPath));
                zip.addLocalFolder(snapshotPath, `snapshots/${snapshotHeight}`);
                await breather.breathe();
            }
            //zip.addLocalFolder(snapshotsPath, 'snapshots');
            
            const hashesBuffer = Buffer.concat(snapshotsHashes);
            /** @type {string} */
            const hash = crypto.createHash('sha256').update(hashesBuffer).digest('hex');

            const buffer = zip.toBuffer();
            await breather.breathe();
            const heightPath = path.join(PATH.CHECKPOINTS, checkpointHeight.toString());
            if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }
            fs.writeFileSync(path.join(heightPath, `${hash}.zip`), buffer);
            return hash;
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); return false; }
    }
    /** @param {Buffer} buffer @param {string} hashToVerify */
    static unarchiveCheckpointBuffer(checkpointBuffer, hashToVerify) {
        try {
            const buffer = Buffer.from(checkpointBuffer);
            const hash_V1 = crypto.createHash('sha256').update(buffer).digest('hex');
            const isValidHash_V1 = hash_V1 === hashToVerify;
            if (!isValidHash_V1) storageMiniLogger.log('<> Hash V1 mismatch! <>', (m) => { console.error(m); });
            //if (hash !== hashToVerify) { storageMiniLogger.log('<> Hash mismatch! <>', (m) => { console.error(m); }); return false; }
    
            const destPath = path.join(PATH.STORAGE, 'ACTIVE_CHECKPOINT');
            if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true });
            fs.mkdirSync(destPath, { recursive: true });

            /** @type {AdmZip} */
            const zip = new AdmZip(buffer);
            zip.extractAllTo(destPath, true);

            // HASH CHECK
            let isValidHash_V2 = false;
            try {
                /** @type {Buffer[]} */
                const snapshotsHashes = [];
                const snapshotsDir = path.join(destPath, 'snapshots');
                if (!fs.existsSync(snapshotsDir)) throw new Error(`Snapshots folder not found at ${snapshotsDir}`);
    
                const snapshotsFolders = fs.readdirSync(snapshotsDir);
                for (const folder of snapshotsFolders) {
                    const folderPath = path.join(snapshotsDir, folder);
                    if (fs.lstatSync(folderPath).isDirectory())
                        snapshotsHashes.push(CheckpointsStorage.hashOfSnapshotFolder(folderPath));
                }
    
                const buffer = Buffer.concat(snapshotsHashes);
                const hash_V2 = crypto.createHash('sha256').update(buffer).digest('hex');
                if (hash_V2 !== hashToVerify) { storageMiniLogger.log('<> Hash mismatch! <>', (m) => { console.error(m); }); return false; }
                isValidHash_V2 = hash_V2 === hashToVerify;
            } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); }

            if (!isValidHash_V2) storageMiniLogger.log('<> Hash V2 mismatch! <>', (m) => { console.error(m); });
            if (!isValidHash_V1 && !isValidHash_V2) storageMiniLogger.log('--- Checkpoint is corrupted! ---', (m) => { console.error(m); });
            return true;
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); return false }
    }
    static reset() {
        if (fs.existsSync(PATH.CHECKPOINTS)) fs.rmSync(PATH.CHECKPOINTS, { recursive: true });
    }
}

/** Transactions references are stored in binary format, folder architecture is optimized for fast access
 * @typedef {Object} addTxsRefsInfo
 * @property {number} highestIndex - The highest index of the transactions referenced (including temp refs)
 * @property {number} totalTxsRefs - The total number of transactions referenced (excluding temp refs)
 */
export class AddressesTxsRefsStorage {
    codeVersion = 4;
    version = 0;
    loaded = false;
    configPath = path.join(PATH.STORAGE, 'AddressesTxsRefsStorage_config.json');
    batchSize = 1000; // number of transactions references per file
    snapHeight = -1;
    /** @type {Object<string, Object<string, Object<string, addTxsRefsInfo>>} */
    architecture = {}; // lvl0: { lvl1: { address: addTxsRefsInfo } }
    /** @type {Object<number, Object<string, boolean>>} */
    involedAddressesOverHeights = {}; // { height: {addresses: true} } useful for pruning
    maxInvoledHeights = 10; // max number of heights to keep in memory useful when loading snapshots
    constructor() { this.#load(); }

    #load() {
        if (!fs.existsSync(this.configPath)) {
            storageMiniLogger.log(`no config file found: ${this.configPath}`, (m) => { console.error(m); });
            return;
        }

        try {
            /** @type {number} */
            const config = JSON.parse(fs.readFileSync(this.configPath));
            this.version = config.version;
            this.snapHeight = config.snapHeight || -1;
            this.architecture = config.architecture || {};
            this.involedAddressesOverHeights = config.involedAddressesOverHeights || {};

            storageMiniLogger.log('[AddressesTxsRefsStorage] => config loaded', (m) => { console.log(m); });
            this.loaded = true;
        } catch (error) { storageMiniLogger.log(error, (m) => { console.error(m); }); }
    }
    #pruneInvoledAddressesOverHeights() {
        // SORT BY DESCENDING HEIGHTS -> KEEP ONLY THE UPPER HEIGHTS
        const keys = Object.keys(this.involedAddressesOverHeights).map(Number).sort((a, b) => b - a);
        for (let i = 0; i < keys.length; i++)
            if (i > this.maxInvoledHeights) delete this.involedAddressesOverHeights[keys[i]];
    }
    save(indexEnd) {
        this.#pruneInvoledAddressesOverHeights();

        this.snapHeight = indexEnd;
        const config = {
            version: this.codeVersion,
            snapHeight: this.snapHeight,
            architecture: this.architecture,
            involedAddressesOverHeights: this.involedAddressesOverHeights
        };
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
    #clearArchitectureIfFolderMissing(lvl0, lvl1, address) {
        if (!this.architecture[lvl0][lvl1][address]) return;

        const dirPath = path.join(PATH.TXS_REFS, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)) { // Clean the architecture if the folder is missing
            delete this.architecture[lvl0][lvl1][address];
            if (Object.keys(this.architecture[lvl0][lvl1]).length === 0) delete this.architecture[lvl0][lvl1];
            if (Object.keys(this.architecture[lvl0]).length === 0) delete this.architecture[lvl0];
            return true;
        }
    }
    /** @param {string | number} batchNegativeIndex 0 for the temp batch, -1 for the last batch, -2 for the second to last batch, etc... */
    getTxsReferencesOfAddress(address = '', batchNegativeIndex = 0) {
        if (typeof address !== 'string' || address.length !== 20) return [];

        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        if (!this.architecture[lvl0][lvl1][address]) return [];
        if (this.#clearArchitectureIfFolderMissing(lvl0, lvl1, address)) return [];
        
        const dirPath = path.join(PATH.TXS_REFS, lvl0, lvl1, address);
        const existingBatch = Math.floor(this.architecture[lvl0][lvl1][address].totalTxsRefs / this.batchSize);
        const fileName = batchNegativeIndex === 0 ? 'temp.bin' : `${existingBatch + batchNegativeIndex}.bin`;
        const filePath = path.join(dirPath, fileName);
        if (!fs.existsSync(filePath)) return []; // 'temp.bin can be missing'

        const serialized = fs.readFileSync(filePath);
        /** @type {Array<string>} */
        const txsRefs = serializer.deserialize.txsReferencesArray(serialized);
        return txsRefs;
    }
    async #saveNewBatchOfTxsRefs(address = '', batch = []) {
        const serialized = serializer.serialize.txsReferencesArray(batch);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        this.architecture[lvl0][lvl1][address].totalTxsRefs += batch.length;

        const dirPath = path.join(PATH.TXS_REFS, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        // 0-100: 0, 100-200: 1, 200-300: 2, etc...
        const batchIndex = Math.floor(this.architecture[lvl0][lvl1][address].totalTxsRefs / this.batchSize);
        const filePath = path.join(dirPath, `${batchIndex -1}.bin`);
        return fs.promises.writeFile(filePath, serialized); //? not sure "return" is good here
    }
    async #saveTempTxsRefs(address = '', txsRefs = [], highestIndex = -1) {
        const serialized = serializer.serialize.txsReferencesArray(txsRefs);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        const dirPath = path.join(PATH.TXS_REFS, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)){ fs.mkdirSync(dirPath, { recursive: true }); }

        const filePath = path.join(dirPath, `temp.bin`);
        return fs.promises.writeFile(filePath, serialized); //? not sure "return" is good here
    }
    async setTxsReferencesOfAddress(address = '', txsRefs = [], indexStart = -1) {
        if (txsRefs.length === 0) return; //TODO: ERASE ADDRESS DATA ?

        // RECORD THE ADDRESS ACTIVITY FOR EASIER PRUNING
        if (this.involedAddressesOverHeights[indexStart] === undefined)
            this.involedAddressesOverHeights[indexStart] = {};
        this.involedAddressesOverHeights[indexStart][address] = true;

        // UPDATE ARCHITECTURE INFO
        const highestIndex = Number(txsRefs[txsRefs.length - 1].split(':')[0]);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        if (!this.architecture[lvl0][lvl1][address])
            this.architecture[lvl0][lvl1][address] = { highestIndex, totalTxsRefs: 0 };

        // SAVE BATCH IF TOO BIG
        let promises = [];
        while (txsRefs.length > this.batchSize)
            promises.push(this.#saveNewBatchOfTxsRefs(address, txsRefs.splice(0, this.batchSize)));
        promises.push(this.#saveTempTxsRefs(address, txsRefs, highestIndex)); // SAVE TEMP TXS REFS

        if (promises.length > 0) await Promise.allSettled(promises);
        this.architecture[lvl0][lvl1][address].highestIndex = highestIndex;
    }

    #pruneBatchRefsUpperThan(batch = [], height = 0) {
        return batch.filter(txsRef => Number(txsRef.split(':')[0]) <= height);
    }
    #pruneAddressRefsUpperThan(address = '', height = 0) {
        if (typeof address !== 'string' || address.length !== 20) return false;
        
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        if (!this.architecture[lvl0][lvl1][address]) return false;
        if (this.#clearArchitectureIfFolderMissing(lvl0, lvl1, address)) return false;

        const dirPath = path.join(PATH.TXS_REFS, lvl0, lvl1, address);
        const numberOfFiles = fs.readdirSync(dirPath).length;
        if (numberOfFiles === 0) return false; // no files to prune, should not happen because empty folders are deleted

        const existingBatch = Math.floor(numberOfFiles / this.batchSize);
        let batchNegativeIndex = numberOfFiles -1;
        
        while (true) {
            const fileName = batchNegativeIndex === 0 ? 'temp.bin' : `${existingBatch + batchNegativeIndex}.bin`;
            const filePath = path.join(dirPath, fileName);
            const exists = fs.existsSync(filePath);
            if (exists) {
                const serialized = fs.readFileSync(filePath);
                const txsRefs = serializer.deserialize.txsReferencesArray(serialized);
                const remainingBatchTxsRefs = this.#pruneBatchRefsUpperThan(txsRefs, height);
                const removedTxs = txsRefs.length - remainingBatchTxsRefs.length;

                if (batchNegativeIndex !== 0 && removedTxs === 0) break; // no more files to check
                if (removedTxs !== 0) this.architecture[lvl0][lvl1][address].totalTxsRefs -= removedTxs;
                
                if (remainingBatchTxsRefs.length === 0) fs.rmSync(filePath); // delete the file if empty
                else fs.writeFileSync(filePath, serializer.serialize.txsReferencesArray(remainingBatchTxsRefs));
            } else if (batchNegativeIndex !== 0) break; // no more files to check

            batchNegativeIndex--;
        }

        // if the address is empty, we can delete it from the architecture
        const totalTxsRefs = this.architecture[lvl0][lvl1][address].totalTxsRefs;
        if (!totalTxsRefs || totalTxsRefs <= 0) {
            fs.rmSync(dirPath, { recursive: true }); // delete the folder
            delete this.architecture[lvl0][lvl1][address];
            if (Object.keys(this.architecture[lvl0][lvl1]).length === 0) delete this.architecture[lvl0][lvl1];
            if (Object.keys(this.architecture[lvl0]).length === 0) delete this.architecture[lvl0];
        }
    }
    /** Pruning to use while loading a snapshot */
    pruneAllUpperThan(height = 0) {
        const keys = Object.keys(this.involedAddressesOverHeights).map(Number).filter(h => h > height);
        for (let i = 0; i < keys.length; i++) {
            for (const address in this.involedAddressesOverHeights[keys[i]])
                this.#pruneAddressRefsUpperThan(address, keys[i]);

            delete this.involedAddressesOverHeights[keys[i]];
        }

        this.snapHeight = Math.min(this.snapHeight, height);
        storageMiniLogger.log(`Pruned all transactions references upper than ${height}`, (m) => { console.log(m); });
    }
    reset(reason = 'na') {
        if (fs.existsSync(PATH.TXS_REFS)) fs.rmSync(PATH.TXS_REFS, { recursive: true });
        if (fs.existsSync(this.configPath)) fs.rmSync(this.configPath);
        
        fs.mkdirSync(PATH.TXS_REFS);
        this.snapHeight = -1;
        this.architecture = {};
        this.involedAddressesOverHeights = {};
        storageMiniLogger.log(`AddressesTxsRefsStorage reset: ${reason}`, (m) => { console.log(m); });
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
        } catch (error) { storageMiniLogger.log(error.stack, (m) => { console.error(m); }); }
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
        if (!deserialize) return serialized;

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
        if (blockData.prevHash !== prevHash) throw new Error(`Block #${blockData.index} rejected: prevHash mismatch`);

        const existingBlockHash = this.hashByIndex[blockData.index];
        //if (existingBlockHash) { throw new Error(`Block #${blockData.index} already exists with hash ${existingBlockHash}`); }
        if (existingBlockHash) { this.removeBlock(blockData.index); }

        this.#saveBlockBinary(blockData);
        this.hashByIndex[blockData.index] = blockData.hash;
        this.indexByHash[blockData.hash] = blockData.index;

        if (isProductionEnv) return; // Avoid saving heavy JSON format in production
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
        if (typeof heightOrHash !== 'number' && typeof heightOrHash !== 'string') return null;

        const { blockHash, blockIndex } = this.#blockHashIndexFormHeightOrHash(heightOrHash);
        if (blockIndex === -1 || blockHash === undefined || blockIndex === undefined) return null;

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
            if (!deserialize) return new Uint8Array(buffer);

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
            if (!pointersBuffer.slice(i, i + 4).every((v, i) => v === targetUint8Array[i])) continue;

            const index = i / 8;
            const offsetStart = this.fastConverter.uint84BytesToNumber(pointersBuffer.slice(i + 4, i + 8));
            i += 8;
            if (i >= pointersBuffer.length) return { index, start: offsetStart, end: serializedBlock.length };
            
            const offsetEnd = this.fastConverter.uint84BytesToNumber(pointersBuffer.slice(i, i + 4));
            return { index, start: offsetStart, end: offsetEnd };
        }

        return null;
    }
    #extractSerializedBlockTimestamp(serializedBlock) {
        return this.fastConverter.uint86BytesToNumber(serializedBlock.slice(62, 68));
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
    retreiveTx(txRef = '41:5fbcae93', includeTimestamp) {
        const blockIndex = parseInt(txRef.split(':')[0], 10);
        const serializedBlock = this.retreiveBlock(blockIndex, false);
        if (!serializedBlock) return null;

        const timestamp = includeTimestamp ? this.#extractSerializedBlockTimestamp(serializedBlock) : undefined;
        const txOffset = this.#findTxPointerInSerializedBlock(serializedBlock, txRef);
        if (!txOffset) return null;

        const { index, start, end } = txOffset;
        const tx = this.#readTxInSerializedBlockUsingPointer(serializedBlock, index, start, end);

        return { tx, timestamp };
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
        for (let i = 0; i < this.txCount; i++) block.push(this.#createRandomTx());
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
        for (let i = 0; i < block.length; i++) Storage.saveBinary(`${index}-${i}`, block[i], blockDir);
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