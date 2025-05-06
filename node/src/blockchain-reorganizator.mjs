/**
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("./p2p.mjs").P2PNetwork} P2PNetwork
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
 * @typedef {import("./snapshot-system.mjs").SnapshotSystem} SnapshotSystem
 * @typedef {import("./op-stack.mjs").OpStack} OpStack
 * @typedef {import("./block-classes.mjs").BlockData} BlockData
 */

import { MiniLogger } from '../../miniLogger/mini-logger.mjs';

export class Reorganizator {
    /** @type {Object<string, Object<string, BlockData>>} */
    finalizedBlocksCache = {};
    /** @type {Object<string, Object<string, boolean>>} */
    bannedBlockHashesByHeight = {};
    miniLogger = new MiniLogger('reorganizator');
    node;

    /** @param {Node} node */
    constructor(node) { this.node = node }
    
    /** @param {BlockData} finalizedBlock */
    #isFinalizedBlockBanned(finalizedBlock) {
        const index = finalizedBlock.index;
        const hash = finalizedBlock.hash;
        return this.bannedBlockHashesByHeight[index] && this.bannedBlockHashesByHeight[index][hash];
    }
    /** @param {BlockData[]} finalizedBlocks */
    #pruneBranch(finalizedBlocks) {
        for (const block of finalizedBlocks)
            if (this.finalizedBlocksCache[block.index]) delete this.finalizedBlocksCache[block.index][block.hash];
    }
    async #getLegitimateReorg() {
        const legitimateReorg = {
            lastTimestamp: 0,
            lastHeight: 0,
            tasks: []
        };
        // most legitimate chain is the longest chain
        // if two chains have the same length:
        // the most legitimate chain is the one with the lowest mining final difficulty
        // mining final difficulty affected by: posTimestamp
        const snapshotsHeights = this.node.snapshotSystem.mySnapshotsHeights();
        if (snapshotsHeights.length < 2) return legitimateReorg;

        const usableSnapshots = {
            lastBlock: null,
            lastHeight: snapshotsHeights[snapshotsHeights.length - 1],
            preLastBlock: null,
            preLastHeight: snapshotsHeights[snapshotsHeights.length - 2]
        }
        usableSnapshots.lastBlock = this.node.blockchain.getBlock(usableSnapshots.lastHeight);
        usableSnapshots.preLastBlock = this.node.blockchain.getBlock(usableSnapshots.preLastHeight);

        const lastBlock = this.node.blockchain.lastBlock;
        if (!lastBlock) return legitimateReorg;

        legitimateReorg.lastTimestamp = lastBlock.timestamp;
        legitimateReorg.lastHeight = lastBlock.index;

        let index = lastBlock.index;
        while (this.finalizedBlocksCache[index]) {
            const blocks = Object.values(this.finalizedBlocksCache[index]);
            for (const block of blocks) {
                if (block.hash === lastBlock.hash) continue;
                
                const blockTimestamp = block.timestamp;
                const sameIndex = legitimateReorg.lastHeight === block.index;
                if (sameIndex && blockTimestamp > legitimateReorg.lastTimestamp) continue; 

                const tasksToReorg = this.#buildChainReorgTasksFromHighestToLowest(block, usableSnapshots);
                if (!tasksToReorg) continue;

                legitimateReorg.tasks = tasksToReorg;
                legitimateReorg.lastHeight = block.index;
                legitimateReorg.lastTimestamp = block.timestamp;
            }

            index++;
        }

        return legitimateReorg;
    }
    /** @param {BlockData} highestBlock @param {Object} usableSnapshots */
    #buildChainReorgTasksFromHighestToLowest(highestBlock, usableSnapshots) {
        const blocks = [];
        let block = highestBlock;
        while (block.index > usableSnapshots.preLastHeight) {
            if (!block) return false;
            if (this.#isFinalizedBlockBanned(block)) return false;

            blocks.push(block);
            if (this.node.blockchain.lastBlock.hash === block.prevHash) break; // can build the chain with the last block
            if (usableSnapshots.lastBlock.hash === block.prevHash) break; // can build the chain with the last snapshot
            if (usableSnapshots.preLastBlock.hash === block.prevHash) break; // can build the chain with the pre-last snapshot

            const prevBlocks = this.finalizedBlocksCache[block.index - 1];
            if (!prevBlocks || !prevBlocks[block.prevHash]) return false; // missing block
            if (block.index <= usableSnapshots.preLastHeight) break; // stop before setting block
 
            block = prevBlocks[block.prevHash];
        }

        // ensure we can build the chain
        if (!this.node.blockchain.cache.blocksByHash.has(block.prevHash)) {
            //console.info(`[NODE-${this.node.id.slice(0, 6)}] Rejected reorg, missing block: #${block.index - 1} -> prune branch`);
            this.miniLogger.log(`[NODE-${this.node.id.slice(0, 6)}] Rejected reorg, missing block: #${block.index - 1} -> prune branch`, (m) => { console.info(m); });
            this.#pruneBranch(blocks);
            return false;
        }
        
        const tasks = [];
        let broadcastNewCandidate = true; // broadcast candidate for the highest block only
        for (const block_ of blocks) {
            tasks.push({ type: 'digestPowProposal', data: block_, options: { broadcastNewCandidate } });
            broadcastNewCandidate = false;
        }

        if (this.node.blockchain.lastBlock.hash !== block.prevHash) {
            const rollBackTargetHeight = block.index - 1;
            const isUsableLastHeight = usableSnapshots.lastBlock.index === rollBackTargetHeight;
            const isUsablePreLastHeight = usableSnapshots.preLastBlock.index === rollBackTargetHeight;
            if (!isUsableLastHeight && !isUsablePreLastHeight) {
                this.miniLogger.log(`[NODE-${this.node.id.slice(0, 6)}] Rejected reorg, block index #${rollBackTargetHeight} does not match any snapshot`, (m) => { console.info(m); });
                return false;
            }
            // Snapshot can be used to roll back the chain
            tasks.push({ type: 'rollBackTo', data: rollBackTargetHeight });
        }

        return tasks;
    }
    /** @returns {Promise<false | Object[]>} - false if no reorg needed, otherwise return reorg tasks */
    async reorgIfMostLegitimateChain(reason = false) {
        if (!this.node.blockchain.lastBlock) return false;
        const legitimateReorg = await this.#getLegitimateReorg();
        if (legitimateReorg.tasks.length === 0) {
            //console.warn(`[REORGANIZATOR] Reorg: no legitimate branch > ${this.node.blockchain.lastBlock.index}${reason ? ` | ${reason}` : ''}`);
            this.miniLogger.log(`[REORGANIZATOR] Reorg: no legitimate branch > ${this.node.blockchain.lastBlock.index}${reason ? ` | ${reason}` : ''}`, (m) => { console.warn(m); });
            return false;
        }
        
        //legitimateReorg.tasks.push('reorg_end');
        //legitimateReorg.tasks.unshift('reorg_start');
        legitimateReorg.tasks.push({ type: 'reorg_end' });
        legitimateReorg.tasks.unshift({ type: 'reorg_start' });
        //console.warn(`[REORGANIZATOR] ---( Possible Reorg )--- (from #${this.node.blockchain.lastBlock.index}${reason ? ` | ${reason}` : ''})`);
        this.miniLogger.log(`[REORGANIZATOR] ---( Possible Reorg )--- (from #${this.node.blockchain.lastBlock.index}${reason ? ` | ${reason}` : ''})`, (m) => { console.warn(m); });
        return legitimateReorg.tasks;
    }
    /** @param {BlockData} finalizedBlock */
    storeFinalizedBlockInCache(finalizedBlock) {
        const index = finalizedBlock.index;
        const hash = finalizedBlock.hash;
        if (!this.finalizedBlocksCache[index]) this.finalizedBlocksCache[index] = {};
        if (this.finalizedBlocksCache[index][hash]) return;

        this.finalizedBlocksCache[index][hash] = finalizedBlock;
        //console.info(`[REORGANIZATOR] Stored finalized block #${index} | hash: ${hash.slice(0, 10)}...`);
        this.miniLogger.log(`[REORGANIZATOR] Stored finalized block #${index} | hash: ${hash.slice(0, 10)}...`, (m) => { console.info(m); });
    }
    /** @param {BlockData} finalizedBlock */
    isFinalizedBlockInCache(finalizedBlock) {
        const index = finalizedBlock.index;
        const hash = finalizedBlock.hash;
        return this.finalizedBlocksCache[index] && this.finalizedBlocksCache[index][hash];
    }
    /** @param {BlockData} finalizedBlock */
    banFinalizedBlock(finalizedBlock) {
        const index = finalizedBlock.index;
        const hash = finalizedBlock.hash;
        if (!this.bannedBlockHashesByHeight[index]) this.bannedBlockHashesByHeight[index] = {};
        this.bannedBlockHashesByHeight[index][hash] = true;

        //console.info(`[REORGANIZATOR] Banned block #${index} | hash:${hash.slice(0, 10)}...`);
        this.miniLogger.log(`[REORGANIZATOR] Banned block #${index} | hash:${hash.slice(0, 10)}...`, (m) => { console.info(m); });
    }
    pruneCache() {
        const snapshotsHeights = this.node.snapshotSystem.mySnapshotsHeights();
        const preLastSnapshot = snapshotsHeights[snapshotsHeights.length - 2];
        if (preLastSnapshot === undefined) return;

        const eraseUntil = preLastSnapshot -1;
        if (eraseUntil < 0) return;

        for (const height of Object.keys(this.finalizedBlocksCache))
            if (height <= eraseUntil) delete this.finalizedBlocksCache[height];

        for (const height of Object.keys(this.bannedBlockHashesByHeight))
            if (height <= eraseUntil) delete this.bannedBlockHashesByHeight[height];
    }
}