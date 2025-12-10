import fs from 'fs';
import path from 'path';
import { BlockUtils } from './block.mjs';
import { readSnapshotsHeightsOfDir } from './snapshot.mjs';
import { BlockchainStorage, CheckpointsStorage } from '../../utils/storage.mjs';

/**
 * @typedef {import('../../types/block.mjs').BlockFinalized} BlockFinalized
 * @typedef {import('../../miniLogger/mini-logger.mjs').MiniLogger} MiniLogger
 * @typedef {import('../../utils/storage.mjs').ContrastStorage} ContrastStorage
 * @typedef {import('../../utils/storage.mjs').BlockchainStorage} BlockchainStorage */

export class CheckpointSystem {
	storage;
	miniLogger;
	blockStorage;

	/** @type {boolean | number} */
	activeCheckpointHeight = false;
	/** @type {boolean | number} */
	activeCheckpointLastSnapshotHeight = false;
	activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // fake hash
	activeCheckpointPath = './ACTIVE_CHECKPOINT';

	minGapTryCheckpoint = 720; // 24h
	checkpointHeightModulo = 25;
	checkpointToConserve = 4;
	lastCheckpointInfo = { height: 0, hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
	rndControlDiceFaces = 27; // 1 in 27 chance to verify the block hash

	/** @param {ContrastStorage} storage @param {BlockchainStorage} BlockchainStorage @param {MiniLogger} miniLogger Usually the SnapshotSystem's miniLogger */
	constructor(storage, BlockchainStorage, miniLogger) {
		this.storage = storage;
		this.miniLogger = miniLogger;
		this.blockStorage = BlockchainStorage;
		this.activeCheckpointPath = path.join(this.storage.PATH.STORAGE, 'ACTIVE_CHECKPOINT');
	}

	// MY CHECKPOINTS
	#getCheckpointsInfos() {
		/** @type {{ heights: number[], hashes: { [height: number]: string } }} */
		const result = { heights: [], hashes: {} };
		const dirs = fs.readdirSync(this.storage.PATH.CHECKPOINTS);
		if (dirs.length === 0) return result;

		for (const dirName of dirs) {
			const height = Number(dirName);
			const files = fs.readdirSync(path.join(this.storage.PATH.CHECKPOINTS, dirName));
			if (files.length !== 1) {
				this.miniLogger.log(`---! Checkpoint #${height} is corrupted !---`, (m, c) => console.error(m, c));
				continue;
			}

			result.heights.push(height);
			result.hashes[height] = files[0].split('.')[0];
		}

		result.heights.sort((a, b) => a - b);
		return result;
	}
	/** CAUTION: This will permanently delete checkpoint data, will preserve 3 highest checkpoints */
	pruneCheckpointsLowerThanHeight(height = 0) { // dangerous to prune checkpoints, use with caution
		const result = { erased: [], preserved: [] };
		const descendingHeights = this.#getCheckpointsInfos().heights.reverse();
		for (const h of descendingHeights) {
			const maxCheckpointsReached = result.preserved.length >= this.checkpointToConserve;
			if (h > height && !maxCheckpointsReached) { result.preserved.push(h); continue; }

			fs.rmSync(path.join(this.storage.PATH.CHECKPOINTS, h.toString()), { recursive: true, force: true });
			result.erased.push(h);
		}

		if (result.erased.length === 0) return; // no need to log
		this.miniLogger.log(`Checkpoints pruned | erased: ${result.erased.join(', ')} | preserved: ${result.preserved.join(', ')}`, (m, c) => console.info(m, c));
	}
	async newCheckpoint(height = 1000, snapshotHeightModulo, fromPath, overwrite = false) {
		// We prefer to not overwrite existing checkpoints, but it's possible to force it
		//! The danger is to overwrite a valid checkpoint with a corrupted one:
		//! The "addresses-txs-refs" as been removed from checkpoints
		const heightPath = path.join(this.storage.PATH.CHECKPOINTS, height.toString());
		if (fs.existsSync(heightPath) && !overwrite) {
			this.miniLogger.log(`---! Checkpoint #${height} already exists (overwrite: ${overwrite}) !---`, (m, c) => console.error(m, c));
			if (!overwrite) return false;
		}

		const snapshotsPath = fromPath ? path.join(fromPath, 'snapshots') : this.storage.PATH.SNAPSHOTS;
		const snapshotsHeights = readSnapshotsHeightsOfDir(snapshotsPath);
		const neededSnapHeights = [
			height,
			height - snapshotHeightModulo,
			height - (snapshotHeightModulo * 2)
		];
		const hash = await CheckpointsStorage.archiveCheckpoint(height, fromPath, snapshotsHeights, neededSnapHeights); // save new checkpoint archive (.zip)
		if (typeof hash !== 'string') {
			this.miniLogger.log(`---! Checkpoint #${height} failed !---`, (m, c) => console.error(m, c));
			return false;
		}

		this.lastCheckpointInfo = { height, hash };
		return true;
	}
	readCheckpointZipArchive(archiveHash) {
		const checkpointsHashes = this.#getCheckpointsInfos().hashes;
		for (const height of Object.keys(checkpointsHashes)) {
			if (checkpointsHashes[height] !== archiveHash) continue;

			try { return fs.readFileSync( path.join(this.storage.PATH.CHECKPOINTS, height, `${archiveHash}.zip`) ) }
			catch (error) { this.miniLogger.log(error.stack, (m, c) => console.error(m, c)); return false }
		}
	}
	/** Read one time only if necessary, this.lastCheckpointInfo filled by: newCheckpoint () */
	myLastCheckpointInfo() {
		if (!this.lastCheckpointInfo.height) {
			const checkpointsInfos = this.#getCheckpointsInfos();
			if (checkpointsInfos.heights.length === 0)
				this.lastCheckpointInfo = { height: 0, hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
			else {
				const lastHeight = checkpointsInfos.heights[checkpointsInfos.heights.length - 1];
				this.lastCheckpointInfo = { height: lastHeight, hash: checkpointsInfos.hashes[lastHeight] };
			}
		}

		return this.lastCheckpointInfo;
	}

	// ACTIVE CHECKPOINT
	#randomDiceRoll(diceFaces = 27) { return Math.floor(Math.random() * diceFaces) + 1 === 1; }
	checkForActiveCheckpoint() {
		if (!fs.existsSync(this.activeCheckpointPath)) return false;

		const checkpointSnapshotsPath = path.join(this.activeCheckpointPath, 'snapshots');
		if (!fs.existsSync(checkpointSnapshotsPath)) {
			this.miniLogger.log('Active checkpoint corrupted: snapshots folder missing', (m, c) => console.error(m, c));
			fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });
			return false;
		}

		const snapshotsHeights = readSnapshotsHeightsOfDir(checkpointSnapshotsPath);
		if (snapshotsHeights.length === 0) return false;
		
		this.activeCheckpointHeight = -1; // Set to -1 to indicate that the checkpoint is active (default: false)
		this.activeCheckpointLastSnapshotHeight = snapshotsHeights[snapshotsHeights.length - 1];

		const checkpointBlocksPath = path.join(this.activeCheckpointPath, 'blocks');
		if (!fs.existsSync(checkpointBlocksPath)) return true; // exist but empty, need to sync missing blocks

		const blocksFoldersSorted = BlockchainStorage.getListOfFoldersInBlocksDirectory(checkpointBlocksPath);
		if (blocksFoldersSorted.length === 0) return true; // exist but empty, need to sync missing blocks

		const lastBlockFolder = blocksFoldersSorted[blocksFoldersSorted.length - 1];
		const files = fs.readdirSync(path.join(checkpointBlocksPath, lastBlockFolder));
		if (!files.length) return true; // exist but empty, need to sync missing blocks
		
		for (let j = 0; j < files.length; j++) {
			const fileName = files[j].split('.')[0];
			const blockIndex = parseInt(fileName.split('-')[0], 10);
			const blockHash = fileName.split('-')[1];
			if (blockIndex <= this.activeCheckpointHeight) continue;

			this.activeCheckpointHeight = blockIndex;
			this.activeCheckpointHash = blockHash;
		}

		return true; // need to sync missing blocks
	}
	async migrateBlocksToActiveCheckpoint(stopAt = -1100) {
		if (this.activeCheckpointHeight !== -1) return false; // checkpoint not active or not "init state"
	
		const blocksFoldersSorted = BlockchainStorage.getListOfFoldersInBlocksDirectory();
		for (const folderName of blocksFoldersSorted) {
			const folderPath = path.join(this.storage.PATH.BLOCKS, folderName);
			if (!fs.existsSync(folderPath)) break;
			
			const files = fs.readdirSync(folderPath);
			if (!files.length || files.length <= 0) break;

			let lastBlockIndex = -1;
			let lastBlockHash = '';
			for (let j = 0; j < files.length; j++) {
				const fileName = files[j].split('.')[0];
				const index = parseInt(fileName.split('-')[0], 10);
				if (index >= this.activeCheckpointLastSnapshotHeight + stopAt) {
					fs.rmSync(path.join(folderPath, files[j]), { force: true });
					continue; // remove the block file, not needed
				}
				
				lastBlockIndex = index;
				lastBlockHash = fileName.split('-')[1];
			}

			if (lastBlockIndex === -1) break; // no more blocks to migrate

			// MOVE THE FOLDER TO THE ACTIVE CHECKPOINT
			const infoFolderPath = path.join(this.storage.PATH.BLOCKS_INFO, folderName);
			if (!fs.existsSync(infoFolderPath)) break; // no more blocks to migrate, missing info folder
			if (!fs.existsSync(path.join(this.activeCheckpointPath, 'blocks'))) fs.mkdirSync(path.join(this.activeCheckpointPath, 'blocks'), { recursive: true });
			if (!fs.existsSync(path.join(this.activeCheckpointPath, 'blocks-info'))) fs.mkdirSync(path.join(this.activeCheckpointPath, 'blocks-info'), { recursive: true });
			fs.renameSync(folderPath, path.join(this.activeCheckpointPath, 'blocks', folderName));
			fs.renameSync(infoFolderPath, path.join(this.activeCheckpointPath, 'blocks-info', folderName)); // move info folder

			this.miniLogger.log(`Checkpoint migration: moved folder ${folderName} to active checkpoint`, (m, c) => console.info(m, c));
			this.activeCheckpointHeight = lastBlockIndex;
			this.activeCheckpointHash = lastBlockHash;
		}

		// ENSURE ALL BLOCKS FOLDERS DELETION
		for (const folderName of fs.readdirSync(this.storage.PATH.BLOCKS)) fs.rmSync(path.join(this.storage.PATH.BLOCKS, folderName), { recursive: true, force: true });
		for (const folderName of fs.readdirSync(this.storage.PATH.BLOCKS_INFO)) fs.rmSync(path.join(this.storage.PATH.BLOCKS_INFO, folderName), { recursive: true, force: true });
	}
	/** @param {BlockFinalized} finalizedBlock @param {Uint8Array} serializedBlock @param {Uint8Array} serializedBlockInfo */
	#saveBlockBinary(finalizedBlock, serializedBlock, serializedBlockInfo) {
		const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(finalizedBlock.index).name;
		const batchFolderPath = path.join(this.activeCheckpointPath, 'blocks', batchFolderName);
		const infoBatchFolderPath = path.join(this.activeCheckpointPath, 'blocks-info', batchFolderName);
		const blockFileName = `${finalizedBlock.index}-${finalizedBlock.hash}`;
		
		if (fs.existsSync(path.join(batchFolderPath, `${blockFileName}.bin`))) fs.rmSync(path.join(batchFolderPath, `${blockFileName}.bin`), { force: true });
		if (fs.existsSync(path.join(infoBatchFolderPath, `${blockFileName}.bin`))) fs.rmSync(path.join(infoBatchFolderPath, `${blockFileName}.bin`), { force: true });
		
		if (!fs.existsSync(batchFolderPath)) fs.mkdirSync(batchFolderPath, { recursive: true });
		if (!fs.existsSync(infoBatchFolderPath)) fs.mkdirSync(infoBatchFolderPath, { recursive: true });

		if (!this.storage.saveBinary(blockFileName, serializedBlock, batchFolderPath)) throw new Error('(Checkpoint fill) Block file save failed');
		if (!this.storage.saveBinary(blockFileName, serializedBlockInfo, infoBatchFolderPath)) throw new Error('(Checkpoint fill) Block info file save failed');
	}
	/** @param {BlockFinalized} finalizedBlock @param {Uint8Array} serializedBlock @param {Uint8Array} serializedBlockInfo */
	async fillActiveCheckpointWithBlock(finalizedBlock, serializedBlock, serializedBlockInfo) {
		if (this.activeCheckpointHeight === false) throw new Error('(Checkpoint fill) Active checkpoint not set');
		if (this.activeCheckpointHeight + 1 !== finalizedBlock.index) throw new Error(`(Checkpoint fill) Block index mismatch: ${this.activeCheckpointHeight + 1} !== ${finalizedBlock.index}`);
		
		// on invalid hash!=prevHash => erase the block batch folder, trying to resolve conflict
		if (finalizedBlock.prevHash !== this.activeCheckpointHash) { 
			const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(finalizedBlock.index).name;
			const batchFolderPath = path.join(this.activeCheckpointPath, 'blocks', batchFolderName);
			if (fs.existsSync(batchFolderPath)) fs.rmSync(batchFolderPath, { recursive: true, force: true });
			return 'restart'
		}

		// Hash verification, argon2 based, cost CPU time (~500ms)
		if (this.#randomDiceRoll(this.rndControlDiceFaces)) {
			this.miniLogger.log(`Checkpoint fill: verifying block hash ${finalizedBlock.index}...`, (m, c) => console.info(m, c));
			const { hex, bitsArrayAsString } = await BlockUtils.getMinerHash(finalizedBlock);
        	if (finalizedBlock.hash !== hex) throw new Error(`(Checkpoint fill) Block hash mismatch: ${finalizedBlock.hash} !== ${hex}`);
		}

		this.#saveBlockBinary(finalizedBlock, serializedBlock, serializedBlockInfo);
		this.activeCheckpointHeight = finalizedBlock.index;
		this.activeCheckpointHash = finalizedBlock.hash;

		return true;
	}
	async deployActiveCheckpoint(snapshotHeightModulo, saveZipArchive = true) {
		if (this.activeCheckpointHeight === false) throw new Error(`(Checkpoint deploy) Active checkpoint not set`);
		if (this.activeCheckpointLastSnapshotHeight === false) throw new Error(`(Checkpoint deploy) Active checkpoint last snapshot height not set`);

		if (saveZipArchive) await this.newCheckpoint(this.activeCheckpointHeight, snapshotHeightModulo, this.activeCheckpointPath);

		const txsRefsConfigDest = path.join(this.storage.PATH.STORAGE, 'AddressesTxsRefsStorage_config.json')
		if (fs.existsSync(txsRefsConfigDest)) fs.rmSync(txsRefsConfigDest, { force: true });
		if (fs.existsSync(this.storage.PATH.BLOCKS)) fs.rmSync(this.storage.PATH.BLOCKS, { recursive: true, force: true });
		if (fs.existsSync(this.storage.PATH.SNAPSHOTS)) fs.rmSync(this.storage.PATH.SNAPSHOTS, { recursive: true, force: true });
		if (fs.existsSync(this.storage.PATH.TXS_REFS)) fs.rmSync(this.storage.PATH.TXS_REFS, { recursive: true, force: true });
		if (fs.existsSync(this.storage.PATH.TRASH)) fs.rmSync(this.storage.PATH.TRASH, { recursive: true, force: true });
		if (fs.existsSync(this.storage.PATH.BLOCKS_INFO)) fs.rmSync(this.storage.PATH.BLOCKS_INFO, { recursive: true, force: true });

		fs.renameSync(path.join(this.activeCheckpointPath, 'blocks'), this.storage.PATH.BLOCKS);
		fs.renameSync(path.join(this.activeCheckpointPath, 'blocks-info'), this.storage.PATH.BLOCKS_INFO);
		fs.renameSync(path.join(this.activeCheckpointPath, 'snapshots'), this.storage.PATH.SNAPSHOTS);
		//! fs.renameSync(path.join(this.activeCheckpointPath, 'addresses-txs-refs'), this.storage.PATH.TXS_REFS);
		//! fs.renameSync(path.join(this.activeCheckpointPath, 'AddressesTxsRefsStorage_config.json'), txsRefsConfigDest);
		fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });

		this.activeCheckpointHeight = false;
		this.activeCheckpointLastSnapshotHeight = false;
		this.activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // hash of block -1
	}
	resetCheckpoints() {
		CheckpointsStorage.reset(this.storage.PATH.CHECKPOINTS);
		this.lastCheckpointInfo = { height: 0, hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
	}
	resetActiveCheckpoint() {
		if (this.activeCheckpointHeight === false) return false;
		fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });
		this.activeCheckpointHeight = false;
		this.activeCheckpointLastSnapshotHeight = false;
		this.activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // fake hash
		return true;
	}
}