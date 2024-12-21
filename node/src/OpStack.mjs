import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import ReputationManager from "./peers-reputation.mjs";

/**
* @typedef {import("./syncHandler.mjs").SyncHandler} SyncHandler
* @typedef {import("./node.mjs").Node} Node
* @typedef {import("./block-classes.mjs").BlockData} BlockData
*/

// Simple task manager, used to avoid vars overwriting in the callstack
export class OpStack {
    miniLogger = new MiniLogger('OpStack');
    /** @type {Node} */
    node = null;
    /** @type {object[]} */
    tasks = [];
    syncRequested = false;
    isReorging = false;
    terminated = false;
    paused = false;
    executingTask = null;

    // will replace the timeout with a simple loop
    healthInfo = {
        lastDigestTime: null,
        lastSyncTime: null,
        lastReorgCheckTime: null,
        delayBeforeReorgCheck: BLOCKCHAIN_SETTINGS.targetBlockTime,
        delayBeforeSyncCheck: BLOCKCHAIN_SETTINGS.targetBlockTime * 2.5,
        delayBeforeRestart: BLOCKCHAIN_SETTINGS.targetBlockTime * 5
    }

    /** @param {Node} node */
    static buildNewStack(node) {
        const newCallStack = new OpStack();
        newCallStack.node = node;
        newCallStack.#stackLoop();
        newCallStack.#healthCheckLoop();
        return newCallStack;
    }
    async #healthCheckLoop() {
        const delayBetweenChecks = 1000; // 1 second
        while (!this.terminated) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenChecks));
            const now = Date.now();
            
            if (this.healthInfo.lastDigestTime === null && this.healthInfo.lastSyncTime === null) { continue; }
            const lastDigestTime = this.healthInfo.lastDigestTime || 0;
            const lastSyncTime = this.healthInfo.lastSyncTime || 0;
            const lastDigestOrSyncTime = Math.max(lastDigestTime, lastSyncTime);
            const timeSinceLastDigestOrSync = now - lastDigestOrSyncTime;

            if (timeSinceLastDigestOrSync > this.healthInfo.delayBeforeRestart) {
                this.miniLogger.log(`[OpStack] Restart requested by healthCheck, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.warn(m));
                this.node.requestRestart('OpStack.healthCheckLoop() -> delayBeforeRestart reached!');
                this.terminate();
                continue;
            }

            if (!this.syncRequested && timeSinceLastDigestOrSync > this.healthInfo.delayBeforeSyncCheck) {
                this.pushFirst('syncWithPeers', null);
                this.miniLogger.log(`syncWithPeers requested by healthCheck, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.warn(m));
                continue;
            }
            
            const lastReorgCheckTime = this.healthInfo.lastReorgCheckTime;
            const timeSinceLastReorgCheck = lastReorgCheckTime ? now - lastReorgCheckTime : now - lastDigestOrSyncTime;
            
            if (timeSinceLastDigestOrSync < this.healthInfo.delayBeforeReorgCheck) { continue; }
            if (timeSinceLastReorgCheck > this.healthInfo.delayBeforeReorgCheck) {
                this.healthInfo.lastReorgCheckTime = Date.now();
                const reorgTasks = await this.node.reorganizator.reorgIfMostLegitimateChain('healthCheck');
                if (!reorgTasks) { continue; }

                this.securelyPushFirst(reorgTasks);
            }
        }
    }
    terminate() {
        this.terminated = true;
        this.syncRequested = false;
    }
    /** @param {number} delayMS */
    async #stackLoop(delayMS = 10) {
        while (true) {
            if (this.terminated) { break; }

            if (this.tasks.length === 0 || this.paused) {
                await new Promise(resolve => setTimeout(resolve, delayMS));
                if (this.node.miner) { this.node.miner.canProceedMining = true; }
                continue;
            }

            await new Promise(resolve => setImmediate(resolve));

            const task = this.tasks.shift();
            if (!task) { continue; }

            this.executingTask = task;
            await this.#executeTask(task);
        }

        this.miniLogger.log('--------- OpStack terminated ---------', (m) => console.info(m));
    }
    async #executeTask(task) {
        if (!task) { return; }

        try {
            const options = task.options ? task.options : {};
            const content = task.data ? task.data.content ? task.data.content : task.data : undefined;
            const byteLength = task.data ? task.data.byteLength ? task.data.byteLength : undefined : undefined;

            switch (task.type) {
                case 'pushTransaction':
                    try {
                        await this.node.memPool.pushTransaction(content.utxoCache, content.transaction, byteLength); 
                    } catch (error) {
                        if (error.message.includes('Transaction already in mempool')) { break; }
                        if (error.message.includes('Conflicting UTXOs')) { break; }

                        this.miniLogger.log(`[OpStack] Error while pushing transaction:`, (m) => console.error(m));
                        this.miniLogger.log(error, (m) => console.error(m));
                    }
                    break;
                case 'digestPowProposal':
                    if (content.Txs[1].inputs[0] === undefined) { this.miniLogger.log(`[OpStack] Invalid block validator`, (m) => console.error(m)); return; }
                    try {
                        await this.node.digestFinalizedBlock(content, options, byteLength);
                    } catch (error) {
                        this.isReorging = false;
                        await this.#digestPowProposalErrorHandler(error, content, task);
                        return;
                    }
                    
                    // prune the reog cache
                    this.node.reorganizator.pruneCache();

                    // if: isValidatorOfBlock -> return
                    // don't clear timeout. If many blocks are self validated, we are probably in a fork
                    const blockValidatorAddress = content.Txs[1].inputs[0].split(':')[0];
                    const isValidatorOfBlock = this.node.account.address === blockValidatorAddress;
                    if (isValidatorOfBlock) { return; }
                    
                    this.healthInfo.lastDigestTime = Date.now();
                    break;
                case 'syncWithPeers':
                    if (this.node.miner) { this.node.miner.canProceedMining = false; }

                    this.miniLogger.log(`[OPSTACK-${this.node.id.slice(0, 6)}] syncWithPeers started, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.warn(m));
                    const syncSuccessful = await this.node.syncHandler.syncWithPeers();
                    if (!syncSuccessful) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        this.miniLogger.log(`[OPSTACK-${this.node.id.slice(0, 6)}] syncWithPeers failed, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.warn(m));

                        this.terminate();
                        if (!this.node.restartRequested) { this.node.requestRestart('OpStack.syncWithPeers() -> force!'); }
                        this.miniLogger.log(`[OPSTACK-${this.node.id.slice(0, 6)}] Restart requested by syncWithPeers`, (m) => console.warn(m));
                        break;
                    }

                    this.healthInfo.lastSyncTime = Date.now();
                    this.miniLogger.log(`[OPSTACK-${this.node.id.slice(0, 6)}] syncWithPeers finished, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.warn(m));
                    this.syncRequested = false;
                    break;
                case 'createBlockCandidateAndBroadcast':
                    await this.node.createBlockCandidateAndBroadcast();
                    break;
                case 'rollBackTo':
                    await this.node.loadSnapshot(content, false);
                    break;
                case 'reorg_start':
                    this.isReorging = true;
                    break;
                case 'reorg_end':
                    this.isReorging = false;
                    this.healthInfo.lastReorgCheckTime = Date.now();
                    const reorgTasks = await this.node.reorganizator.reorgIfMostLegitimateChain('reorg_end');
                    if (!reorgTasks) {
                        this.miniLogger.log(`[OpStack] Reorg ended, no legitimate branch > ${this.node.blockchain.lastBlock.index}`, (m) => console.info(m));
                        break;
                    }

                    this.miniLogger.log(`[OpStack] Reorg initiated by digestPowProposal, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.info(m));
                    this.securelyPushFirst(reorgTasks);
                    break;
                default:
                    this.miniLogger.log(`[OpStack] Unknown task type: ${task.type}`, (m) => console.error(m));
            }
        } catch (error) { this.miniLogger.log(error, (m) => console.error(m)); }
    }
    // HANDLERS
    /** @param {Error} error @param {BlockData} block @param {object} task */
    async #digestPowProposalErrorHandler(error, block, task) {
        if (error.message.includes('Anchor not found')) {
            this.miniLogger.log(`**CRITICAL ERROR** Validation of the finalized doesn't spot missing anchor!`, (m) => console.error(m)); }
        if (error.message.includes('invalid prevHash')) {
            this.miniLogger.log(`**SOFT FORK** Finalized block prevHash doesn't match the last block hash!`, (m) => console.error(m)); }

        // reorg management
        if (error.message.includes('!store!')) { this.node.reorganizator.storeFinalizedBlockInCache(block); }

        if (error.message.includes('!reorg!')) {
            this.healthInfo.lastReorgCheckTime = Date.now();
            const reorgTasks = await this.node.reorganizator.reorgIfMostLegitimateChain('digestPowProposal: !reorg!');
            if (reorgTasks) {
                this.miniLogger.log(`[OpStack] Reorg initiated by digestPowProposal, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.info(m));
                this.securelyPushFirst(reorgTasks);
            }
        }

        // ban/offenses management
        if (error.message.includes('!banBlock!')) {
            this.miniLogger.log(`[OpStack] Finalized block #${block.index} has been banned, reason: ${error.message}`, (m) => console.warn(m));
            this.node.reorganizator.banFinalizedBlock(block); // avoid using the block in future reorgs
        }
        if (error.message.includes('!applyMinorOffense!')) {
            if (task.data.from === undefined) { return }
            this.node.p2pNetwork.reputationManager.applyOffense(
                {peerId : task.data.from},
                ReputationManager.OFFENSE_TYPES.MINOR_PROTOCOL_VIOLATIONS
            );
        }
        if (error.message.includes('!applyOffense!')) {
            if (task.data.from === undefined) { return }
            this.node.p2pNetwork.reputationManager.applyOffense(
                {peerId : task.data.from},
                ReputationManager.OFFENSE_TYPES.INVALID_BLOCK_SUBMISSION
            );
            return;
        }

        if (   error.message.includes('!store!')
            || error.message.includes('!reorg!') 
            || error.message.includes('!applyOffense!')
            || error.message.includes('!applyMinorOffense!') 
            || error.message.includes('!banBlock!')
            || error.message.includes('!ignore!')) { return; }
        
        this.miniLogger.log(error, (m) => console.error(m));
        if (!error.message.includes('!sync!')) { return; }

        // sync management
        this.pushFirst('syncWithPeers', null);
        this.miniLogger.log(`restartRequested: ${this.node.restartRequested}`, (m) => console.error(m));
    }

    /** @param {string} type @param {object} data */
    push(type, data) {
        if (type === 'syncWithPeers' && this.node.syncHandler.isSyncing) { return; }
        if (type === 'syncWithPeers' && this.syncRequested) { return; }
        if (type === 'syncWithPeers') { this.syncRequested = true; }
        this.tasks.push({ type, data });
    }
    /** @param {string} type @param {object} data */
    pushFirst(type, data) {
        if (type === 'syncWithPeers' && this.node.syncHandler.isSyncing) { return; }
        if (type === 'syncWithPeers' && this.syncRequested) { return; }
        if (type === 'syncWithPeers') { this.syncRequested = true; }
        this.tasks.unshift({ type, data });
    }
    securelyPushFirst(tasks) {
        this.paused = true;
        for (const task of tasks) {
            //this.miniLogger.log(`[OpStack] securelyPushFirst: ${JSON.stringify(task)}`, (m) => console.info(m));
            if (task === 'reorg_start' && this.isReorging) { return; }
            if (task === 'reorg_start') { this.miniLogger.log(`[OpStack] --- reorg_start`, (m) => console.info(m)); }
            if (task.type === 'rollBackTo') { this.miniLogger.log(`[OpStack] --- rollBackTo -> #${task.data}`, (m) => console.info(m)); }
            if (task.type === 'digestPowProposal') { this.miniLogger.log(`[OpStack] --- digestPowProposal -> #${task.data.index}`, (m) => console.info(m)); }
            this.tasks.unshift(task);
        }
        this.paused = false;
    }
}