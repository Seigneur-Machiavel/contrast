import fs from 'fs';
import path from 'path';
import { Storage, BlockchainStorage, PATH, copyFolderRecursiveSync } from '../../utils/storage-manager.mjs';
import { FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { BlockData, BlockUtils } from './block-classes.mjs';
import { HashFunctions } from './conCrypto.mjs';

/**
* @typedef {import("./utxoCache.mjs").UtxoCache} UtxoCache
* @typedef {import("./vss.mjs").Vss} Vss
* @typedef {import("./memPool.mjs").MemPool} MemPool
*/

export class SnapshotSystem {
	activeCheckpointHeight = false;
	activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // hash of block -1
	activeCheckpointLastSnapshotHeight = false;
	activeCheckpointPath = path.join(PATH.STORAGE, 'CHECKPOINT');

	fastConverter = new FastConverter();
	loadedSnapshotHeight = 0;
	snapshotHeightModulo = 5;
	snapshotToConserve = 10;
	checkpointHeightModulo = 100;
	checkpointToConserve = 10;
	knownPubKeysAddressesSnapInfo = { height: 0, hash: '' };
	lastCheckpointInfo = { height: 0, hash: '' };

	#createMissingDirectories() {
		if (!fs.existsSync(PATH.STORAGE)) { fs.mkdirSync(PATH.STORAGE); }
		if (!fs.existsSync(PATH.TRASH)) { fs.mkdirSync(PATH.TRASH); }
		if (!fs.existsSync(PATH.SNAPSHOTS)) { fs.mkdirSync(PATH.SNAPSHOTS); }
	}
	#createSnapshotSubDirectories(height) {
		const heightPath = path.join(PATH.SNAPSHOTS, `${height}`);
		if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }

		return heightPath;
	}
	
	// SNAPSHOTS
	#controlSnapshotQuality(dirPath = '') {
		const files = fs.readdirSync(dirPath);
		if (!files.includes('memPool.bin')) { return "memPool.bin missing"; }
		if (!files.includes('utxoCache.bin')) { return "utxoCache.bin missing"; }
		if (!files.includes('vss.bin')) { return "vss.bin missing"; }

		return "ok";
	}
	/** Get the heights of the snapshots that are saved in the snapshot folder - sorted in ascending order */
	getSnapshotsHeights(dirPath = PATH.SNAPSHOTS) {
		try {
			const dirs = fs.readdirSync(dirPath);
			if (dirs.length === 0) { return []; }

			const snapshotsHeights = [];
			for (const dirName of dirs) {
				const control = this.#controlSnapshotQuality(path.join(PATH.SNAPSHOTS, dirName));
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
		const heightPath = path.join(PATH.SNAPSHOTS, `${height}`);

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
		const utxoCacheSnapHeightPath = path.join(PATH.SNAPSHOTS, `${height}`);
		const trashSnapPath = path.join(PATH.TRASH, `${height}`);
		copyFolderRecursiveSync(utxoCacheSnapHeightPath, trashSnapPath);
		fs.rmSync(utxoCacheSnapHeightPath, { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
		
		console.info(`Snapshot ${height} moved to trash`);
	}
	restoreLoadedSnapshot(overwrite = false, clearTrash = true) {
		const height = this.loadedSnapshotHeight;
		if (height === 0) { return false; }

		const heightPath = path.join(PATH.SNAPSHOTS, `${height}`);
		const trashSnapPath = path.join(PATH.TRASH, `${height}`);

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
		const trashSnapshots = fs.readdirSync(PATH.TRASH);
		for (const snap of trashSnapshots) {
			fs.rmSync(path.join(PATH.TRASH, snap), { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
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

	// MY CHECKPOINTS
	getCheckpointsInfos() {
		const result = { checkpointsHeights: [], checkpointsHashes: {} };
		const dirs = fs.readdirSync(PATH.CHECKPOINTS);
		if (dirs.length === 0) { return result; }

		for (const dirName of dirs) {
			const height = Number(dirName);
			const files = fs.readdirSync(path.join(PATH.CHECKPOINTS, dirName));
			if (files.length !== 1) { console.error(`---! Checkpoint #${height} is corrupted !---`); continue; }

			result.checkpointsHeights.push(height);
			result.checkpointsHashes[height] = files[0].split('.')[0];
		}

		result.checkpointsHeights.sort((a, b) => a - b);
		return result;
	}
	async newCheckpoint(height) {
		const checkpointsInfos = this.getCheckpointsInfos();

		const fixedCheckpointsHeights = [];
		const fixedCheckpointsHashes = {};
		for (const h of Object.keys(checkpointsInfos.checkpointsHashes)) {
			const checkpointHeight = Number(h);
			const maxCheckpointsReached = fixedCheckpointsHeights.length > this.checkpointToConserve;
			if (checkpointHeight >= height || maxCheckpointsReached) {
				fs.rmSync(path.join(PATH.CHECKPOINTS, `${checkpointHeight}`), { recursive: true, force: true });
				continue;
			}
			fixedCheckpointsHeights.push(h);
			fixedCheckpointsHashes[checkpointHeight] = checkpointsInfos.checkpointsHashes[checkpointHeight];
		}
		checkpointsInfos.checkpointsHeights = fixedCheckpointsHeights.sort((a, b) => a - b);
		checkpointsInfos.checkpointsHashes = fixedCheckpointsHashes;

		const hash = Storage.archiveCheckpoint(height);
		if (typeof hash !== 'string') { console.error(`---! Checkpoint #${height} failed !---`); return; }

		this.lastCheckpointInfo = { height, hash };
		return true;
	}
	loadCheckpointZipArchive(archiveHash) {
		const checkpointsInfos = this.getCheckpointsInfos();
		let checkpointHeight;
		for (const h of Object.keys(checkpointsInfos.checkpointsHashes)) {
			if (checkpointsInfos.checkpointsHashes[h] !== archiveHash) { continue; }
			checkpointHeight = h;
			break;
		}

		if (!checkpointHeight) { return false; }
		
		const archivePath = path.join(heightPath, checkpointHeight, `${archiveHash}.zip`);
		try {
			const buffer = fs.readFileSync(archivePath);
			return buffer;
		} catch (error) {
			storageMiniLogger.log(error.stack, (m) => { console.error(m); });
			return false;
		}
	}
	getLastCheckpointInfo() {
		if (!this.lastCheckpointInfo.height) {
			const checkpointsInfos = this.getCheckpointsInfos();
			if (checkpointsInfos.checkpointsHeights.length === 0) {
				this.lastCheckpointInfo = { height: 0, hash: '' };
			} else {
				const lastHeight = checkpointsInfos.checkpointsHeights[checkpointsInfos.checkpointsHeights.length - 1];
				this.lastCheckpointInfo = { height: lastHeight, hash: checkpointsInfos.checkpointsHashes[lastHeight] };
			}
		}

		return this.lastCheckpointInfo;
	}

	// ACTIVE CHECKPOINT
	#extractLastSnapshotHeightOfCheckpoint() {
		const activeCheckpointSnapshotsPath = path.join(this.activeCheckpointPath, 'snapshots');
		const snapshotsHeights = this.getSnapshotsHeights(activeCheckpointSnapshotsPath);
		if (snapshotsHeights.length === 0) { return false; }
		
		return snapshotsHeights[snapshotsHeights.length - 1];
	}
	/** @param {Uint8Array} checkpointBuffer @param {string} hashToVerify */
	extractBufferAsActiveCheckpoint(checkpointBuffer, hashToVerify) {
		const result = Storage.unarchiveCheckpointBuffer(checkpointBuffer, hashToVerify);
		if (!result) { return false; }

		const lastSnapshotHeight = this.#extractLastSnapshotHeightOfCheckpoint();
		if (!lastSnapshotHeight) { return false; }
		
		this.activeCheckpointHeight = -1; // Set to -1 to indicate that the checkpoint is active (default: false)
		this.activeCheckpointLastSnapshotHeight = lastSnapshotHeight;

		return true;
	}
	checkForActiveCheckpoint() {
		if (!fs.existsSync(this.activeCheckpointPath)) { return false; }

		const checkpointSnapshotsPath = path.join(this.activeCheckpointPath, 'snapshots');
		if (!fs.existsSync(checkpointSnapshotsPath)) {
			console.error('Active checkpoint corrupted: snapshots folder missing');
			fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });
			return false;
		}

		const lastSnapshotHeight = this.#extractLastSnapshotHeightOfCheckpoint();
		if (!lastSnapshotHeight) { return false; }
		
		this.activeCheckpointHeight = -1; // Set to -1 to indicate that the checkpoint is active (default: false)
		this.activeCheckpointLastSnapshotHeight = lastSnapshotHeight;

		const checkpointBlocksPath = path.join(this.activeCheckpointPath, 'blocks');
		if (!fs.existsSync(checkpointBlocksPath)) { return true; } // exist but empty, need to sync missing blocks

		const blocksFoldersSorted = BlockchainStorage.getListOfFoldersInBlocksDirectory(checkpointBlocksPath);
		if (blocksFoldersSorted.length === 0) { return true; } // exist but empty, need to sync missing blocks

		const lastBlockFolder = blocksFoldersSorted[blocksFoldersSorted.length - 1];
		const files = fs.readdirSync(path.join(checkpointBlocksPath, lastBlockFolder));
		if (!files.length) { return true; } // exist but empty, need to sync missing blocks
		
		for (let j = 0; j < files.length; j++) {
			const fileName = files[j].split('.')[0];
			const blockIndex = parseInt(fileName.split('-')[0], 10);
			const blockHash = fileName.split('-')[1];
			if (blockIndex <= this.activeCheckpointHeight) { continue; }

			this.activeCheckpointHeight = blockIndex;
			this.activeCheckpointHash = blockHash;
		}

		return true; // need to sync missing blocks
	}
	/** @param {BlockData} finalizedBlock @param {Uint8Array} serializedBlock */
	async fillActiveCheckpointWithBlock(finalizedBlock, serializedBlock) {
		if (this.activeCheckpointHeight === false) { throw new Error('(Checkpoint fill) Active checkpoint not set'); }
		if (this.activeCheckpointHeight + 1 !== finalizedBlock.index) { throw new Error('(Checkpoint fill) Block index mismatch'); }

		const { hex, bitsArrayAsString } = await BlockUtils.getMinerHash(finalizedBlock, this.useDevArgon2);
        if (finalizedBlock.hash !== hex) { throw new Error('(Checkpoint fill) Block hash mismatch'); }
		if (hex !== this.activeCheckpointHash) { throw new Error('(Checkpoint fill) Block hash mismatch'); }

		const checkpointBlocksPath = path.join(this.activeCheckpointPath, 'blocks');
		const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(finalizedBlock.index).name;
		const batchFolderPath = path.join(checkpointBlocksPath, batchFolderName);
		if (!fs.existsSync(batchFolderPath)) { fs.mkdirSync(batchFolderPath, { recursive: true }); }

		const blockFileName = `${finalizedBlock.index}-${hex}`;
		if (!Storage.saveBinary(blockFileName, serializedBlock, batchFolderPath)) { throw new Error('(Checkpoint fill) Block file save failed'); }

		this.activeCheckpointHeight = finalizedBlock.index;
		this.activeCheckpointHash = hex;

		return true;
	}
	deployCheckpoint() {
		if (this.activeCheckpointHeight === false) { throw new Error(`(Checkpoint deploy) Active checkpoint not set`); }
		if (this.activeCheckpointLastSnapshotHeight === false) { throw new Error(`(Checkpoint deploy) Active checkpoint last snapshot height not set`); }
		
		const checkpointBlocksPath = path.join(this.activeCheckpointPath, 'blocks');
		const checkpointSnapshotsPath = path.join(this.activeCheckpointPath, 'snapshots');
		const checkpointTxsRefsPath = path.join(this.activeCheckpointPath, 'addresses-txs-refs');
		const checkpointTxsRefsConfigPath = path.join(this.activeCheckpointPath, 'AddressesTxsRefsStorage_config.json');

		if (fs.existsSync(PATH.BLOCKS)) { fs.rmSync(PATH.BLOCKS, { recursive: true, force: true }); }
		if (fs.existsSync(PATH.SNAPSHOTS)) { fs.rmSync(PATH.SNAPSHOTS, { recursive: true, force: true }); }
		if (fs.existsSync(PATH.TXS_REFS)) { fs.rmSync(PATH.TXS_REFS, { recursive: true, force: true }); }
		const txsRefsConfigDest = path.join(PATH.STORAGE, 'AddressesTxsRefsStorage_config.json')
		if (fs.existsSync(txsRefsConfigDest)) { fs.rmSync(txsRefsConfigDest, { force: true }); }

		// easier to move
		fs.renameSync(checkpointBlocksPath, PATH.BLOCKS);
		fs.renameSync(checkpointSnapshotsPath, PATH.SNAPSHOTS);
		fs.renameSync(checkpointTxsRefsPath, PATH.TXS_REFS);
		fs.renameSync(checkpointTxsRefsConfigPath, txsRefsConfigDest);
		fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });

		this.activeCheckpointHeight = false;
		this.activeCheckpointLastSnapshotHeight = false;
		this.activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // hash of block -1
	}
}