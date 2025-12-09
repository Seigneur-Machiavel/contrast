import fs from 'fs';
import path from 'path';
import { serializer } from '../../utils/serializer.mjs';
import { HashFunctions } from './conCrypto.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
const snapshotLogger = new MiniLogger('SnapshotSystem');

/**
* @typedef {import("./utxoCache.mjs").UtxoCache} UtxoCache
* @typedef {import("./mempool.mjs").MemPool} MemPool
* @typedef {import("./vss.mjs").Vss} Vss */

/** Get the heights of the snapshots that are saved in the snapshot folder - sorted in ascending order */
export function readSnapshotsHeightsOfDir(dirPath = '') {
	const snapshotDirs = fs.readdirSync(dirPath).filter((file) => {
		const filePath = path.join(dirPath, file);
		return fs.statSync(filePath).isDirectory() && !isNaN(Number(file));
	});
	if (snapshotDirs.length === 0) return [];
	
	// remove malformed snapshots
	const snapshotsHeights = [];
	for (const snapshotDir of snapshotDirs) {
		const snapshotPath = path.join(dirPath, snapshotDir);
		const files = fs.readdirSync(snapshotPath);
		let missingFiles = [];
		if (!files.includes('memPool.bin')) missingFiles.push('memPool.bin');
		if (!files.includes('utxoCache.bin')) missingFiles.push('utxoCache.bin');
		if (!files.includes('vss.bin')) missingFiles.push('vss.bin');
		if (missingFiles.length === 0) snapshotsHeights.push(Number(snapshotDir));
		else {
			snapshotLogger.log(`Erasing malformed snapshot #${snapshotDir} | missing files: ${missingFiles.join(', ')}`, (m, c) => console.error(m, c));
			fs.rmSync(snapshotPath, { recursive: true, force: true }, (err) => { if (err) snapshotLogger.log(err.stack, (m, c) => console.error(m, c)); });
		}
	}

	// read heights and sort them in ascending order
	return snapshotsHeights.sort((a, b) => a - b);
}

export class SnapshotSystem {
	storage;
	loadedSnapshotHeight = 0;
	snapshotHeightModulo = 5;
	snapshotToConserve = 10;
	knownPubKeysAddressesSnapInfo = { height: 0, hash: '' };

	/** @param {import('../../utils/storage.mjs').ContrastStorage} storage */
	constructor(storage) { this.storage = storage; }
	
	/** Get the heights of the snapshots that are saved in the snapshot folder - sorted in ascending order */
	mySnapshotsHeights() { return readSnapshotsHeightsOfDir(this.storage.PATH.SNAPSHOTS) }
	/** Save a snapshot of the current state of the blockchain's utxoCache and vss
	 * @param {UtxoCache} utxoCache @param {Vss} vss @param {MemPool} memPool */
	async newSnapshot(utxoCache, vss, memPool) {
		const height = utxoCache.blockchain.currentHeight;
		const heightPath = path.join(this.storage.PATH.SNAPSHOTS, `${height}`);
		if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }

		const serializedSpectum = serializer.serialize.rawData(vss.spectrum);
		await this.storage.saveBinaryAsync('vss', serializedSpectum, heightPath);
		await new Promise((resolve) => setImmediate(resolve));

		// SAVE MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = serializer.serialize.pubkeyAddressesObj(memPool.knownPubKeysAddresses);
		this.knownPubKeysAddressesSnapInfo = { height, hash: HashFunctions.xxHash32(serializedPKAddresses) };
		await this.storage.saveBinaryAsync('memPool', serializedPKAddresses, heightPath);
		await new Promise((resolve) => setImmediate(resolve));

		// SAVE UTXO CACHE
		const utxoCacheDataSerialized = serializer.serialize.utxoCacheData(utxoCache);
		await this.storage.saveBinaryAsync('utxoCache', utxoCacheDataSerialized, heightPath);
	}
	/** Roll back to a previous snapshot, will fill the utxoCache and vss with the data from the snapshot
	 * @param {number} height @param {UtxoCache} utxoCache @param {Vss} vss @param {MemPool} memPool */
	async rollBackTo(height, utxoCache, vss, memPool) {
		if (height === 0) return false;
		
		// LOAD VSS SPECTRUM
		const heightPath = path.join(this.storage.PATH.SNAPSHOTS, `${height}`);
		const serializedSpectrum = await this.storage.loadBinaryAsync('vss', heightPath);
		vss.spectrum = serializer.deserialize.rawData(serializedSpectrum);

		// LOAD MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = await this.storage.loadBinaryAsync('memPool', heightPath);
		this.knownPubKeysAddressesSnapInfo = { height, hash: HashFunctions.xxHash32(serializedPKAddresses) };
		memPool.knownPubKeysAddresses = serializer.deserialize.pubkeyAddressesObj(serializedPKAddresses);

		// LOAD UTXO CACHE
		const utxoCacheDataSerialized = await this.storage.loadBinaryAsync('utxoCache', heightPath);
		utxoCache.totalOfBalances = this.fastConverter.uint86BytesToNumber(utxoCacheDataSerialized.subarray(0, 6));
		utxoCache.totalSupply = this.fastConverter.uint86BytesToNumber(utxoCacheDataSerialized.subarray(6, 12));
		utxoCache.unspentMiniUtxos = serializer.deserialize.miniUTXOsObj(utxoCacheDataSerialized.subarray(12));
		utxoCache.buildAddressesAnchorsFromUnspentMiniUtxos();
		this.loadedSnapshotHeight = height;
		return true;
	}
	/** Erase a snapshot @param {number} height */
	#moveSnapshotToTrash(height) {
		const [targetPath, trashTargetPath] = [path.join(this.storage.PATH.SNAPSHOTS, `${height}`), path.join(this.storage.PATH.TRASH, `${height}`)];
		if (fs.existsSync(trashTargetPath)) fs.rmSync(trashTargetPath, { recursive: true, force: true });
		fs.renameSync(targetPath, trashTargetPath);
		snapshotLogger.log(`Snapshot #${height} moved to trash`, (m, c) => console.info(m, c));
	}
	/** Move all snapshots with a height higher than the given one to trash @param {number} height */
	moveSnapshotsHigherThanHeightToTrash(height) {
		for (const snapHeight of this.mySnapshotsHeights())
			if (snapHeight > height) this.#moveSnapshotToTrash(snapHeight);
	}
	/** Move all snapshots with a height lower than the given one to trash @param {number} height */
	moveSnapshotsLowerThanHeightToTrash(height) {
		for (const snapHeight of this.mySnapshotsHeights())
			if (snapHeight < height) this.#moveSnapshotToTrash(snapHeight);
	}
	/** Restore a snapshot from the trash */
	restoreLoadedSnapshot(overwrite = false) {
		if (this.loadedSnapshotHeight === 0) return false;

		const [targetPath, trashTargetPath] = [path.join(this.storage.PATH.SNAPSHOTS, `${this.loadedSnapshotHeight}`), path.join(this.storage.PATH.TRASH, `${this.loadedSnapshotHeight}`)];
		if (!fs.existsSync(trashTargetPath)) return false; // trash snapshot not found
		if (fs.existsSync(targetPath)) {
			if (!overwrite) return false;
			fs.rmSync(targetPath, { recursive: true, force: true }, (err) => { if (err) { snapshotLogger.log(err, (m, c) => console.error(m, c)); } });
		}

		fs.renameSync(trashTargetPath, targetPath);
		snapshotLogger.log(`Snapshot #${this.loadedSnapshotHeight} restored from trash`, (m, c) => console.info(m, c));
	}
}