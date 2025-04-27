import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { MINING_PARAMS } from '../../utils/blockchain-settings.mjs';

/**
* @typedef {import("./block-classes.mjs").BlockData} BlockData
*/

export class BlocksCache {
    /** @type {Map<string, BlockData>} */
    blocksByHash = new Map();
    /** @type {Map<number, string>} */
    blocksHashByHeight = new Map();
    /** @type {Map<string, number>} */
    blockHeightByHash = new Map();

    /** @param {MiniLogger} miniLogger */
    constructor(miniLogger) {
        /** @type {MiniLogger} */
        this.miniLogger = miniLogger;
    }

    oldestBlockHeight() {
        if (this.blocksHashByHeight.size === 0) return -1;
        return Math.min(...this.blocksHashByHeight.keys());
    }
    /** @param {BlockData} block */
    addBlock(block) {
        this.blocksByHash.set(block.hash, block);
        this.blocksHashByHeight.set(block.index, block.hash);
        this.blockHeightByHash.set(block.hash, block.index);
    }
    getAllBlocksTimestamps() {
        /** @type {Object<number, number>} */
        const blocksTimestamps = {};
        for (const block of this.blocksHashByHeight.values()) {
            const blockData = this.blocksByHash.get(block);
            if (!blockData) continue;
            //blocksTimestamps.push(blockData.timestamp);
            blocksTimestamps[blockData.index] = blockData.timestamp;
        }
        return blocksTimestamps;
    }
    /** @param {number} index @param {string} hash */
    #deleteBlock(index, hash) {
        this.blocksHashByHeight.delete(index);
        this.blockHeightByHash.delete(hash);
        this.blocksByHash.delete(hash);
    }
    /** returns the height of erasable blocks without erasing them. @param {number} height */
    erasableLowerThan(height = 0) {
        let erasableUntil = null;
        const oldestHeight = this.oldestBlockHeight();
        if (oldestHeight >= height) return null;

        for (let i = oldestHeight; i < height; i++) {
            const blockHash = this.blocksHashByHeight.get(i);
            if (!blockHash) continue;
            erasableUntil = i;
        }

        this.miniLogger.log(`Cache erasable from ${oldestHeight} to ${erasableUntil}`, (m) => { console.debug(m); });
        return { from: oldestHeight, to: erasableUntil };
    }
    /** Erases the cache from the oldest block to the specified height(included). */
    eraseFromTo(fromHeight = 0, toHeight = 100) {
        if (fromHeight > toHeight) return;

        let erasedUntil = null;
        for (let i = fromHeight; i <= toHeight; i++) {
            const blockHash = this.blocksHashByHeight.get(i);
            if (!blockHash) continue;

            this.#deleteBlock(i, blockHash);
            erasedUntil = i;
        }

        this.miniLogger.log(`Cache erased from ${fromHeight} to ${erasedUntil}`, (m) => { console.debug(m); });
        return { from: fromHeight, to: erasedUntil };
    }
    getAverageBlocksFinalDifficulty() {
        const blocks = [...this.blocksByHash.values()];
        if (blocks.length === 0) return null;

        const finalDiffs = [];
        for (const block of blocks) {
            const adj = block.legitimacy * MINING_PARAMS.diffAdjustPerLegitimacy;
            finalDiffs.push(block.difficulty + adj);
        }

        const average = finalDiffs.reduce((a, b) => a + b, 0) / finalDiffs.length;
        return average;
    }
}