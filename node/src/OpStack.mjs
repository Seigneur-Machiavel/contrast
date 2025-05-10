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

    /** @param {Node} node */
    constructor(node) { this.node = node }

    /** Will try sync with peers every 3-10 minutes */
    async #rndSyncCheck(minDelay = 180_000, maxDelay = 600_000) {
        while(!this.terminated) {
            const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
            await new Promise(resolve => setTimeout(resolve, delay));
            if (this.terminated) break;
            if (this.executingTask && this.executingTask.type === 'syncWithPeers') continue;
            if (this.tasks[0] && this.tasks[0].type === 'syncWithPeers') continue;
            this.pushFirst('syncWithPeers', null);
        }
    }
    terminate() {
        this.terminated = true;
        this.syncRequested = false;
    }
    /** @param {number} delayMS */
    async startStackLoop(delayMS = 50) {
        this.#rndSyncCheck();
        while (true) {
            if (this.terminated) break;
            if (this.tasks.length === 0 || this.paused) {
                await new Promise(resolve => setTimeout(resolve, delayMS));
                if (this.node.miner) this.node.miner.canProceedMining = true;
                continue;
            }

            await new Promise(resolve => setImmediate(resolve));

            let task = this.tasks.shift();
            if (!task) continue;

            const nextTaskIsPushTransaction = this.tasks[0] && this.tasks[0].type === 'pushTransaction';
            if (!nextTaskIsPushTransaction) { await this.#executeTask(task); continue; }

            // Upgrade successive pushTransaction tasks to a single pushTransactions
            const upgradedTask = { type: 'pushTransactions', data: [] };
            while (task.type === 'pushTransaction') {
                upgradedTask.data.push(task.data);
                task = this.tasks.shift();
                if (!task) break;
                if (task.type !== 'pushTransaction') { this.tasks.unshift(task); break; }
            }

            await this.#executeTask(upgradedTask);
        }

        this.miniLogger.log('--------- OpStack terminated ---------', (m) => console.info(m));
    }
    async #executeTask(task = { type: 'toto', data: {} }) {
        this.executingTask = task;

        try {
            const options = task.options ? task.options : {};
            const content = task.data ? task.data.content ? task.data.content : task.data : undefined;
            const byteLength = task.data ? task.data.byteLength ? task.data.byteLength : undefined : undefined;

            switch (task.type) {
                case 'reBuildAddrsTxsRefs':
                    const elapsedTime = await this.node.reBuildAddrsTxsRefs(content);
                    if (elapsedTime > 20_000) this.pushFirst('syncWithPeers', null); // if it took too long, sync with peers
                    break;
                case 'pushTransaction':
                    try { await this.node.memPool.pushTransaction(this.node.utxoCache, content) }
                    catch (error) {
                        if (error.message.includes('Transaction already in mempool')) break;
                        if (error.message.includes('Conflicting UTXOs')) break;
                        if (error.message.includes('UTXO not found in involvedUTXOs')) break;

                        this.miniLogger.log(`[OpStack] Error while pushing transaction:`, (m) => console.error(m));
                        this.miniLogger.log(error, (m) => console.error(m));
                    }
                    break;
                case 'pushTransactions':
                    const { success, failed } = await this.node.memPool.pushTransactions(this.node.utxoCache, content);
                    this.miniLogger.log(`[OpStack] pushTransactions: ${success.length} success, ${failed.length} failure`, (m) => console.info(m));
                    break;
                case 'digestPowProposal':
                    if (content.Txs[1].inputs[0] === undefined) // validator sign check, avoid malicious spam
                        { this.miniLogger.log(`[OpStack] Invalid block validator`, (m) => console.error(m)); return; }
                    
                    try {
                        const digestResult = await this.node.digestFinalizedBlock(content, options, byteLength)
                        this.node.reorganizator.pruneCache();
                        if (typeof digestResult === 'number') this.pushFirst('createBlockCandidateAndBroadcast', digestResult);
                    } catch (error) { await this.#digestPowProposalErrorHandler(error, content, task) }
                    
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
                            const reorgTasks = await this.node.reorganizator.reorgIfMostLegitimateChain('syncWithPeers failed');
                            if (reorgTasks) this.securelyPushFirst(reorgTasks);
                            else this.pushFirst('syncWithPeers', null);
                    }
                    break;
                case 'createBlockCandidateAndBroadcast':
                    this.node.createBlockCandidateAndBroadcast(content || 0); // content = delay(ms)
                    // RE CREATE AND BROADCAST(if owner of best candidate) AFTER HALF BLOCK_TIME FOR MORE CONSISTENCY
                    this.node.createBlockCandidateAndBroadcast((content || 0) + BLOCKCHAIN_SETTINGS.targetBlockTime / 2);
                    break;
                case 'startMiner':
                    this.node.miner.startWithWorker();
                    this.miniLogger.log(`[OpStack] Miner started`, (m) => console.info(m));
                    break;
                case 'rollBackTo':
                    this.miniLogger.log(`[OpStack] Rollback to #${content}`, (m) => console.info(m));
                    await this.node.loadSnapshot(content, false);
                    break;
                case 'reorg_start':
                    this.isReorging = true;
                    this.miniLogger.log(`[OpStack] Reorg started`, (m) => console.info(m));
                    break;
                case 'reorg_end':
                    this.isReorging = false;
                    const reorgTasks = await this.node.reorganizator.reorgIfMostLegitimateChain('reorg_end');
                    if (reorgTasks) this.miniLogger.log(`[OpStack] Reorg initiated by digestPowProposal, lastBlockData.index: ${this.node.blockchain.lastBlock === null ? 0 : this.node.blockchain.lastBlock.index}`, (m) => console.info(m));
                    else this.miniLogger.log(`[OpStack] Reorg ended, no legitimate branch > ${this.node.blockchain.lastBlock.index}`, (m) => console.info(m));
                    
                    if (reorgTasks) this.securelyPushFirst(reorgTasks);
                    else this.pushFirst('createBlockCandidateAndBroadcast', 0);

                    break;
                default:
                    this.miniLogger.log(`[OpStack] Unknown task type: ${task.type}`, (m) => console.error(m));
            }
        } catch (error) { this.miniLogger.log(error.stack, (m) => console.error(m)); }
    }
    /** @param {Error} error @param {BlockData} block @param {object} task */
    async #digestPowProposalErrorHandler(error, block, task) {
        this.node.blockchainStats.state = 'idle';
        if (error.message.includes('Anchor not found'))
            this.miniLogger.log(`**CRITICAL ERROR** Validation of the finalized doesn't spot missing anchor!`, (m) => console.error(m));
        if (error.message.includes('invalid prevHash type!'))
            this.miniLogger.log(`**SOFT FORK** Finalized block prevHash isn't a valid string!`, (m) => console.error(m));
        if (error.message.includes('Invalid lastBlockHash type!'))
            this.miniLogger.log(`**SOFT FORK** Finalized block lastBlockHash isn't a valid string!`, (m) => console.error(m));

        // ban/offenses management
        if (error.message.includes('!banBlock!'))
            this.node.reorganizator.banFinalizedBlock(block); // avoid using the block in future reorgs
        
        if (error.message.includes('!applyMinorOffense!'))
            if (task.data.from !== undefined)
                this.node.p2pNetwork.reputationManager.applyOffense({peerId : task.data.from},ReputationManager.OFFENSE_TYPES.MINOR_PROTOCOL_VIOLATIONS);
        
        if (error.message.includes('!applyOffense!'))
            if (task.data.from !== undefined)
                this.node.p2pNetwork.reputationManager.applyOffense({peerId : task.data.from}, ReputationManager.OFFENSE_TYPES.INVALID_BLOCK_SUBMISSION);

        // reorg management
        if (error.message.includes('!store!')) this.node.reorganizator.storeFinalizedBlockInCache(block);
        if (error.message.includes('!reorg!') && !this.isReorging) {
            const reorgTasks = await this.node.reorganizator.reorgIfMostLegitimateChain('digestPowProposal: !reorg!');
            if (reorgTasks) this.securelyPushFirst(reorgTasks);
        }

        const ignoreList = ['!store!', '!reorg!', '!applyOffense!', '!applyMinorOffense!', '!banBlock!', '!ignore!'];
        if (ignoreList.some((v) => error.message.includes(v))) return;
        
        this.miniLogger.log(error, (m) => console.error(m));
    }

    push(type = 'toto', data) {
        if (type === 'syncWithPeers')
            if (this.node.syncHandler.isSyncing || this.syncRequested) return;
            else this.syncRequested = true;

        this.tasks.push({ type, data });
    }
    pushFirst(type = 'toto', data) {
        if (type === 'syncWithPeers')
            if (this.node.syncHandler.isSyncing || this.syncRequested) return;
            else this.syncRequested = true;

        this.tasks.unshift({ type, data });
    }
    securelyPushFirst(tasks) {
        this.paused = true;
        for (const task of tasks) if (task.type === 'reorg_start' && this.isReorging) return; // avoid double reorg
        for (const task of tasks) this.tasks.unshift(task);
        this.paused = false;
    }
}