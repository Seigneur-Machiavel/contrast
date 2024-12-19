import utils from './utils.mjs';
/**
* @typedef {import("./syncHandler.mjs").SyncHandler} SyncHandler
* @typedef {import("./node.mjs").Node} Node
* @typedef {import("./block-classes.mjs").BlockData} BlockData
*/

import ReputationManager from "./peers-reputation.mjs";

// Simple task manager, used to avoid vars overwriting in the callstack
export class OpStack {
    /** @type {Node} */
    node = null;
    /** @type {object[]} */
    tasks = [];
    syncRequested = false;
    isReorging = false;
    terminated = false;
    paused = false;
    txBatchSize = 10; // will treat transactions in batches of 10
    lastExecutedTask = null;

    // will replace the timeout with a simple loop
    healthInfo = {
        lastDigestTime: null,
        lastSyncTime: null,
        lastReorgCheckTime: null,
        delayBeforeReorgCheck: utils.SETTINGS.targetBlockTime,
        delayBeforeSyncCheck: utils.SETTINGS.targetBlockTime * 2.5,
        delayBeforeRestart: utils.SETTINGS.targetBlockTime * 5
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
                console.warn(`[OpStack] Restart requested by healthCheck, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`);
                this.node.requestRestart('OpStack.healthCheckLoop() -> delayBeforeRestart reached!');
                this.terminate();
                continue;
            }

            if (!this.syncRequested && timeSinceLastDigestOrSync > this.healthInfo.delayBeforeSyncCheck) {
                this.pushFirst('syncWithPeers', null);
                console.warn(`[OpStack] syncWithPeers requested by healthCheck, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`);
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

            // keep it simple!
            const task = this.tasks.shift();
            if (!task) { continue; }

            this.lastExecutedTask = task;
            await this.#executeTask(task);

            /*for (let i = 0; i < this.txBatchSize; i++) {
                const task = this.tasks.shift();
                if (!task) { break; }
                
                this.lastExecutedTask = task;
                await this.#executeTask(task);

                if (task.type !== 'pushTransaction') { break; }
            }*/
        }
        console.info('------------------');
        console.info('OpStack terminated');
        console.info('------------------');
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
                        console.error(error.message); 
                    }
                    break;
                case 'digestPowProposal':
                    if (content.Txs[0].inputs[0] === undefined) { console.error('Invalid coinbase nonce'); return; }
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

                    console.warn(`[OPSTACK-${this.node.id.slice(0, 6)}] syncWithPeers started, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`);
                    const syncSuccessful = await this.node.syncHandler.syncWithPeers();
                    if (!syncSuccessful) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        console.warn(`[OPSTACK-${this.node.id.slice(0, 6)}] syncWithPeers failed, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`);
                        this.terminate();
                        if (!this.node.restartRequested) { this.node.requestRestart('OpStack.syncWithPeers() -> force!'); }
                        console.log(`restartRequested: ${this.node.restartRequested}`);
                        break;
                    }

                    this.healthInfo.lastSyncTime = Date.now();
                    console.warn(`[OPSTACK-${this.node.id.slice(0, 6)}] syncWithPeers finished, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`);
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
                        console.info(`[OpStack] Reorg ended, no legitimate branch > ${this.node.blockchain.lastBlock.index}`);
                        break;
                    }

                    console.info(`[OpStack] Reorg initiated by digestPowProposal, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`);
                    this.securelyPushFirst(reorgTasks);
                    break;
                default:
                    console.error(`[OpStack] Unknown task type: ${task.type}`);
            }
        } catch (error) { console.error(error.stack); }
    }
    // HANDLERS
    /** @param {Error} error @param {BlockData} block @param {object} task */
    async #digestPowProposalErrorHandler(error, block, task) {
        if (error.message.includes('Anchor not found')) {
            console.error(`\n#${block.index} **CRITICAL ERROR** Validation of the finalized doesn't spot missing anchor! `); }
        if (error.message.includes('invalid prevHash')) {
            console.error(`\n#${block.index} **SOFT FORK** Finalized block prevHash doesn't match the last block hash! `); }

        // reorg management
        if (error.message.includes('!store!')) {
            this.node.reorganizator.storeFinalizedBlockInCache(block);
        }
        if (error.message.includes('!reorg!')) {
            this.healthInfo.lastReorgCheckTime = Date.now();
            const reorgTasks = await this.node.reorganizator.reorgIfMostLegitimateChain('digestPowProposal: !reorg!');
            if (reorgTasks) {
                console.info(`[OpStack] Reorg initiated by digestPowProposal, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`);
                this.securelyPushFirst(reorgTasks);
            }
        }

        if (error.message.includes('!banBlock!')) {
            console.info(`[OpStack] Finalized block #${block.index} has been banned, reason: ${error.message}`);
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
        
        // sync management
        if (error.message.includes('!sync!')) {
            console.error(error.stack);
            this.pushFirst('syncWithPeers', null);
            console.log(`restartRequested: ${this.node.restartRequested}`);
            return;
        }

        console.error(error.stack);
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
            //console.info(`[OpStack] securelyPushFirst: ${JSON.stringify(task)}`);
            if (task === 'reorg_start' && this.isReorging) { return; }
            if (task === 'reorg_start') { console.info('[OpStack] --- reorg_start'); }
            if (task.type === 'rollBackTo') { console.info(`[OpStack] --- rollBackTo -> #${task.data}`); }
            if (task.type === 'digestPowProposal') { console.info(`[OpStack] --- digestPowProposal -> #${task.data.index}`); }
            this.tasks.unshift(task);
        }
        this.paused = false;
    }
}