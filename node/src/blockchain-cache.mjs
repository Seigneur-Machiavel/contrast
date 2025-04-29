import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { MINING_PARAMS } from '../../utils/blockchain-settings.mjs';
import { mining } from '../../utils/mining-functions.mjs';

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

            this.blockHeightByHash.delete(blockHash);
            this.blocksByHash.delete(blockHash);
            this.blocksHashByHeight.delete(i);
            erasedUntil = i;
        }

        this.miniLogger.log(`Cache erased from ${fromHeight} to ${erasedUntil}`, (m) => { console.debug(m); });
        return { from: fromHeight, to: erasedUntil };
    }
    getAverageBlocksDifficultyAndTimeGap() {
        const blocks = [...this.blocksByHash.values()];
        if (blocks.length === 0) return null;

        const timeGaps = [];
        const diffs = [];
        const diffsWithLegitimacy = [];
        const finalDiffs = [];
        for (const block of blocks) {
            timeGaps.push(block.timestamp - block.posTimestamp);
            diffs.push(block.difficulty);
            const legAdj = block.legitimacy * MINING_PARAMS.diffAdjustPerLegitimacy;
            diffsWithLegitimacy.push(Math.max(block.difficulty + legAdj, 1)); // cap at 1 minimum
            
            //const differenceRatio = (block.timestamp - block.posTimestamp) / BLOCKCHAIN_SETTINGS.targetBlockTime;
            //const timeDiffAdjustment = MINING_PARAMS.maxTimeDifferenceAdjustment - Math.round(differenceRatio * MINING_PARAMS.maxTimeDifferenceAdjustment);
            //finalDiffs.push(Math.max(baseDifficulty + timeDiffAdjustment + legAdj, 1)); // cap at 1 minimum
            finalDiffs.push(mining.getBlockFinalDifficulty(block).finalDifficulty);
        }

        const avgTG = timeGaps.reduce((a, b) => a + b, 0) / timeGaps.length;
        const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const avgDWL = diffsWithLegitimacy.reduce((a, b) => a + b, 0) / diffsWithLegitimacy.length;
        const avgFD = finalDiffs.reduce((a, b) => a + b, 0) / finalDiffs.length;
        return { avgTG, avgDiff, avgDWL, avgFD };
    }
}