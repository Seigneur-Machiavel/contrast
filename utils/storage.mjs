// A primitive way to store the blockchain data and wallet data etc...
// As usual, use Ctrl + k, Ctrl + 0 to fold all blocks of code
import HiveP2P from "hive-p2p";
import { Breather } from './breather.mjs';
import { serializer } from './serializer.mjs';
import { BlockUtils } from "../node/src/block.mjs";
import { HashFunctions } from '../node/src/conCrypto.mjs';
import { MiniLogger } from '../miniLogger/mini-logger.mjs';

/**
 * @typedef {import("../types/block.mjs").BlockData} BlockData
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
			TXS_REFS: path.join(basePath, 'addresses-txs-refs'),
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
			this.PATH.TXS_REFS,
			this.PATH.CHECKPOINTS,
			path.join(this.PATH.STORAGE, 'ACTIVE_CHECKPOINT'),
			this.PATH.TEST_STORAGE
		];
		const filePaths = [ path.join(this.PATH.STORAGE, 'AddressesTxsRefsStorage_config.json') ];
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
     * @param {number[]} neededSnapHeights */
    static async archiveCheckpoint(checkpointHeight = 0, fromPath, snapshotsHeights, neededSnapHeights) {
        try {
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
        } catch (error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
    }
    /** @param {Buffer} buffer @param {string} hashToVerify */
    static unarchiveCheckpointBuffer(checkpointBuffer, hashToVerify) {
        try {
            const buffer = Buffer.from(checkpointBuffer);
            const hash_V1 = crypto.createHash('sha256').update(buffer).digest('hex');
            const isValidHash_V1 = hash_V1 === hashToVerify;
            if (!isValidHash_V1) storageMiniLogger.log('<> Hash V1 mismatch! <>', (m, c) => console.info(m, c));
            //if (hash !== hashToVerify) { storageMiniLogger.log('<> Hash mismatch! <>', (m, c) => console.info(m, c)); return false; }
    
            const destPath = path.join(PATH.STORAGE, 'ACTIVE_CHECKPOINT');
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
	txsRefsPath;
    batchSize = 1000; // number of transactions references per file
    snapHeight = -1;
	
    /** @type {Object<string, Object<string, Object<string, addTxsRefsInfo>>} */
    architecture = {}; // lvl0: { lvl1: { address: addTxsRefsInfo } }
    /** @type {Object<number, Object<string, boolean>>} */
    involedAddressesOverHeights = {}; // { height: {addresses: true} } useful for pruning
    maxInvoledHeights = 10; // max number of heights to keep in memory useful when loading snapshots
    
	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) {
		this.configPath = path.join(storage.PATH.STORAGE, 'AddressesTxsRefsStorage_config.json');
		this.txsRefsPath = storage.PATH.TXS_REFS;
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
            if (!fs.existsSync(path.join(this.txsRefsPath, lvl0))) fs.mkdirSync(path.join(this.txsRefsPath, lvl0));
        }

        const lvl1 = address.slice(2, 3);
        if (this.architecture[lvl0][lvl1] === undefined) {
            this.architecture[lvl0][lvl1] = {};
            if (!fs.existsSync(path.join(this.txsRefsPath, lvl0, lvl1))) fs.mkdirSync(path.join(this.txsRefsPath, lvl0, lvl1));
        }

        return { lvl0, lvl1 };
    }
    #clearArchitectureIfFolderMissing(lvl0, lvl1, address) {
        if (!this.architecture[lvl0][lvl1][address]) return;

        const dirPath = path.join(this.txsRefsPath, lvl0, lvl1, address);
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
        
        const dirPath = path.join(this.txsRefsPath, lvl0, lvl1, address);
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

        const dirPath = path.join(this.txsRefsPath, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        // 0-100: 0, 100-200: 1, 200-300: 2, etc...
        const batchIndex = Math.floor(this.architecture[lvl0][lvl1][address].totalTxsRefs / this.batchSize);
        const filePath = path.join(dirPath, `${batchIndex -1}.bin`);
        return fs.promises.writeFile(filePath, serialized); //? not sure "return" is good here
    }
    async #saveTempTxsRefs(address = '', txsRefs = [], highestIndex = -1) {
        const serialized = serializer.serialize.txsReferencesArray(txsRefs);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        const dirPath = path.join(this.txsRefsPath, lvl0, lvl1, address);
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

        const dirPath = path.join(this.txsRefsPath, lvl0, lvl1, address);
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
        storageMiniLogger.log(`Pruned all transactions references upper than #${height}`, (m, c) => console.info(m, c));
    }
    reset(reason = 'na') {
        if (fs.existsSync(this.txsRefsPath)) fs.rmSync(this.txsRefsPath, { recursive: true });
        if (fs.existsSync(this.configPath)) fs.rmSync(this.configPath);
        
        fs.mkdirSync(this.txsRefsPath);
        this.snapHeight = -1;
        this.architecture = {};
        this.involedAddressesOverHeights = {};
        storageMiniLogger.log(`AddressesTxsRefsStorage reset: ${reason}`, (m, c) => console.info(m, c));
    }
}

export class BlockchainStorage {
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
    /** @param {BlockData} blockData */
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
        return serializer.deserialize.block(serialized);
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
        const batchFolderPath = path.join(this.storage.PATH.BLOCKS_INFO, batchFolderName);
        const blockHash = this.hashByIndex[blockIndex];
		const blockInfoFilePath = path.join(batchFolderPath, `${blockIndex.toString()}-${blockHash}.bin`);

        try {
            const buffer = fs.readFileSync(blockInfoFilePath);
            if (!deserialize) return new Uint8Array(buffer);

            /** @type {BlockInfo} */
            const blockInfo = serializer.deserialize.rawData(buffer);
            return blockInfo;
        } catch (error) {
            storageMiniLogger.log(`BlockInfo not found ${blockIndex.toString()}-${blockHash}.bin`, (m, c) => console.info(m, c));
            storageMiniLogger.log(error.stack, (m, c) => console.info(m, c));
            return null;
        }
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
    #extractSerializedBlockTimestamp(serializedBlock) {
        return this.converter.bytes8ToNumber(serializedBlock.slice(62, 70));
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
        const serializedBlock = this.retreiveBlock(blockIndex, false);
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