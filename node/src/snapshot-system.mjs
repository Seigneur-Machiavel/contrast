import fs from 'fs';
import path from 'path';
const url = await import('url');

import { Storage } from '../../utils/storage-manager.mjs';
import { FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { HashFunctions } from './conCrypto.mjs';

/**
* @typedef {import("./utxoCache.mjs").UtxoCache} UtxoCache
* @typedef {import("./vss.mjs").Vss} Vss
* @typedef {import("./memPool.mjs").MemPool} MemPool
*/

function copyFolderRecursiveSync(src, dest) {
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

export class SnapshotSystem {
	__parentFolderPath = path.dirname(url.fileURLToPath(import.meta.url));
	__nodePath = path.dirname(this.__parentFolderPath);
	__storagePath = path.join(this.__nodePath, 'storage');
	__trashPath = path.join(this.__storagePath, 'trash');
	__snapshotPath = path.join(this.__storagePath, 'snapshots');
	fastConverter = new FastConverter();
	loadedSnapshotHeight = 0;
	snapshotHeightModulo = 5;
	snapshotToConserve = 10;
	knownPubKeysAddressesSnapInfo = {height: 0, hash: ''};

	#createMissingDirectories() {
		if (!fs.existsSync(this.__storagePath)) { fs.mkdirSync(this.__storagePath); }
		if (!fs.existsSync(this.__trashPath)) { fs.mkdirSync(this.__trashPath); }
		if (!fs.existsSync(this.__snapshotPath)) { fs.mkdirSync(this.__snapshotPath); }
	}
	#createSnapshotSubDirectories(height) {
		const heightPath = path.join(this.__snapshotPath, `${height}`);
		if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }

		return heightPath;
	}
	#controlSnapshotQuality(dirName = '') {
		const dirPath = path.join(this.__snapshotPath, dirName);
		const files = fs.readdirSync(dirPath);
		if (!files.includes('memPool.bin')) { return "memPool.bin missing"; }
		if (!files.includes('utxoCache.bin')) { return "utxoCache.bin missing"; }
		if (!files.includes('vss.bin')) { return "vss.bin missing"; }

		return "ok";
	}
	/** Get the heights of the snapshots that are saved in the snapshot folder - sorted in ascending order */
	getSnapshotsHeights() {
		try {
			const dirs = fs.readdirSync(this.__snapshotPath);
			if (dirs.length === 0) { return []; }

			const snapshotsHeights = [];
			for (const dirName of dirs) {
				const control = this.#controlSnapshotQuality(dirName);
				if (control === "ok") { snapshotsHeights.push(Number(dirName)); continue; }

				console.error(`Snapshot #${dirName} is corrupted: ${control}`);
				this.#eraseSnapshot(Number(dirName));
			}

			snapshotsHeights.sort((a, b) => a - b);
			return snapshotsHeights;
		} catch (error) {
			//console.error(error.stack);
			return [];
		}
	}
	/** Save a snapshot of the current state of the blockchain's utxoCache and vss
	 * @param {UtxoCache} utxoCache 
	 * @param {Vss} vss 
	 * @param {MemPool} memPool */
	newSnapshot(utxoCache, vss, memPool) {
		const logPerf = false;
		const height = utxoCache.blockchain.currentHeight

		this.#createMissingDirectories();
		const heightPath = this.#createSnapshotSubDirectories(height);

		performance.mark('startSaveVssSpectrum'); // SAVE VSS SPECTRUM
		const serializedSpectum = serializer.serialize.rawData(vss.spectrum);
		Storage.saveBinary('vss', serializedSpectum, heightPath);
		performance.mark('endSaveVssSpectrum');

		performance.mark('startSaveMemPool'); // SAVE MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = serializer.serialize.pubkeyAddressesObj(memPool.knownPubKeysAddresses);
		this.knownPubKeysAddressesSnapInfo = { height, hash: HashFunctions.xxHash32(serializedPKAddresses) };
		Storage.saveBinary('memPool', serializedPKAddresses, heightPath);
		performance.mark('endSaveMemPool');

		performance.mark('startSaveUtxoCache'); // SAVE UTXO CACHE
		const totalOfBalancesSerialized = this.fastConverter.numberTo6BytesUint8Array(utxoCache.totalOfBalances);
		const totalSupplySerialized = this.fastConverter.numberTo6BytesUint8Array(utxoCache.totalSupply);
		const miniUTXOsSerialized = serializer.serialize.miniUTXOsObj(utxoCache.unspentMiniUtxos);

		const utxoCacheDataSerialized = new Uint8Array(6 + 6 + miniUTXOsSerialized.length);
		utxoCacheDataSerialized.set(totalOfBalancesSerialized);
		utxoCacheDataSerialized.set(totalSupplySerialized, 6);
		utxoCacheDataSerialized.set(miniUTXOsSerialized, 12);
		Storage.saveBinary('utxoCache', utxoCacheDataSerialized, heightPath);
		performance.mark('endSaveUtxoCache');

		if (logPerf) {
			performance.mark('newSnapshot end');
			performance.measure('\nsaveMemPool', 'startSaveMemPool', 'endSaveMemPool');
			performance.measure('saveVssSpectrum', 'startSaveVssSpectrum', 'endSaveVssSpectrum');
			performance.measure('saveUtxoCache', 'startSaveUtxoCache', 'endSaveUtxoCache');
			performance.measure('totalSnapshot', 'startSaveVssSpectrum', 'newSnapshot end');
		}
	}
	/** Roll back to a previous snapshot, will fill the utxoCache and vss with the data from the snapshot
	 * @param {number} height 
	 * @param {UtxoCache} utxoCache 
	 * @param {Vss} vss 
	 * @param {MemPool} memPool */
	rollBackTo(height, utxoCache, vss, memPool) {
		const logPerf = true;
		const heightPath = path.join(this.__snapshotPath, `${height}`);

		performance.mark('startLoadSpectrum'); // LOAD VSS SPECTRUM
		const serializedSpectrum = Storage.loadBinary('vss', heightPath);
		vss.spectrum = serializer.deserialize.rawData(serializedSpectrum);
		performance.mark('endLoadSpectrum');

		performance.mark('startLoadMemPool'); // LOAD MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = Storage.loadBinary('memPool', heightPath);
		this.knownPubKeysAddressesSnapInfo = { height, hash: HashFunctions.xxHash32(serializedPKAddresses) };
		memPool.knownPubKeysAddresses = serializer.deserialize.pubkeyAddressesObj(serializedPKAddresses);
		performance.mark('endLoadMemPool');

		performance.mark('startLoadUtxoCache'); // LOAD UTXO CACHE
		const utxoCacheDataSerialized = Storage.loadBinary('utxoCache', heightPath);
		utxoCache.totalOfBalances = this.fastConverter.uint86BytesToNumber(utxoCacheDataSerialized.subarray(0, 6));
		utxoCache.totalSupply = this.fastConverter.uint86BytesToNumber(utxoCacheDataSerialized.subarray(6, 12));
		//const deserializationStart = performance.now();
		utxoCache.unspentMiniUtxos = serializer.deserialize.miniUTXOsObj(utxoCacheDataSerialized.subarray(12));
		//const deserializationEnd = performance.now();
		//if (logPerf) { console.log(`Deserialization time: ${deserializationEnd - deserializationStart}ms`); }
		performance.mark('endLoadUtxoCache');

		performance.mark('buildAddressesAnchorsFromUnspentMiniUtxos');
		utxoCache.buildAddressesAnchorsFromUnspentMiniUtxos();
		performance.mark('endBuildAddressesAnchorsFromUnspentMiniUtxos');
		if (logPerf) {
			performance.mark('rollBackTo end');
			performance.measure('loadSpectrum', 'startLoadSpectrum', 'endLoadSpectrum');
			performance.measure('loadMemPool', 'startLoadMemPool', 'endLoadMemPool');
			performance.measure('loadUtxoCache', 'startLoadUtxoCache', 'endLoadUtxoCache');
			performance.measure('buildAddressesAnchorsFromUnspentMiniUtxos', 'buildAddressesAnchorsFromUnspentMiniUtxos', 'endBuildAddressesAnchorsFromUnspentMiniUtxos');
			performance.measure('totalRollBack', 'startLoadSpectrum', 'rollBackTo end');
		}

		this.loadedSnapshotHeight = height;
		return true;
	}
	/** Erase a snapshot @param {number} height */
	#eraseSnapshot(height) {
		const utxoCacheSnapHeightPath = path.join(this.__snapshotPath, `${height}`);
		const trashSnapPath = path.join(this.__trashPath, `${height}`);
		copyFolderRecursiveSync(utxoCacheSnapHeightPath, trashSnapPath);
		fs.rmSync(utxoCacheSnapHeightPath, { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
		
		console.info(`Snapshot ${height} moved to trash`);
	}
	restoreLoadedSnapshot(overwrite = false, clearTrash = true) {
		const height = this.loadedSnapshotHeight;
		if (height === 0) { return false; }

		const heightPath = path.join(this.__snapshotPath, `${height}`);
		const trashSnapPath = path.join(this.__trashPath, `${height}`);

		if (!fs.existsSync(trashSnapPath)) { return false; }
		if (fs.existsSync(heightPath) && !overwrite) { return false; }
		
		// restore the snapshot
		if (fs.existsSync(heightPath) && overwrite) {
			fs.rmSync(heightPath, { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
		}

		copyFolderRecursiveSync(trashSnapPath, heightPath);
		fs.rmSync(trashSnapPath, { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });

		console.info(`Snapshot ${height} restored from trash`);
		// ----------------------------------------
		if (!clearTrash) { return true; }

		// clear the trash
		const trashSnapshots = fs.readdirSync(this.__trashPath);
		for (const snap of trashSnapshots) {
			fs.rmSync(path.join(this.__trashPath, snap), { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
		}

		console.info('Trash cleared');
	}
	eraseAllSnapshots() {
		const snapshotsHeights = this.getSnapshotsHeights();
		for (const snapHeight of snapshotsHeights) { this.#eraseSnapshot(snapHeight); }
	}
	/** Erase all snapshots with a height higher than the given one @param {number} height */
	eraseSnapshotsHigherThan(height) {
		const snapshotsHeights = this.getSnapshotsHeights();
		for (const snapHeight of snapshotsHeights) {
			if (snapHeight > height) { this.#eraseSnapshot(snapHeight); }
		}
	}
	/** Erase all snapshots with a height lower than the given one @param {number} height */
	eraseSnapshotsLowerThan(height) {
		const snapshotsHeights = this.getSnapshotsHeights();
		for (const snapHeight of snapshotsHeights) {
			if (snapHeight < height) { this.#eraseSnapshot(snapHeight); }
		}
	}
}