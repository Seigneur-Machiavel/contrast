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
        const delayBetweenChecks = 10_000; // 10 second
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
                this.node.restartRequested = 'OpStack.healthCheckLoop() -> delayBeforeRestart reached!';
                this.terminate();
                break;
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
    async #stackLoop(delayMS = 50) {
        while (true) {
            if (this.terminated) { break; }

            if (this.tasks.length === 0 || this.paused) {
                await new Promise(resolve => setTimeout(resolve, delayMS));
                if (this.node.miner) { this.node.miner.canProceedMining = true; }
                continue;
            }

            await new Promise(resolve => setImmediate(resolve));

            let task = this.tasks.shift();
            if (!task) { continue; }

            const nextTaskIsPushTransaction = this.tasks[0] && this.tasks[0].type === 'pushTransaction';
            if (!nextTaskIsPushTransaction) {
                this.executingTask = task;
                await this.#executeTask(task);
                continue;
            }

            // Upgrade successive pushTransaction tasks to a single pushTransactions
            const upgradedTask = { type: 'pushTransactions', data: [] };
            while (task.type === 'pushTransaction') {
                upgradedTask.data.push(task.data);
                task = this.tasks.shift();
                if (!task) { break; }
                if (task.type !== 'pushTransaction') { this.tasks.unshift(task); break; }
            }

            this.executingTask = upgradedTask;
            await this.#executeTask(upgradedTask);
        }

        this.miniLogger.log('--------- OpStack terminated ---------', (m) => console.info(m));
    }
    async #executeTask(task) {
        try {
            const options = task.options ? task.options : {};
            const content = task.data ? task.data.content ? task.data.content : task.data : undefined;
            const byteLength = task.data ? task.data.byteLength ? task.data.byteLength : undefined : undefined;

            switch (task.type) {
                case 'pushTransaction':
                    try {
                        await this.node.memPool.pushTransaction(this.node.utxoCache, content);
                    } catch (error) {
                        if (error.message.includes('Transaction already in mempool')) { break; }
                        if (error.message.includes('Conflicting UTXOs')) { break; }
                        if (error.message.includes('UTXO not found in involvedUTXOs')) {
                            this.miniLogger.log(`${content.id} -> rejecting transaction`, (m) => console.error(m));
                            break;
                        }

                        this.miniLogger.log(`[OpStack] Error while pushing transaction:`, (m) => console.error(m));
                        this.miniLogger.log(error, (m) => console.error(m));
                    }
                    break;
                case 'pushTransactions':
                    const { success, failed } = await this.node.memPool.pushTransactions(this.node.utxoCache, content);
                    this.miniLogger.log(`[OpStack] pushTransactions: ${success.length} success, ${failed.length} failure`, (m) => console.info(m));
                    break;
                case 'digestPowProposal':
                    if (content.Txs[1].inputs[0] === undefined) { this.miniLogger.log(`[OpStack] Invalid block validator`, (m) => console.error(m)); return; }
                    let result;
                    try {
                        result = await this.node.digestFinalizedBlock(content, options, byteLength);
                    } catch (error) {
                        this.isReorging = false;
                        this.node.blockchainStats.state = 'idle';
                        await this.#digestPowProposalErrorHandler(error, content, task);
                        return;
                    }
                    
                    this.node.reorganizator.pruneCache();

                    if (typeof result === 'number') { this.pushFirst('createBlockCandidateAndBroadcast', result); }

                    // If many blocks are self validated, we are probably in a fork
                    const blockValidatorAddress = content.Txs[1].inputs[0].split(':')[0];
                    if (this.node.account.address === blockValidatorAddress) { return; }
                    
                    this.healthInfo.lastDigestTime = Date.now();
                    break;
                case 'syncWithPeers':
                    if (this.node.miner) { this.node.miner.canProceedMining = false; }

                    this.node.syncHandler.isSyncing = true;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    this.miniLogger.log(`[OPSTACK-${this.node.id.slice(0, 6)}] syncing with Peers at #${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.warn(m));
                    const syncResult = await this.node.syncHandler.syncWithPeers();
                    this.node.syncHandler.isSyncing = false;
                    this.syncRequested = false;
                    this.miniLogger.log(`[OPSTACK-${this.node.id.slice(0, 6)}] syncWithPeers result: ${syncResult}, consensus: #${this.node.syncHandler.consensusHeight} | myHeight: #${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.warn(m));
                    
                    switch (syncResult) {
                        case 'Already at the consensus height':
                            this.node.syncAndReady = true;
                            this.node.syncHandler.syncFailureCount = 0;
                            this.miniLogger.log(`[OPSTACK-${this.node.id.slice(0, 6)}] syncWithPeers finished at #${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.warn(m));
                            this.healthInfo.lastSyncTime = Date.now();
                            this.pushFirst('createBlockCandidateAndBroadcast', 0);
                            break;
                        case 'Checkpoint downloaded':
                            this.pushFirst('syncWithPeers', null);
                            break;
                        case 'PubKeysAddresses downloaded':
                            this.pushFirst('syncWithPeers', null);
                            break;
                        case 'Verifying consensus':
                            this.pushFirst('syncWithPeers', null);
                            break;
                        case 'Checkpoint deployed':
                            this.miniLogger.log(`[OPSTACK-${this.node.id.slice(0, 6)}] Checkpoint deployed, restarting node...`, (m) => console.warn(m));
                            this.node.restartRequested = 'Checkpoint deployed';
                            this.terminate();
                            break;
                        default:
                            this.healthInfo.lastReorgCheckTime = Date.now();
                            const reorgTasks = await this.node.reorganizator.reorgIfMostLegitimateChain('syncWithPeers failed');
                            if (reorgTasks) { this.securelyPushFirst(reorgTasks); } else { this.pushFirst('syncWithPeers', null); }
                    }

                    break;
                case 'createBlockCandidateAndBroadcast':
                    this.node.createBlockCandidateAndBroadcast(content || 0); // content = delay(ms)
                    // RE CREATE AND BROADCAST(if owner of best candidate) AFTER HALF BLOCK_TIME FOR MORE CONSISTENCY
                    this.node.createBlockCandidateAndBroadcast((content || 0) + BLOCKCHAIN_SETTINGS.targetBlockTime / 2);
                    break;
                case 'rollBackTo':
                    this.miniLogger.log(`[OpStack] Rollback to #${content}`, (m) => console.info(m));
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
                        this.pushFirst('createBlockCandidateAndBroadcast', 0);
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
            if (reorgTasks) { this.securelyPushFirst(reorgTasks); }
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
        
        const ignoreList = ['!store!', '!reorg!', '!applyOffense!', '!applyMinorOffense!', '!banBlock!', '!ignore!'];
        if (ignoreList.some((v) => error.message.includes(v))) { return; }
        
        this.miniLogger.log(error, (m) => console.error(m));
    }

    /** @param {string} type @param {object} data */
    push(type, data) {
        if (type === 'syncWithPeers') {
            if (this.node.syncHandler.isSyncing) { return; }
            if (this.syncRequested) { return; }
            this.syncRequested = true;
        }

        this.tasks.push({ type, data });
    }
    /** @param {string} type @param {object} data */
    pushFirst(type, data) {
        if (type === 'syncWithPeers') {
            if (this.node.syncHandler.isSyncing) { return; }
            if (this.syncRequested) { return; }
            this.syncRequested = true;
        }

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