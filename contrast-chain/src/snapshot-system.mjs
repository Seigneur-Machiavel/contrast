import storage from '../storage/local-storage-management.mjs';
import fs from 'fs';
import path from 'path';
const url = await import('url');
import utils from './utils.mjs';

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
	__parentPath = path.join(this.__parentFolderPath, '..');
	__nodesDataPath = path.join(this.__parentPath, 'nodes-data');
	constructor(nodeId) {
		this.__nodeDataPath = path.join(this.__nodesDataPath, nodeId);
		this.__snapshotPath = path.join(this.__nodeDataPath, 'snapshots');
		this.loadedSnapshotHeight = 0;

		this.snapshotHeightModulo = 5;
		this.snapshotToConserve = 10;
	}

	#createMissingDirectories() {
		if (!fs.existsSync(this.__nodesDataPath)) { fs.mkdirSync(this.__nodesDataPath); }
		if (!fs.existsSync(this.__nodeDataPath)) { fs.mkdirSync(this.__nodeDataPath); }
		if (!fs.existsSync(this.__snapshotPath)) { fs.mkdirSync(this.__snapshotPath); }
	}
	#createSnapshotSubDirectories(height) {
		const heightPath = path.join(this.__snapshotPath, `${height}`);
		if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }

		return heightPath;
	}
	/** Get the heights of the snapshots that are saved in the snapshot folder - sorted in ascending order */
	getSnapshotsHeights() {
		try {
			const dirs = fs.readdirSync(this.__snapshotPath);
			if (dirs.length === 0) { return []; }
			const snapshotsHeights = dirs.map(dirName => Number(dirName));
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
	async newSnapshot(utxoCache, vss, memPool) {
		const logPerf = false;
		const currentHeight = utxoCache.blockchain.currentHeight

		this.#createMissingDirectories();
		const heightPath = this.#createSnapshotSubDirectories(currentHeight);

		performance.mark('startSaveVssSpectrum'); // SAVE VSS SPECTRUM
		const serializedSpectum = utils.serializer.rawData.toBinary_v1(vss.spectrum);
		storage.saveBinary('vss', serializedSpectum, heightPath);
		performance.mark('endSaveVssSpectrum');

		performance.mark('startSaveMemPool'); // SAVE MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = utils.serializerFast.serialize.pubkeyAddressesObj(memPool.knownPubKeysAddresses);
		storage.saveBinary(`memPool`, serializedPKAddresses, heightPath);
		performance.mark('endSaveMemPool');

		performance.mark('startSaveUtxoCache'); // SAVE UTXO CACHE
		const totalOfBalancesSerialized = utils.fastConverter.numberTo6BytesUint8Array(utxoCache.totalOfBalances);
		const totalSupplySerialized = utils.fastConverter.numberTo6BytesUint8Array(utxoCache.totalSupply);
		const miniUTXOsSerialized = utils.serializerFast.serialize.miniUTXOsObj(utxoCache.unspentMiniUtxos);

		const utxoCacheDataSerialized = new Uint8Array(6 + 6 + miniUTXOsSerialized.length);
		utxoCacheDataSerialized.set(totalOfBalancesSerialized);
		utxoCacheDataSerialized.set(totalSupplySerialized, 6);
		utxoCacheDataSerialized.set(miniUTXOsSerialized, 12);
		storage.saveBinary('utxoCache', utxoCacheDataSerialized, heightPath);
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
	async rollBackTo(height, utxoCache, vss, memPool) {
		const logPerf = true;
		const heightPath = path.join(this.__snapshotPath, `${height}`);

		performance.mark('startLoadSpectrum'); // LOAD VSS SPECTRUM
		const serializedSpectrum = storage.loadBinary('vss', heightPath);
		vss.spectrum = utils.serializer.rawData.fromBinary_v1(serializedSpectrum);
		performance.mark('endLoadSpectrum');

		performance.mark('startLoadMemPool'); // LOAD MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = storage.loadBinary('memPool', heightPath);
		memPool.knownPubKeysAddresses = utils.serializerFast.deserialize.pubkeyAddressesObj(serializedPKAddresses);
		performance.mark('endLoadMemPool');

		performance.mark('startLoadUtxoCache'); // LOAD UTXO CACHE
		const utxoCacheDataSerialized = storage.loadBinary('utxoCache', heightPath);
		utxoCache.totalOfBalances = utils.fastConverter.uint86BytesToNumber(utxoCacheDataSerialized.subarray(0, 6));
		utxoCache.totalSupply = utils.fastConverter.uint86BytesToNumber(utxoCacheDataSerialized.subarray(6, 12));
		//const deserializationStart = performance.now();
		utxoCache.unspentMiniUtxos = utils.serializerFast.deserialize.miniUTXOsObj(utxoCacheDataSerialized.subarray(12));
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
		//fs.rmSync(utxoCacheSnapHeightPath, { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
		// move folder to "trash" instead of deleting it
		const trashPath = path.join(this.__nodeDataPath, 'trash');
		if (!fs.existsSync(trashPath)) { fs.mkdirSync(trashPath); }

		const trashSnapPath = path.join(trashPath, `${height}`);
		copyFolderRecursiveSync(utxoCacheSnapHeightPath, trashSnapPath);
		fs.rmSync(utxoCacheSnapHeightPath, { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
		
		console.info(`Snapshot ${height} moved to trash`);
	}
	restoreLoadedSnapshot(overwrite = false, clearTrash = true) {
		const height = this.loadedSnapshotHeight;
		if (height === 0) { return false; }

		const heightPath = path.join(this.__snapshotPath, `${height}`);
		const trashPath = path.join(this.__nodeDataPath, 'trash');
		const trashSnapPath = path.join(trashPath, `${height}`);

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
		const trashSnapshots = fs.readdirSync(trashPath);
		for (const snap of trashSnapshots) {
			fs.rmSync(path.join(trashPath, snap), { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
		}

		console.info('Trash cleared');
	}
	/** Erase all snapshots */
	eraseAllSnapshots() {
		const snapshotsHeights = this.getSnapshotsHeights();
		for (const snapHeight of snapshotsHeights) {
			this.#eraseSnapshot(snapHeight);
		}
	}
	/** Erase all snapshots with a height higher than the given one @param {number} height */
	eraseSnapshotsHigherThan(height) {
		const snapshotsHeights = this.getSnapshotsHeights();
		for (const snapHeight of snapshotsHeights) {
			if (snapHeight > height) {
				this.#eraseSnapshot(snapHeight);
			}
		}
	}
	/** Erase all snapshots with a height lower than the given one @param {number} height */
	eraseSnapshotsLowerThan(height) {
		const snapshotsHeights = this.getSnapshotsHeights();
		for (const snapHeight of snapshotsHeights) {
			if (snapHeight < height) {
				this.#eraseSnapshot(snapHeight);
			}
		}
	}
}