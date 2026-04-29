// @ts-check
// A primitive way to store the blockchain data and wallet data etc...
// As usual, use Ctrl + k, Ctrl + 0 to fold all blocks of code
import fs from 'fs';
import url from 'url';
import path from 'path';
import { HashFunctions } from '../node/src/conCrypto.mjs';
import { MiniLogger } from '../miniLogger/mini-logger.mjs';

/** THE COMMON CLASS TO HANDLE THE STORAGE PATHS */
class StorageRoot {
	/** The local identifier used as subFolder */	localIdentifier;
	/** Root folder path @type {string} */				 rootFolder; // 'contrast/' or 'contrast-mainnet/' or 'contrast-testnet/'
	/** Paths used for storage */							   PATH; // 'constrat-storage-mainnet/' or 'contrast-storage-testnet/'
	/** Suffix used for storage paths */					 SUFFIX;

	/** @param {string|null} masterHex - master hex string to generate local identifier */
	constructor(masterHex = null) {
		this.rootFolder = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
		this.localIdentifier = masterHex ? HashFunctions.SHA512(masterHex).hashHex.substring(0, 8) : null;
		console.log(`Storage localIdentifier: ${this.localIdentifier}`);

		const rootFolderName = path.basename(this.rootFolder);
		this.SUFFIX = ['contrast', 'contrast-mainnet'].includes(rootFolderName)
			? '-mainnet'
			: `-testnet`;
	
		const basePath = !this.localIdentifier ? path.join(path.dirname(this.rootFolder), `contrast-storage${this.SUFFIX}`)
			: path.join(path.dirname(this.rootFolder), `contrast-storage${this.SUFFIX}`, this.localIdentifier);
	
		this.PATH = {
			STORAGE: basePath,
			TRASH: path.join(basePath, 'trash'),
			LEDGERS: path.join(basePath, 'ledgers'),
			BLOCKCHAIN: path.join(basePath, 'blockchain'),
			IDENTITIES: path.join(basePath, 'identities')
		};

		if (masterHex) this.#init(); // create storage folders.
	}
	#init() { // create the contrast-storage folder if it doesn't exist, and any of subfolder
		for (const dirPath of Object.values(this.PATH))
			if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
	}
	clear(passHash = true, nodeSettings = true, vssData = true) {
		const dirPaths = [
			this.PATH.TRASH,
			this.PATH.LEDGERS,
			this.PATH.BLOCKCHAIN,
			this.PATH.IDENTITIES
		];
		const filePaths = [];
		if (passHash) filePaths.push(path.join(this.PATH.STORAGE, 'passHash.bin'));
		if (nodeSettings) filePaths.push(path.join(this.PATH.STORAGE, 'nodeSetting.bin'));
		if (vssData) filePaths.push(path.join(this.PATH.STORAGE, 'vss.bin'));

		for (const dirPath of dirPaths)
			if (!fs.existsSync(dirPath)) continue;
			else { fs.rmSync(dirPath, { recursive: true }); console.log(`${dirPath} removed.`) }

		for (const filePath of filePaths)
			if (!fs.existsSync(filePath)) continue;
			else { fs.rmSync(filePath); console.log(`${filePath} removed.`) }

		this.#init();
	}
}

/** The main Storage */
export class ContrastStorage extends StorageRoot {
	miniLogger = new MiniLogger('storage');
	/** @type {string} */ version; // version of the node, used for some versionned data handling in the storage. Ex: '0.6.12' (from package.json version)

	/** @param {string|null} masterHex - master hex string to generate local identifier */
	constructor(masterHex = null) {
		super(masterHex);
		this.version = this.loadJSON('package', true).version; // ex: '0.6.12'
	}

	/** @param {string} fileName @param {Uint8Array} serializedData @param {string} [directoryPath] */
	saveBinary(fileName, serializedData, directoryPath, skipMkdir = false) {
		try {
			const d = directoryPath || this.PATH.STORAGE;
			if (!skipMkdir) fs.mkdirSync(d, { recursive: true });

			fs.writeFileSync(path.join(d, `${fileName}.bin`), serializedData);
		} catch (/**@type {any}*/ error) { this.miniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
		return true;
	}
	/** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
	async saveBinaryAtomicAsync(fileName, serializedData, directoryPath, skipMkdir = false) {
		try {
			const d = directoryPath || this.PATH.STORAGE;
			if (!skipMkdir) await fs.promises.mkdir(d, { recursive: true });

			const tempFilePath = path.join(d, `${fileName}.bin.tmp`);
			const finalFilePath = path.join(d, `${fileName}.bin`);
			await fs.promises.writeFile(tempFilePath, serializedData);
			return { tempFilePath, finalFilePath };
		} catch (/** @type {any} */ error) { this.miniLogger.log(error.stack, (m, c) => console.info(m, c)); return null; }
	}
	/** @param {string} tempFilePath @param {string} finalFilePath */
	commitAtomic(tempFilePath, finalFilePath) {
		try {
			if (process.platform === 'win32' && fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
			fs.renameSync(tempFilePath, finalFilePath);
		} catch (/** @type {any} */ error) { this.miniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
		return true;
	}
	/** @param {string} fileName @param {string} [directoryPath] @returns {Uint8Array | null} */
	loadBinary(fileName, directoryPath, logError = true) {
		const filePath = path.join(directoryPath || this.PATH.STORAGE, `${fileName}.bin`);
		try { return fs.readFileSync(filePath) } // work as Uint8Array
		catch (/**@type {any}*/ error) {
			if (!logError) return null;
			if (error.code === 'ENOENT') this.miniLogger.log(`File not found: ${filePath}`, (m, c) => console.info(m, c));
			else this.miniLogger.log(error.stack, (m, c) => console.info(m, c));
		}
		return null;
	}
	/** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
	async saveBinaryAsync(fileName, serializedData, directoryPath) {
		try {
			const d = directoryPath || this.PATH.STORAGE;
			if (!fs.existsSync(d)) fs.mkdirSync(d);
			await fs.promises.writeFile(path.join(d, `${fileName}.bin`), serializedData);
		} catch (/**@type {any}*/ error) { this.miniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
	}
	/** @param {string} fileName @param {string} directoryPath @returns {Promise<Uint8Array | null>} */
	async loadBinaryAsync(fileName, directoryPath, logError = true) {
		const filePath = path.join(directoryPath || this.PATH.STORAGE, `${fileName}.bin`);
		try { return await fs.promises.readFile(filePath); } // work as Uint8Array
		catch (/**@type {any}*/ error) {
			if (!logError) return null;
			if (error.code === 'ENOENT') this.miniLogger.log(`File not found: ${filePath}`, (m, c) => console.info(m, c));
			else this.miniLogger.log(error.stack, (m, c) => console.info(m, c));
		}
		return null;
	}
	isFileExist(fileNameWithExtension = 'toto.bin', directoryPath = this.PATH.STORAGE) {
		const filePath = path.join(directoryPath, fileNameWithExtension);
		return fs.existsSync(filePath);
	}
	/** @param {string} fileName - The name of the file @param {any} data - The data to save */
	saveJSON(fileName, data) {
		try {
			const filePath = path.join(this.PATH.STORAGE, `${fileName}.json`);
			if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath));
			fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
		} catch (/**@type {any}*/ error) { this.miniLogger.log(error.stack, (m, c) => console.info(m, c)); return false }
	}
	/** @param {string} fileName - The name of the file @returns {any|boolean} */
	loadJSON(fileName, fromRoot = false) {
		const folderPath = fromRoot ? this.rootFolder : this.PATH.STORAGE;
		// @ts-ignore: readFileSync() on .json file returns string
		try { return JSON.parse(fs.readFileSync(path.join(folderPath, `${fileName}.json`))) }
		catch (/**@type {any}*/ error) { return false }
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