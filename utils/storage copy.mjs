// A primitive way to store the blockchain data and wallet data etc...
// As usual, use Ctrl + k, Ctrl + 0 to fold all blocks of code
import HiveP2P from "hive-p2p";
import { Breather } from './breather.mjs';
import { serializer } from './serializer.mjs';
import { BlockUtils } from "../node/src/block.mjs";
import { HashFunctions } from '../node/src/conCrypto.mjs';
import { MiniLogger } from '../miniLogger/mini-logger.mjs';
import { BLOCKCHAIN_SETTINGS } from './blockchain-settings.mjs';

/**
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized
 */

// -> Imports compatibility for Node.js, Electron and browser
const isNode = typeof window === 'undefined';
/** @type {typeof import('fs')} */
const fs = isNode ? await import('fs') : window.fs;
/** @type {typeof import('path')} */
const path = isNode ? await import('path') : window.path;
const url = isNode ? await import('url') : window.url;
const crypto = isNode ? await import('crypto') : window.crypto;
/** @type {typeof import('adm-zip')} */
const AdmZip = isNode ? await import('adm-zip').then(module => module.default) : window.AdmZip;

/**
* @typedef {import("hive-p2p").Converter} Converter
* @typedef {import("../node/src/node.mjs").Node} Node
* @typedef {import("../node/src/block.mjs").BlockInfo} BlockInfo
* @typedef {import("../types/transaction.mjs").Transaction} Transaction
*/

// GLOBALS VARS
/** @type {MiniLogger} */
const storageMiniLogger = new MiniLogger('storage');
const BLOCK_PER_DIRECTORY = 1000;

/** THE COMMON CLASS TO HANDLE THE STORAGE PATHS */
class StorageRoot {
	/** The local identifier used as subFolder */	localIdentifier;
	/** Is running in electron environment */		  isElectronEnv;
	/** Path to this file @type {string} */				   filePath;
	/** Root folder path @type {string} */				 rootFolder;
	/** Paths used for storage */							   PATH;

	/** @param {string|null} masterHex - master hex string to generate local identifier */
	constructor(masterHex = null) {
		this.localIdentifier = masterHex ? this.#getLocalIdentifier(masterHex) : null;
		const filePath = url.fileURLToPath(import.meta.url).replace('app.asar', 'app.asar.unpacked');
		this.isElectronEnv = filePath.includes('app.asar');

		this.rootFolder = !this.isElectronEnv ? path.dirname(path.dirname(filePath))
			: path.dirname(path.dirname(path.dirname(path.dirname(filePath))))
	
		const basePath = !this.localIdentifier ? path.join(path.dirname(this.rootFolder), 'contrast-storage')
			: path.join(path.dirname(this.rootFolder), 'contrast-storage', this.localIdentifier);
	
		this.PATH = {
			/** path to the storage.mjs file */
			BASE_FILE: filePath,
			/** path to the storage folder (out of the root directory) */
			STORAGE: basePath,
			TRASH: path.join(basePath, 'trash'),
			TXS_IDS: path.join(basePath, 'addresses-txs-ids'),
			BLOCKS: path.join(basePath, 'blocks'),
			JSON_BLOCKS: path.join(basePath, 'json-blocks'),
			BLOCKS_INFO: path.join(basePath, 'blocks-info'),
			SNAPSHOTS: path.join(basePath, 'snapshots'),
			CHECKPOINTS: path.join(basePath, 'checkpoints'),
			TEST_STORAGE: path.join(basePath, 'test')
		};
		this.#init();
	}
	#init() {
		// create the contrast-storage folder if it doesn't exist, and any of subfolder
		if (this.isElectronEnv) { delete this.PATH.TEST_STORAGE; delete this.PATH.JSON_BLOCKS; }
		if (!fs.existsSync(path.join(path.dirname(this.rootFolder), 'contrast-storage')))
			fs.mkdirSync(path.join(path.dirname(this.rootFolder), 'contrast-storage'));
		for (const dirPath of Object.values(this.PATH))
			if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
	}
	#getLocalIdentifier(masterHex = 'ff') {
		const separatorParts = 'local-identifier-separator'.split('');
		const keyParts = masterHex.split('');
		const input = [];
		for (let i = 0; i < keyParts.length; i++) {
			input.push(keyParts[i]);
			input.push(separatorParts[i % separatorParts.length]);
		}
		return HashFunctions.xxHash32(input.join(''));
	}
	clear(passHash = true, nodeSettings = true) {
		const dirPaths = [
			this.PATH.BLOCKS,
			this.PATH.BLOCKS_INFO,
			this.PATH.JSON_BLOCKS,
			this.PATH.TRASH,
			this.PATH.SNAPSHOTS,
			this.PATH.TXS_IDS,
			this.PATH.CHECKPOINTS,
			path.join(this.PATH.STORAGE, 'ACTIVE_CHECKPOINT'),
			this.PATH.TEST_STORAGE
		];
		const filePaths = [ path.join(this.PATH.STORAGE, 'AddressesTxsIdsStorage_config.json') ];
		if (passHash) filePaths.push(path.join(this.PATH.STORAGE, 'passHash.bin'));
		if (nodeSettings) filePaths.push(path.join(this.PATH.STORAGE, 'nodeSetting.bin'));

		for (const dirPath of dirPaths)
			if (!fs.existsSync(dirPath)) continue;
			else { fs.rmSync(dirPath, { recursive: true }); console.log(`${dirPath} removed.`) }

		for (const filePath of filePaths)
			if (!fs.existsSync(filePath)) continue;
			else { fs.unlinkSync(filePath); console.log(`${filePath} removed.`) }

		this.#init();
	}
}

/** The main Storage */
export class ContrastStorage extends StorageRoot {
	constructor(masterHex = null) { super(masterHex); }

	/** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
	saveBinary(fileName, serializedData, directoryPath) {
		try {
			const d = directoryPath || this.PATH.STORAGE;
			if (!fs.existsSync(d)) fs.mkdirSync(d);
			
			fs.writeFileSync(path.join(d, `${fileName}.bin`), serializedData);
		} catch (error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
		return true;
	}
	/** @param {string} fileName @param {string} directoryPath @returns {Uint8Array|boolean} */
	loadBinary(fileName, directoryPath) {
		const filePath = path.join(directoryPath || this.PATH.STORAGE, `${fileName}.bin`);
		try { return fs.readFileSync(filePath) } // work as Uint8Array
		catch (error) {
			if (error.code === 'ENOENT') storageMiniLogger.log(`File not found: ${filePath}`, (m, c) => console.info(m, c));
			else storageMiniLogger.log(error.stack, (m, c) => console.info(m, c));
		}
		return false;
	}
	/** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
	async saveBinaryAsync(fileName, serializedData, directoryPath) {
		try {
			const d = directoryPath || this.PATH.STORAGE;
			if (!fs.existsSync(d)) fs.mkdirSync(d);
			await fs.promises.writeFile(path.join(d, `${fileName}.bin`), serializedData);
		} catch (error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
	}
	/** @param {string} fileName @param {string} directoryPath @returns {Promise<Uint8Array|boolean>} */
	async loadBinaryAsync(fileName, directoryPath) {
		const filePath = path.join(directoryPath || this.PATH.STORAGE, `${fileName}.bin`);
		try {
			const buffer = await fs.promises.readFile(filePath);
			return buffer;
		} catch (error) {
			if (error.code === 'ENOENT') storageMiniLogger.log(`File not found: ${filePath}`, (m, c) => console.info(m, c));
			else storageMiniLogger.log(error.stack, (m, c) => console.info(m, c));
		}
		return false;
	}
	isFileExist(fileNameWithExtension = 'toto.bin', directoryPath) {
		const filePath = path.join(directoryPath || this.PATH.STORAGE, fileNameWithExtension);
		return fs.existsSync(filePath);
	}
	/** @param {string} fileName - The name of the file @param {any} data - The data to save */
	saveJSON(fileName, data) {
		try {
			const filePath = path.join(this.PATH.STORAGE, `${fileName}.json`);
			if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath));
			fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
		} catch (error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false }
	}
	/** @param {string} fileName - The name of the file @returns {any|boolean} */
	loadJSON(fileName) {
		try { return JSON.parse(fs.readFileSync(path.join(this.PATH.STORAGE, `${fileName}.json`))) }
		catch (error) { return false }
	}
	/** @param {string} fileNameWithExtension - ex: 'toto.bin' @param {string} [directoryPath] - default is this.PATH.STORAGE */
	deleteFile(fileNameWithExtension = 'toto.bin', directoryPath = this.PATH.STORAGE) {
		const filePath = path.join(directoryPath, fileNameWithExtension);
		if (fs.existsSync(filePath)) fs.rmSync(filePath);
	}
	dumpTrashFolder() {
		if (fs.existsSync(this.PATH.TRASH)) fs.rmSync(this.PATH.TRASH, { recursive: true });
		fs.mkdirSync(this.PATH.TRASH);
	}
}

// IGNORE THESES CLASSES, WE ARE REFACTORING FROM STATIC LOGICS TO INSTANCED LOGICS
// ALL OF THE FOLLOWING CLASSES WILL BE MODIFIED LATER OVER THE REFACTORING PROCESS
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
     * @param {number[]} neededSnapHeights
	 * @param {ContrastStorage} storage */
    static async archiveCheckpoint(checkpointHeight = 0, fromPath, snapshotsHeights, neededSnapHeights, storage) {
        try {
            const zip = new AdmZip();
            const breather = new Breather();
            const fromSnapshotsPath = fromPath ? path.join(fromPath, 'snapshots') : storage.PATH.SNAPSHOTS;
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
            const heightPath = path.join(storage.PATH.CHECKPOINTS, checkpointHeight.toString());
            if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }
            fs.writeFileSync(path.join(heightPath, `${hash}.zip`), buffer);
            return hash;
        } catch (error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
    }
    /** @param {Buffer} buffer @param {string} hashToVerify @param {ContrastStorage} storage */
    static unarchiveCheckpointBuffer(checkpointBuffer, hashToVerify, storage) {
        try {
            const buffer = Buffer.from(checkpointBuffer);
            const hash_V1 = crypto.createHash('sha256').update(buffer).digest('hex');
            const isValidHash_V1 = hash_V1 === hashToVerify;
            if (!isValidHash_V1) storageMiniLogger.log('<> Hash V1 mismatch! <>', (m, c) => console.info(m, c));
            //if (hash !== hashToVerify) { storageMiniLogger.log('<> Hash mismatch! <>', (m, c) => console.info(m, c)); return false; }
    
            const destPath = path.join(storage.PATH.STORAGE, 'ACTIVE_CHECKPOINT');
            if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true });
            fs.mkdirSync(destPath, { recursive: true });

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
                if (hash_V2 !== hashToVerify) { storageMiniLogger.log('<> Hash mismatch! <>', (m, c) => console.info(m, c)); return false; }
                isValidHash_V2 = hash_V2 === hashToVerify;
            } catch (error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); }

            if (!isValidHash_V2) storageMiniLogger.log('<> Hash V2 mismatch! <>', (m, c) => console.info(m, c));
            if (!isValidHash_V1 && !isValidHash_V2) storageMiniLogger.log('--- Checkpoint is corrupted! ---', (m, c) => console.info(m, c));
            return true;
        } catch (error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false }
    }
	/** @param {string} checkpointsPath */
    static reset(checkpointsPath) {
        if (fs.existsSync(checkpointsPath)) fs.rmSync(checkpointsPath, { recursive: true });
    }
}

/** Transactions references are stored in binary format, folder architecture is optimized for fast access
 * @typedef {Object} addTxsRefsInfo
 * @property {number} highestIndex - The highest index of the transactions referenced (including temp refs)
 * @property {number} totalTxsRefs - The total number of transactions referenced (excluding temp refs) */
export class AddressesTxsRefsStorage {
    codeVersion = 4;
    version = 0;
    loaded = false;
    configPath;
	txsIdsPath;
    batchSize = 1000; // number of transactions references per file
    snapHeight = -1;
	
    /** @type {Object<string, Object<string, Object<string, addTxsRefsInfo>>} */
    architecture = {}; // lvl0: { lvl1: { address: addTxsRefsInfo } }
    /** @type {Object<number, Object<string, boolean>>} */
    involedAddressesOverHeights = {}; // { height: {addresses: true} } useful for pruning
    maxInvoledHeights = 10; // max number of heights to keep in memory useful when loading snapshots
    
	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) {
		this.configPath = path.join(storage.PATH.STORAGE, 'AddressesTxsIdsStorage_config.json');
		this.txsIdsPath = storage.PATH.TXS_IDS;
		this.#load();
	}

    #load() {
        if (!fs.existsSync(this.configPath)) {
            storageMiniLogger.log(`no config file found: ${this.configPath}`, (m, c) => console.error(m, c));
            return;
        }

        try {
            /** @type {number} */
            const config = JSON.parse(fs.readFileSync(this.configPath));
            this.version = config.version;
            this.snapHeight = config.snapHeight || -1;
            this.architecture = config.architecture || {};
            this.involedAddressesOverHeights = config.involedAddressesOverHeights || {};

            storageMiniLogger.log('[AddressesTxsRefsStorage] => config loaded', (m, c) => console.log(m, c));
            this.loaded = true;
        } catch (error) { storageMiniLogger.log(error, (m, c) => console.error(m, c)); }
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
            if (!fs.existsSync(path.join(this.txsIdsPath, lvl0))) fs.mkdirSync(path.join(this.txsIdsPath, lvl0));
        }

        const lvl1 = address.slice(2, 3);
        if (this.architecture[lvl0][lvl1] === undefined) {
            this.architecture[lvl0][lvl1] = {};
            if (!fs.existsSync(path.join(this.txsIdsPath, lvl0, lvl1))) fs.mkdirSync(path.join(this.txsIdsPath, lvl0, lvl1));
        }

        return { lvl0, lvl1 };
    }
    #clearArchitectureIfFolderMissing(lvl0, lvl1, address) {
        if (!this.architecture[lvl0][lvl1][address]) return;

        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
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
        
        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
        const existingBatch = Math.floor(this.architecture[lvl0][lvl1][address].totalTxsIds / this.batchSize);
        const fileName = batchNegativeIndex === 0 ? 'temp.bin' : `${existingBatch + batchNegativeIndex}.bin`;
        const filePath = path.join(dirPath, fileName);
        if (!fs.existsSync(filePath)) return []; // 'temp.bin can be missing'

        const serialized = fs.readFileSync(filePath);
        /** @type {Array<string>} */
        const txsIds = serializer.deserialize.txsIdsArray(serialized);
        return txsIds;
    }
    async #saveNewBatchOfTxsIds(address = '', batch = []) {
        const serialized = serializer.serialize.txsIdsArray(batch);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        this.architecture[lvl0][lvl1][address].totalTxsIds += batch.length;

        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        // 0-100: 0, 100-200: 1, 200-300: 2, etc...
        const batchIndex = Math.floor(this.architecture[lvl0][lvl1][address].totalTxsIds / this.batchSize);
        const filePath = path.join(dirPath, `${batchIndex -1}.bin`);
        return fs.promises.writeFile(filePath, serialized); //? not sure "return" is good here
    }
    async #saveTempTxsIds(address = '', txsIds = [], highestIndex = -1) {
        const serialized = serializer.serialize.txsIdsArray(txsIds);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        const filePath = path.join(dirPath, `temp.bin`);
        return fs.promises.writeFile(filePath, serialized); //? not sure "return" is good here
    }
	/** @param {string} address - The address to set txs references for @param {TxId[]} txsIds - The array of tx ids to set @param {number} indexStart - The starting index of the tx ids */
    async setTxsReferencesOfAddress(address = '', txsIds = [], indexStart = -1) {
        if (txsIds.length === 0) return; //TODO: ERASE ADDRESS DATA ?

        // RECORD THE ADDRESS ACTIVITY FOR EASIER PRUNING
        if (this.involedAddressesOverHeights[indexStart] === undefined)
            this.involedAddressesOverHeights[indexStart] = {};
        this.involedAddressesOverHeights[indexStart][address] = true;

        // UPDATE ARCHITECTURE INFO
        const highestIndex = Number(txsIds[txsIds.length - 1].split(':')[0]);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        if (!this.architecture[lvl0][lvl1][address])
            this.architecture[lvl0][lvl1][address] = { highestIndex, totalTxsIds: 0 };

        // SAVE BATCH IF TOO BIG
        let promises = [];
        while (txsIds.length > this.batchSize)
            promises.push(this.#saveNewBatchOfTxsIds(address, txsIds.splice(0, this.batchSize)));
        promises.push(this.#saveTempTxsIds(address, txsIds, highestIndex)); // SAVE TEMP TXS IDS

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

        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
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
                const txsIds = serializer.deserialize.txsIdsArray(serialized);
                const remainingBatchTxsIds = this.#pruneBatchRefsUpperThan(txsIds, height);
                const removedTxs = txsIds.length - remainingBatchTxsIds.length;

                if (batchNegativeIndex !== 0 && removedTxs === 0) break; // no more files to check
                if (removedTxs !== 0) this.architecture[lvl0][lvl1][address].totalTxsIds -= removedTxs;
                
                if (remainingBatchTxsIds.length === 0) fs.rmSync(filePath); // delete the file if empty
                else fs.writeFileSync(filePath, serializer.serialize.txsIdsArray(remainingBatchTxsIds));
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
        storageMiniLogger.log(`Pruned all transactions references upper than #${height}`, (m, c) => console.info(m, c));
    }
    reset(reason = 'na') {
        if (fs.existsSync(this.txsIdsPath)) fs.rmSync(this.txsIdsPath, { recursive: true });
        if (fs.existsSync(this.configPath)) fs.rmSync(this.configPath);
        
        fs.mkdirSync(this.txsIdsPath);
        this.snapHeight = -1;
        this.architecture = {};
        this.involedAddressesOverHeights = {};
        storageMiniLogger.log(`AddressesTxsRefsStorage reset: ${reason}`, (m, c) => console.info(m, c));
    }
}

export class BlockchainStorage {
	converter = new HiveP2P.Converter();
	storage;
	hashes = []; 				// array of block hashes by height index
	indexOfHash = new Map(); 	// map of block index by hash
	batchSize = BLOCKCHAIN_SETTINGS.halvingInterval; // number of blocks per binary file
	fd = {						// file descriptors opened for reading binaries
		indexes: [],
		blocks: []
	}
	
	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) {
		this.storage = storage;
		this.#init();
	}
	
	get getLastBlockIndex() { return this.hashes.length - 1; }
	getHashByIndex(blockIndex = -1) { // ??
		if (blockIndex === -1) return "0000000000000000000000000000000000000000000000000000000000000000";
		return this.hashes[blockIndex] || null;
	}
}

export class BlockchainStorageOld { // DEPRECATED => REFACTORING IN PROGRESS
	converter = new HiveP2P.Converter();
	storage;
	batchFolders;
    lastBlockIndex = -1;
    /** @type {Object<string, string>} */
    hashByIndex = {"-1": "0000000000000000000000000000000000000000000000000000000000000000"};
    /** @type {Object<string, number>} */
    indexByHash = {"0000000000000000000000000000000000000000000000000000000000000000": 0};

	/** @param {import('./storage.mjs').ContrastStorage} storage */
    constructor(storage) {
		this.storage = storage;
		this.batchFolders = BlockchainStorage.getListOfFoldersInBlocksDirectory(this.storage.PATH.BLOCKS);
		this.#init();
	}
	/** @param {string} blocksPath */
    static getListOfFoldersInBlocksDirectory(blocksPath) {
        const blocksFolders = fs.readdirSync(blocksPath).filter(fileName => fs.lstatSync(path.join(blocksPath, fileName)).isDirectory());
        // named as 0-999, 1000-1999, 2000-2999, etc... => sorting by the first number
        const blocksFoldersSorted = blocksFolders.sort((a, b) => parseInt(a.split('-')[0], 10) - parseInt(b.split('-')[0], 10));
        return blocksFoldersSorted;
    }
    #init() {
		if (!this.converter && window?.hiveP2P?.Converter) // front logic
			this.converter = new window.hiveP2P.Converter();

        let currentIndex = -1;
        for (let i = 0; i < this.batchFolders.length; i++) {
            const batchFolderName = this.batchFolders[i];
            const files = fs.readdirSync(path.join(this.storage.PATH.BLOCKS, batchFolderName));
            for (let j = 0; j < files.length; j++) {
                const fileName = files[j].split('.')[0];
                const blockIndex = parseInt(fileName.split('-')[0], 10);
                const blockHash = fileName.split('-')[1];
                if (currentIndex >= blockIndex) {
                    storageMiniLogger.log(`---! Duplicate block index !--- #${blockIndex}`, (m, c) => console.info(m, c));
                    throw new Error(`Duplicate block index #${blockIndex}`);
                }

                this.hashByIndex[blockIndex] = blockHash;
                this.indexByHash[blockHash] = blockIndex;
                this.lastBlockIndex = Math.max(this.lastBlockIndex, blockIndex);
            }
        }

        storageMiniLogger.log(`BlockchainStorage initialized with ${this.lastBlockIndex + 1} blocks`, (m, c) => console.info(m, c));
    }
    static batchFolderFromBlockIndex(blockIndex = 0) {
        const index = Math.floor(blockIndex / BLOCK_PER_DIRECTORY);
        const name = `${Math.floor(blockIndex / BLOCK_PER_DIRECTORY) * BLOCK_PER_DIRECTORY}-${Math.floor(blockIndex / BLOCK_PER_DIRECTORY) * BLOCK_PER_DIRECTORY + BLOCK_PER_DIRECTORY - 1}`;
        return { index, name };
    }
    #blockFilePathFromIndexAndHash(blockIndex = 0, blockHash = '') {
        const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(blockIndex).name;
        const batchFolderPath = path.join(this.storage.PATH.BLOCKS, batchFolderName);
        const blockFilePath = path.join(batchFolderPath, `${blockIndex.toString()}-${blockHash}.bin`);
        return blockFilePath;
    }
    /** @param {BlockFinalized} blockData */
    #saveBlockBinary(blockData) {
        try {
            /** @type {Uint8Array} */
            const binary = serializer.serialize.block(blockData);
            const batchFolder = BlockchainStorage.batchFolderFromBlockIndex(blockData.index);
            const batchFolderPath = path.join(this.storage.PATH.BLOCKS, batchFolder.name);
            if (this.batchFolders[batchFolder.index] !== batchFolder.name) {
                fs.mkdirSync(batchFolderPath);
                this.batchFolders.push(batchFolder.name);
            }

            const filePath = path.join(batchFolderPath, `${blockData.index.toString()}-${blockData.hash}.bin`);
            fs.writeFileSync(filePath, binary);
        } catch (error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); }
    }
    /** @param {BlockFinalized} blockData @param {string} dirPath */
    #saveBlockDataJSON(blockData, dirPath) {
        const blockFilePath = path.join(dirPath, `${blockData.index}.json`);
        fs.writeFileSync(blockFilePath, JSON.stringify(blockData, (key, value) => { return value; }));
    }
    #loadBlockDataJSON(blockIndex = 0, dirPath = '') {
        const blockFileName = `${blockIndex.toString()}.json`;
        const filePath = path.join(dirPath, blockFileName);
        const blockContent = fs.readFileSync(filePath);
        const blockData = BlockUtils.finalizedBlockFromJSON(blockContent);
        return blockData;
    }

    /** @param {BlockFinalized} blockData @param {boolean} saveJSON */
    addBlock(blockData, saveJSON = false) {
        const prevHash = this.hashByIndex[blockData.index - 1];
        if (blockData.prevHash !== prevHash) throw new Error(`Block #${blockData.index} rejected: prevHash mismatch`);

        const existingBlockHash = this.hashByIndex[blockData.index];
        //if (existingBlockHash) { throw new Error(`Block #${blockData.index} already exists with hash ${existingBlockHash}`); }
        if (existingBlockHash) this.removeBlock(blockData.index);

        this.#saveBlockBinary(blockData);
        this.hashByIndex[blockData.index] = blockData.hash;
        this.indexByHash[blockData.hash] = blockData.index;

        if (this.isElectronEnv) return; // Avoid saving heavy JSON format in production
        if (saveJSON || blockData.index < 200) this.#saveBlockDataJSON(blockData, this.storage.PATH.JSON_BLOCKS);
    }
    /** @param {BlockInfo} blockInfo */
    addBlockInfo(blockInfo) {
        const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(blockInfo.header.index).name;
        const batchFolderPath = path.join(this.storage.PATH.BLOCKS_INFO, batchFolderName);
        if (!fs.existsSync(batchFolderPath)) { fs.mkdirSync(batchFolderPath); }

        const binary = serializer.serialize.rawData(blockInfo);
        const filePath = path.join(batchFolderPath, `${blockInfo.header.index.toString()}-${blockInfo.header.hash}.bin`);
        fs.writeFileSync(filePath, binary);
    }
    /** @param {number | string} heightOrHash - The height or the hash of the block to retrieve */
    retreiveBlockBytes(heightOrHash) {
        if (typeof heightOrHash !== 'number' && typeof heightOrHash !== 'string') return null;

		const isParamHash = typeof heightOrHash === 'string';
		const blockHash = isParamHash ? heightOrHash : this.hashByIndex[parseInt(heightOrHash, 10)];
		const blockIndex = isParamHash ? this.indexByHash[heightOrHash] : heightOrHash;
		if (blockIndex === undefined || blockHash === undefined) return null;

        /** @type {Uint8Array} */
        const serialized = fs.readFileSync(this.#blockFilePathFromIndexAndHash(blockIndex, blockHash));
		return serialized;
    }
    getBlockInfoBytesByIndex(blockIndex = 0) {
        const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(blockIndex).name;
        const batchFolderPath = path.join(this.storage.PATH.BLOCKS_INFO, batchFolderName);
        const blockHash = this.hashByIndex[blockIndex];
		const blockInfoFilePath = path.join(batchFolderPath, `${blockIndex.toString()}-${blockHash}.bin`);

        try {
            const buffer = fs.readFileSync(blockInfoFilePath);
            return new Uint8Array(buffer);
        } catch (error) {
            storageMiniLogger.log(`BlockInfo not found ${blockIndex.toString()}-${blockHash}.bin`, (m, c) => console.info(m, c));
            storageMiniLogger.log(error.stack, (m, c) => console.info(m, c));
            return null;
        }
    }
	getBlockInfoByIndex(blockIndex = 0) {
		const blockInfoBytes = this.getBlockInfoBytesByIndex(blockIndex);
		if (!blockInfoBytes) return null;

		/** @type {BlockInfo} */
		const blockInfo = serializer.deserialize.rawData(blockInfoBytes);
		return blockInfo;
	}
    /** @param {Uint8Array} serializedBlock @param {number} txIndex - The reference of the transaction to retrieve */
    #findTxPointerInSerializedBlock(serializedBlock, txIndex) {
		const nbOfTxs = this.converter.bytes2ToNumber(serializedBlock.slice(0, 2));
		if (txIndex >= nbOfTxs) return null;

        const pointerStart = serializer.lengths.blockFinalizedHeader + (txIndex * 4);
		const pointerBuffer = serializedBlock.slice(pointerStart, pointerStart + 4);
		const offsetStart = this.converter.bytes4ToNumber(pointerBuffer);

		const nextPointerStart = pointerStart + 4;
		const offsetEnd = txIndex + 1 < nbOfTxs
			? this.converter.bytes4ToNumber(serializedBlock.slice(nextPointerStart, nextPointerStart + 4))
			: serializedBlock.length;

		return { index: 0, start: offsetStart, end: offsetEnd };
    }
    #extractSerializedBlockTimestamp(serializedBlock) { // TO UPDATE !
       return this.converter.bytes6ToNumber(serializedBlock.slice(62, 68));
    }
    /** @param {Uint8Array} serializedBlock @param {number} index @param {number} start @param {number} end */
    #readTxInSerializedBlockUsingPointer(serializedBlock, index = 0, start = 0, end = 1) {
        const txBuffer = serializedBlock.slice(start, end);
		const specialMode = { 0: 'miner', 1: 'validator' }; // finalized block only
		return serializer.deserialize.transaction(txBuffer, specialMode[index]);
    }
	/** @param {import('../types/transaction.mjs').TxReference} txRef */
    retreiveTx(txRef = '41:50', includeTimestamp = false) {
		const s = txRef.split(':');
        const blockIndex = parseInt(s[0], 10);
		const txIndex = parseInt(s[1], 10);
        const serializedBlock = this.retreiveBlockBytes(blockIndex);
        if (!serializedBlock) return null;

        const timestamp = includeTimestamp ? this.#extractSerializedBlockTimestamp(serializedBlock) : undefined;
        const txOffset = this.#findTxPointerInSerializedBlock(serializedBlock, txIndex);
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
        if (fs.existsSync(this.storage.PATH.BLOCKS)) fs.rmSync(this.storage.PATH.BLOCKS, { recursive: true });
        fs.mkdirSync(this.storage.PATH.BLOCKS);
        this.batchFolders = [];
        this.hashByIndex = { "-1": "0000000000000000000000000000000000000000000000000000000000000000" };
        this.indexByHash = { "0000000000000000000000000000000000000000000000000000000000000000": -1 };
        this.lastBlockIndex = -1;
    }
}

// used to settle the difference between loading a big file and loading multiple small files
// also compare reading methods: sync, async, partial read, etc...
class TestStorage extends ContrastStorage {
    txBinaryWeight = 200; // in bytes
    txCount = 1100; // tx in a simulated block

	constructor(masterHex = '') {
		super(masterHex);
	}

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
    saveBlockDecomposed(block, index) {
        const blockDir = path.join(this.PATH.TEST_STORAGE, index.toString());
        for (let i = 0; i < block.length; i++) this.saveBinary(`${index}-${i}`, block[i], blockDir);
    }
    async createAndSaveBlocks(num = 100, { unified = true, decomposed = true } = {}) {
        for (let i = 0; i < num; i++) {
            const block = this.#createRandomBlock();
            if (unified) await this.saveBlock(block, i);
            if (decomposed) this.saveBlockDecomposed(block, i);
        }
    }

    loadBlock(index, count = this.txCount) {
		const block = [];
		const buffer = this.loadBinary(index.toString(), this.PATH.TEST_STORAGE);
		for (let i = 0; i < count; i++) {
			const start = i * this.txBinaryWeight;
			const end = start + this.txBinaryWeight;
			block.push(buffer.slice(start, end));
		}
		return block;
    }
	async loadBlockAsync(index) {
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
}
async function test() {
	const testStorage = new TestStorage('00000000000000000000000000000000000000000000000000000000000000ff');
    testStorage.txBinaryWeight *= 1;
	testStorage.txCount = 1100; //100 * 1024;
	testStorage.reset();
	const nbOfTxsToRead = 100;
	const writeStart = performance.now();
    await testStorage.createAndSaveBlocks(2, { unified: true, decomposed: false });
	console.log(`Time to write test block: ${(performance.now() - writeStart).toFixed(5)}ms`);
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