/**
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("./p2p.mjs").P2PNetwork} P2PNetwork
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
 * @typedef {import("./snapshot-system.mjs").SnapshotSystem} SnapshotSystem
 * @typedef {import("./op-stack.mjs").OpStack} OpStack
 * @typedef {import("./block-classes.mjs").BlockData} BlockData
 */

export class Reorganizator {
    /** @param {Node} node */
    constructor(node) {
        this.node = node;
        
        /** @type {Object<string, Object<string, BlockData>>} */
        this.finalizedBlocksCache = {};
        /** @type {Object<string, Object<string, boolean>>} */
        this.bannedBlockHashesByHeight = {};
    }
    /** @param {BlockData} finalizedBlock */
    #isFinalizedBlockBanned(finalizedBlock) {
        const index = finalizedBlock.index;
        const hash = finalizedBlock.hash;
        return this.bannedBlockHashesByHeight[index] && this.bannedBlockHashesByHeight[index][hash];
    }
    /** @param {BlockData[]} finalizedBlocks */
    #pruneBranch(finalizedBlocks) {
        for (const block of finalizedBlocks) {
            const index = block.index;
            if (!this.finalizedBlocksCache[index]) { continue; }
            delete this.finalizedBlocksCache[index][block.hash];
        }
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
        const snapshotsHeights = this.node.snapshotSystem.getSnapshotsHeights();
        if (snapshotsHeights.length < 2) { return legitimateReorg; }

        const usableSnapshots = {
            lastBlock: null,
            lastHeight: snapshotsHeights[snapshotsHeights.length - 1],
            preLastBlock: null,
            preLastHeight: snapshotsHeights[snapshotsHeights.length - 2]
        }
        usableSnapshots.lastBlock = await this.node.blockchain.getBlockByHeight(usableSnapshots.lastHeight);
        usableSnapshots.preLastBlock = await this.node.blockchain.getBlockByHeight(usableSnapshots.preLastHeight);

        const lastBlock = this.node.blockchain.lastBlock;
        if (!lastBlock) { return legitimateReorg; }

        legitimateReorg.lastTimestamp = lastBlock.timestamp;
        legitimateReorg.lastHeight = lastBlock.index;

        let index = lastBlock.index;
        while (this.finalizedBlocksCache[index]) {
            const blocks = Object.values(this.finalizedBlocksCache[index]);
            for (const block of blocks) {
                if (block.hash === lastBlock.hash) { continue; }
                
                const blockTimestamp = block.timestamp;
                const sameIndex = legitimateReorg.lastHeight === block.index;
                if (sameIndex && blockTimestamp > legitimateReorg.lastTimestamp) { continue; }

                const tasksToReorg = this.#buildChainReorgTasksFromHighestToLowest(block, usableSnapshots);
                if (!tasksToReorg) { continue; }

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
        /*usableSnapshots = {
            lastBlock: null,
            lastHeight: snapshotsHeights[snapshotsHeights.length - 1],
            preLastBlock: null,
            preLastHeight: snapshotsHeights[snapshotsHeights.length - 2]
        }*/

        const blocks = [];
        let block = highestBlock;
        while (block.index > usableSnapshots.preLastHeight) {
            if (!block) { return false; }
            if (this.#isFinalizedBlockBanned(block)) { return false; }

            blocks.push(block);
            if (this.node.blockchain.lastBlock.hash === block.prevHash) {
                break; // can build the chain with the last block
            }
            if (usableSnapshots.lastBlock.hash === block.prevHash) {
                break; // can build the chain with the last snapshot
            }
            if (usableSnapshots.preLastBlock.hash === block.prevHash) {
                break; // can build the chain with the pre-last snapshot
            }

            const prevBlocks = this.finalizedBlocksCache[block.index - 1];
            if (!prevBlocks || !prevBlocks[block.prevHash]) {
                return false; } // missing block

            block = prevBlocks[block.prevHash];
        }

        // ensure we can build the chain
        if (!this.node.blockchain.cache.blocksByHash.has(block.prevHash)) {
            console.info(`[NODE-${this.node.id.slice(0, 6)}] Rejected reorg, missing block: #${block.index - 1} -> prune branch`);
            this.#pruneBranch(blocks);
            return false;
        }
        
        const tasks = [];
        let broadcastNewCandidate = true; // broadcast candidate for the highest block only
        for (const block_ of blocks) {
            const options = { broadcastNewCandidate };
            tasks.push({ type: 'digestPowProposal', data: block_, options });
            broadcastNewCandidate = false;
        }

        if (this.node.blockchain.lastBlock.hash === block.prevHash) { return tasks; }

        tasks.push({ type: 'rollBackTo', data: block.index - 1 });
        return tasks;
    }
    /** @returns {Promise<boolean | Object[]>} - false if no reorg needed, otherwise return reorg tasks */
    async reorgIfMostLegitimateChain(reason = false) {
        if (!this.node.blockchain.lastBlock) { return false; }
        const legitimateReorg = await this.#getLegitimateReorg();
        if (legitimateReorg.tasks.length === 0) {
            console.warn(`[REORGANIZATOR] Reorg: no legitimate branch > ${this.node.blockchain.lastBlock.index}`);
            return false;
        }
        
        legitimateReorg.tasks.push('reorg_end');
        legitimateReorg.tasks.unshift('reorg_start');
        console.warn(`[REORGANIZATOR] ---( Possible Reorg )--- (from #${this.node.blockchain.lastBlock.index} ${reason ? `| ${reason}` : ''})`);
        return legitimateReorg.tasks;
    }
    /** @param {BlockData} finalizedBlock */
    storeFinalizedBlockInCache(finalizedBlock) {
        const index = finalizedBlock.index;
        const hash = finalizedBlock.hash;
        if (!this.finalizedBlocksCache[index]) { this.finalizedBlocksCache[index] = {}; }
        if (this.finalizedBlocksCache[index][hash]) { return; }

        this.finalizedBlocksCache[index][hash] = finalizedBlock;
        console.info(`[REORGANIZATOR] Stored finalized block #${index} | hash: ${hash.slice(0, 10)}...`);
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
        if (!this.bannedBlockHashesByHeight[index]) { this.bannedBlockHashesByHeight[index] = {}; }
        this.bannedBlockHashesByHeight[index][hash] = true;

        console.info(`[REORGANIZATOR] Banned block #${index} | hash:${hash.slice(0, 10)}...`);
    }
    pruneCache() {
        const snapshotsHeights = this.node.snapshotSystem.getSnapshotsHeights();
        const preLastSnapshot = snapshotsHeights[snapshotsHeights.length - 2];
        if (preLastSnapshot === undefined) { return; }

        const eraseUntil = preLastSnapshot -1;
        if (eraseUntil < 0) { return; }

        const blocksHeight = Object.keys(this.finalizedBlocksCache);
        for (const height of blocksHeight) {
            if (height > eraseUntil) { continue; }
            delete this.finalizedBlocksCache[height];
        }

        const bannedHeights = Object.keys(this.bannedBlockHashesByHeight);
        for (const height of bannedHeights) {
            if (height > eraseUntil) { continue; }
            delete this.bannedBlockHashesByHeight[height];
        }
    }
}