import { Storage } from '../../utils/storage-manager.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';
import { BlockValidation } from './validations-classes.mjs';
import { OpStack } from './OpStack.mjs';
import { Vss } from './vss.mjs';
import { MemPool } from './memPool.mjs';
import { UtxoCache } from './utxoCache.mjs';
import { BlockData, BlockUtils } from './block-classes.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { Miner } from './miner.mjs';
import P2PNetwork from './p2p.mjs';
import { typeValidation } from '../../utils/type-validation.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { Blockchain } from './blockchain.mjs';
import { SyncHandler } from './sync-handler.mjs';
import { SnapshotSystem } from './snapshot-system.mjs';
import { performance, PerformanceObserver } from 'perf_hooks';
import { ValidationWorker } from '../workers/workers-classes.mjs';
import { TimeSynchronizer } from '../../utils/time.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { Reorganizator } from './blockchain-reorganizator.mjs';

/**
* @typedef {import("./wallet.mjs").Account} Account
* @typedef {import("./transaction.mjs").Transaction} Transaction
* @typedef {import("./websocketCallback.mjs").WebSocketCallBack} WebSocketCallBack
* @typedef {import("./block-classes.mjs").BlockHeader} BlockHeader
* @typedef {import("./block-classes.mjs").BlockInfo} BlockInfo
*/

export class Node {
    syncAndReady = false;
    restartRequested = false;
    id;
    account;
    roles;
    listenAddress;
    version;
    validatorRewardAddress;
    useDevArgon2 = false;
    /** @type {BlockData} */
    blockCandidate = null;
    miniLogger = new MiniLogger('node');
    timeSynchronizer = new TimeSynchronizer();
    snapshotSystem = new SnapshotSystem();
    blockchain;
    reorganizator;
    utxoCache;

    /** @type {ValidationWorker[]} */
    workers = [];
    nbOfWorkers = 4;
    bootstrapNodes = [
        '/dns4/pinkparrot.science/tcp/27260',
        '/dns4/pinkparrot.observer/tcp/27261',
        '/dns4/contrast.observer/tcp/27260',
        '/dns4/pariah.monster/tcp/27260'
    ];
    memPool = new MemPool();
    /** @type {OpStack} */
    opStack;
    /** @type {SyncHandler} */
    syncHandler;
    /** @type {Object<string, WebSocketCallBack>} */
    wsCallbacks = {};
    /** @type {Miner} */
    miner;
    /** @type {string} */
    minerAddress;

    blockchainStats = {};
    delayBeforeSendingCandidate = 10000;
    ignoreIncomingBlocks = false;
    logValidationTime = false;

    /** @param {Account} account */
    constructor(account, roles = ['validator'], listenAddress = '/ip4/0.0.0.0/tcp/27260', version = 1) {
        this.id = account.address;
        this.account = account;
        this.roles = roles; // 'miner', 'validator', ...
        this.listenAddress = listenAddress;
        this.version = version;
        this.validatorRewardAddress = account.address;

        /** @type {P2PNetwork} */
        this.p2pNetwork = new P2PNetwork(this.timeSynchronizer, this.listenAddress);

        /** @type {Vss} */
        this.vss = new Vss(BLOCKCHAIN_SETTINGS.maxSupply);
        this.blockchain = new Blockchain(this.id);
        this.reorganizator = new Reorganizator(this);
        this.utxoCache = new UtxoCache(this.id, this.version, this.blockchain);
    }

    // STARTUP -----------------------------------------------------------------------
    #updateState(newState, onlyFrom) {
        const state = this.blockchainStats.state;
        if (onlyFrom && !(state === onlyFrom || state.includes(onlyFrom))) { return; }
        this.blockchainStats.state = newState;
    }
    #subscribeTopicsRelatedToRoles(roles = []) {
        const rolesTopics = {
            validator: ['new_transaction', 'new_block_finalized'],
            miner: ['new_block_candidate'],
            observer: ['new_transaction', 'new_block_finalized', 'new_block_candidate']
        }
        const topicsToSubscribe = [];
        for (const role of roles) { topicsToSubscribe.push(...rolesTopics[role]); }
        return [...new Set(topicsToSubscribe)];
    }
    #loadBootstrapNodesList() {
        const loadedBootstrapNodes = Storage.loadJSON('bootstrapNodes');
        if (loadedBootstrapNodes) {
            for (const node of loadedBootstrapNodes) {
                if (!this.bootstrapNodes.includes(node)) { this.bootstrapNodes.push(node); }
            }
        }

        this.p2pNetwork.options.bootstrapNodes = this.bootstrapNodes;
    }
    async start(startFromScratch = false) {
        this.#updateState("starting");

        this.#loadBootstrapNodesList();
        Storage.saveJSON('bootstrapNodes', this.bootstrapNodes);

        await this.timeSynchronizer.syncTimeWithRetry(5, 500);
        this.miniLogger.log(`Node ${this.id} (${this.roles.join('_')}) => started at time: ${this.timeSynchronizer.getCurrentTime()}`, (m) => { console.info(m); });

        for (let i = 0; i < this.nbOfWorkers; i++) { this.workers.push(new ValidationWorker(i)); }
        this.opStack = OpStack.buildNewStack(this);
        this.miner = new Miner(this.minerAddress || this.account.address, this);
        this.miner.useDevArgon2 = this.useDevArgon2;

        if (!startFromScratch) {
            this.#updateState("Loading blockchain");
            const startHeight = await this.blockchain.load(this.snapshotSystem);
            this.loadSnapshot(startHeight);
        }

        this.#updateState("Initializing P2P network");
        const uniqueHash = await this.account.getUniqueHash(64);
        await this.p2pNetwork.start(uniqueHash);
        this.syncHandler = new SyncHandler(this);
        const uniqueTopics = this.#subscribeTopicsRelatedToRoles(this.roles);
        for (const topic of uniqueTopics) { this.p2pNetwork.subscribe(topic, this.p2pHandler.bind(this)); }

        if (this.roles.includes('miner')) { this.miner.startWithWorker(); }

        const nbOfPeers = await this.#waitSomePeers();
        if (!nbOfPeers || nbOfPeers < 1) {
            this.miniLogger.log('Failed to connect to peers, stopping the node', (m) => { console.error(m); });
            this.restartRequested = 'Failed to connect to peers';
            return;
        }

        this.miniLogger.log('P2P network is ready - we are connected baby', (m) => { console.info(m); });
        if (!this.roles.includes('validator')) { return; }

        this.opStack.pushFirst('createBlockCandidateAndBroadcast', null);
        this.opStack.pushFirst('syncWithPeers', null);
    }
    async #waitSomePeers(nbOfPeers = 1, maxAttempts = 30, delay = 1000) {
        const myPeerId = this.p2pNetwork.p2pNode.peerId.toString();
        let connectedPeers = 0;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (this.restartRequested) { break; }

            const peersIds = this.p2pNetwork.getConnectedPeers();
            connectedPeers = peersIds.length - (peersIds.includes(myPeerId) ? 1 : 0);
            if (connectedPeers >= nbOfPeers) { return connectedPeers; }

            await new Promise(resolve => setTimeout(resolve, delay));
        }

        return connectedPeers;
    }

    // BLOCK CANDIDATE CREATION ---------------------------------------------------------
    #calculateAverageBlockTimeAndDifficulty() {
        const lastBlock = this.blockchain.lastBlock;
        if (!lastBlock) { return { averageBlockTime: BLOCKCHAIN_SETTINGS.targetBlockTime, newDifficulty: MINING_PARAMS.initialDifficulty }; }
        
        const olderBlock = this.blockchain.getBlock(Math.max(0, lastBlock.index - MINING_PARAMS.blocksBeforeAdjustment));
        const averageBlockTime = mining.calculateAverageBlockTime(lastBlock, olderBlock);
        const newDifficulty = mining.difficultyAdjustment(lastBlock, averageBlockTime);
        return { averageBlockTime, newDifficulty };
    }
    /** Aggregates transactions from mempool, creates a new block candidate, signs it and returns it */
    async #createBlockCandidate() {
        const startTime = Date.now();

        // Create the block candidate, genesis block if no lastBlockData
        const posTimestamp = this.blockchain.lastBlock ? this.blockchain.lastBlock.timestamp + 1 : this.timeSynchronizer.getCurrentTime();
        let blockCandidate = BlockData(0, 0, BLOCKCHAIN_SETTINGS.blockReward, MINING_PARAMS.initialDifficulty, 0, '0000000000000000000000000000000000000000000000000000000000000000', [], posTimestamp);
        
        // If not genesis block: fill the block candidate with transactions etc...
        if (this.blockchain.lastBlock) {
            const prevHash = this.blockchain.lastBlock.hash;
            const myLegitimacy = await this.vss.getAddressLegitimacy(this.account.address, prevHash);
            this.blockchainStats.lastLegitimacy = myLegitimacy;
            if (myLegitimacy > this.vss.maxLegitimacyToBroadcast) { return null; }

            const { averageBlockTime, newDifficulty } = this.#calculateAverageBlockTimeAndDifficulty();
            this.blockchainStats.averageBlockTime = averageBlockTime;
            const coinBaseReward = mining.calculateNextCoinbaseReward(this.blockchain.lastBlock);
            const Txs = this.memPool.getMostLucrativeTransactionsBatch(this.utxoCache);
            blockCandidate = BlockData(this.blockchain.lastBlock.index + 1, this.blockchain.lastBlock.supply + this.blockchain.lastBlock.coinBase, coinBaseReward, newDifficulty, myLegitimacy, prevHash, Txs, posTimestamp);
        }

        // Sign the block candidate
        const { powReward, posReward } = BlockUtils.calculateBlockReward(this.utxoCache, blockCandidate);
        const posFeeTx = await Transaction_Builder.createPosReward(posReward, blockCandidate, this.validatorRewardAddress, this.account.address);
        const signedPosFeeTx = await this.account.signTransaction(posFeeTx);
        blockCandidate.Txs.unshift(signedPosFeeTx);
        blockCandidate.powReward = powReward; // for the miner

        if (blockCandidate.Txs.length > 3) { this.miniLogger.log(`(Height:${blockCandidate.index}) => ${blockCandidate.Txs.length} txs, block candidate created in ${(Date.now() - startTime)}ms`, (m) => { console.info(m); }); }
        return blockCandidate;
    }
    /** Creates a new block candidate, signs it and broadcasts it */
    async createBlockCandidateAndBroadcast(delay = 0, awaitBroadcast = false) {
        this.#updateState(`creating block candidate #${this.blockchain.lastBlock ? this.blockchain.lastBlock.index + 1 : 0}`);
        if (!this.roles.includes('validator')) { return false; }

        this.blockCandidate = await this.#createBlockCandidate();
        if (this.blockCandidate === null) { this.#updateState("idle", "creating block candidate"); return false; }

        if (this.roles.includes('miner')) this.miner.updateBestCandidate(this.blockCandidate);

        let broadcasted = null;
        this.#updateState(`broadcasting block candidate #${this.blockCandidate.index} in ${delay}ms`, "creating block candidate");
        setTimeout(async () => {
            try {
                await this.p2pBroadcast('new_block_candidate', this.blockCandidate);
                broadcasted = true;
                this.#updateState("idle", "broadcasting block candidate");

                const callback = this.wsCallbacks.onBroadcastNewCandidate;
                if (callback) callback.execute(BlockUtils.getBlockHeader(this.blockCandidate));
            } catch (error) {
                this.miniLogger.log(`Failed to broadcast new block candidate: ${error.message}`, (m) => { console.error(m); });
            }
        }, delay ? delay : 0);

        if (!awaitBroadcast) { return true; }
        while (broadcasted === null) { await new Promise(resolve => setTimeout(resolve, 100)); }
        return broadcasted;
    }

    // SNAPSHOT: LOAD/SAVE ---------------------------------------------------------------
    loadSnapshot(snapshotIndex = 0, eraseHigher = true) {
        if (snapshotIndex < 0) { return; }

        this.miniLogger.log(`Last known snapshot index: ${snapshotIndex}`, (m) => { console.warn(m); });
        this.blockchain.currentHeight = snapshotIndex;
        this.blockCandidate = null;
        this.snapshotSystem.rollBackTo(snapshotIndex, this.utxoCache, this.vss, this.memPool);

        this.miniLogger.log(`Snapshot loaded: ${snapshotIndex}`, (m) => { console.warn(m); });
        if (snapshotIndex < 1) { this.blockchain.reset(); }

        this.blockchain.lastBlock = this.blockchain.getBlock(snapshotIndex);
        if (!eraseHigher) { return; }

        // place snapshot to trash folder, we can restaure it if needed
        this.snapshotSystem.eraseSnapshotsHigherThan(snapshotIndex - 1);
    }
    /** @param {BlockData} finalizedBlock */
    #saveSnapshot(finalizedBlock) {
        if (finalizedBlock.index === 0) { return; }
        if (finalizedBlock.index % this.snapshotSystem.snapshotHeightModulo !== 0) { return; }
        const eraseUnder = this.snapshotSystem.snapshotHeightModulo * this.snapshotSystem.snapshotToConserve;

        // erase the outdated blocks cache and persist the addresses transactions references to disk
        const cacheErasable = this.blockchain.cache.erasableLowerThan(finalizedBlock.index - (eraseUnder - 1));
        if (cacheErasable !== null && cacheErasable.from < cacheErasable.to) {
            this.blockchain.persistAddressesTransactionsReferencesToDisk(this.memPool, cacheErasable.from, cacheErasable.to);
            this.blockchain.cache.eraseFromTo(cacheErasable.from, cacheErasable.to);
        }

        this.snapshotSystem.newSnapshot(this.utxoCache, this.vss, this.memPool);
        this.snapshotSystem.eraseSnapshotsLowerThan(finalizedBlock.index - eraseUnder);
        // avoid gap between the loaded snapshot and the new one
        // at this stage we know that the loaded snapshot is consistent with the blockchain
        if (this.snapshotSystem.loadedSnapshotHeight < finalizedBlock.index - (eraseUnder*2)) {
            this.snapshotSystem.loadedSnapshotHeight = 0;
        }
        this.snapshotSystem.restoreLoadedSnapshot();
    }

    // FINALIZED BLOCK HANDLING ----------------------------------------------------------
    /** @param {BlockData} finalizedBlock */
    async #validateBlockProposal(finalizedBlock, blockBytes) {
        const timer = new BlockValidationTimer(), validatorId = finalizedBlock.Txs[1].outputs[0].address.slice(0, 6), minerId = finalizedBlock.Txs[0].outputs[0].address.slice(0, 6);
        timer.startPhase('total-validation');
        
        try { timer.startPhase('block-index-check'); BlockValidation.checkBlockIndexIsNumber(finalizedBlock); timer.endPhase('block-index-check'); }
        catch (error) { this.miniLogger.log(`#${finalizedBlock.index} -> ${error.message} Miner: ${minerId} | Validator: ${validatorId}`, (m) => { console.error(m); }); throw error; }

        timer.startPhase('miner-hash');
        const { hex, bitsArrayAsString } = await BlockUtils.getMinerHash(finalizedBlock, this.useDevArgon2);
        if (finalizedBlock.hash !== hex) throw new Error(`!banBlock! !applyOffense! Invalid pow hash (not corresponding): ${finalizedBlock.hash} - expected: ${hex}`);
        timer.endPhase('miner-hash');
    
        timer.startPhase('height-timestamp-hash');
        BlockValidation.validateBlockIndex(finalizedBlock, this.blockchain.currentHeight);
        BlockValidation.validateBlockPrevHash(finalizedBlock, this.blockchain.lastBlock);
        BlockValidation.validateTimestamps(finalizedBlock, this.blockchain.lastBlock, this.timeSynchronizer.getCurrentTime());
        timer.endPhase('height-timestamp-hash');
        
        timer.startPhase('legitimacy');
        await BlockValidation.validateLegitimacy(finalizedBlock, this.vss);
        timer.endPhase('legitimacy');

        timer.startPhase('difficulty-check');
        const { averageBlockTime, newDifficulty } = this.#calculateAverageBlockTimeAndDifficulty();
        if (finalizedBlock.difficulty !== newDifficulty) throw new Error(`!banBlock! !applyOffense! Invalid difficulty: ${finalizedBlock.difficulty} - expected: ${newDifficulty}`);
        const hashConfInfo = mining.verifyBlockHashConformToDifficulty(bitsArrayAsString, finalizedBlock);
        if (!hashConfInfo.conform) throw new Error(`!banBlock! !applyOffense! Invalid pow hash (difficulty): ${finalizedBlock.hash} -> ${hashConfInfo.message}`);
        timer.endPhase('difficulty-check');
    
        timer.startPhase('rewards-validation');
        const expectedCoinBase = mining.calculateNextCoinbaseReward(this.blockchain.lastBlock || finalizedBlock);
        if (finalizedBlock.coinBase !== expectedCoinBase) throw new Error(`!banBlock! !applyOffense! Invalid #${finalizedBlock.index} coinbase: ${finalizedBlock.coinBase} - expected: ${expectedCoinBase}`);
        const { powReward, posReward, totalFees } = BlockUtils.calculateBlockReward(this.utxoCache, finalizedBlock);
        try { BlockValidation.areExpectedRewards(powReward, posReward, finalizedBlock); } 
        catch { throw new Error('!banBlock! !applyOffense! Invalid rewards'); }
        timer.endPhase('rewards-validation');
    
        timer.startPhase('double-spending-check');
        try { BlockValidation.isFinalizedBlockDoubleSpending(finalizedBlock); }
        catch { throw new Error('!banBlock! !applyOffense! Double spending detected'); }
        timer.endPhase('double-spending-check');
    
        timer.startPhase('full-txs-validation');
        const allDiscoveredPubKeysAddresses = await BlockValidation.fullBlockTxsValidation(finalizedBlock, this.utxoCache, this.memPool, this.workers, this.useDevArgon2);
        this.memPool.addNewKnownPubKeysAddresses(allDiscoveredPubKeysAddresses);
        timer.endPhase('full-txs-validation');
    
        timer.endPhase('total-validation');
        if (this.logValidationTime){ timer.displayResults(); }
    
        return { hashConfInfo, powReward, posReward, totalFees, allDiscoveredPubKeysAddresses };
    }
    /**
     * @param {BlockData} finalizedBlock
     * @param {Object} [options] - Configuration options for the blockchain.
     * @param {boolean} [options.skipValidation] - default: false
     * @param {boolean} [options.broadcastNewCandidate] - default: true
     * @param {boolean} [options.isSync] - default: false
     * @param {boolean} [options.persistToDisk] - default: true
     * @param {number} [byteLength] - default: serializedBlock.byteLength
     */
    async digestFinalizedBlock(finalizedBlock, options = {}, byteLength) {
        if (this.restartRequested) return;
        
        const timer = new BlockDigestionTimer();
        const statePrefix = options.isSync ? '(syncing) ' : '';
        this.#updateState(`${statePrefix}finalized block #${finalizedBlock.index}`);
    
        timer.startPhase('initialization');
        // SUPPLEMENTARY TEST (INITIAL === DESERIALIZE)
        const serializedBlock = serializer.serialize.block_finalized(finalizedBlock);
        const blockBytes = byteLength || serializedBlock.byteLength;
        const deserializedBlock = serializer.deserialize.block_finalized(serializedBlock);
        const blockSignature = await BlockUtils.getBlockSignature(finalizedBlock);
        const deserializedSignature = await BlockUtils.getBlockSignature(deserializedBlock);
        if (blockSignature !== deserializedSignature) {
            console.error('blockSignature !== deserializedSignature');
            console.error(finalizedBlock);
            console.error(deserializedBlock);
            throw new Error('Invalid block signature'); }

        const { skipValidation = false, broadcastNewCandidate = true, isSync = false, persistToDisk = true } = options;
        if (!finalizedBlock || !this.roles.includes('validator') || (this.syncHandler.isSyncing && !isSync)) 
            throw new Error(!finalizedBlock ? 'Invalid block candidate' : !this.roles.includes('validator') ? 'Only validator can process PoW block' : "Node is syncing, can't process block");
        timer.endPhase('initialization');
    
        let hashConfInfo = false;
        let validationResult;
        let totalFees;
        if (!skipValidation) {
            timer.startPhase('block-validation');
            this.#updateState(`${statePrefix}block-validation #${finalizedBlock.index}`);
            validationResult = await this.#validateBlockProposal(finalizedBlock, blockBytes);
            hashConfInfo = validationResult.hashConfInfo;
            if (!hashConfInfo?.conform) throw new Error('Failed to validate block');
            timer.endPhase('block-validation');
        }
        
        this.#updateState(`${statePrefix}applying finalized block #${finalizedBlock.index}`);
        timer.startPhase('add-confirmed-block');
        if (!skipValidation && !hashConfInfo?.conform) throw new Error('Failed to validate block');
        const blockInfo = this.blockchain.addConfirmedBlock(this.utxoCache, finalizedBlock, persistToDisk, this.wsCallbacks.onBlockConfirmed, totalFees);
        timer.endPhase('add-confirmed-block');
    
        timer.startPhase('apply-blocks'),
        this.blockchain.applyBlock(this.utxoCache, this.vss, finalizedBlock, this.roles.includes('observer')),
        timer.endPhase('apply-blocks'),
        timer.startPhase('mempool-cleanup'),
        this.memPool.removeFinalizedBlocksTransactions(finalizedBlock),
        timer.endPhase('mempool-cleanup');

        const waitStart = Date.now();
    
        timer.startPhase('block-storage'); // callback ?
        if (!skipValidation && this.wsCallbacks.onBlockConfirmed) this.wsCallbacks.onBlockConfirmed.execute(blockInfo);
        timer.endPhase('block-storage');
    
        //if (blockBytes > 102_400 && !skipValidation) {
        this.miniLogger.log(`#${finalizedBlock.index} -> blockBytes: ${blockBytes} | Txs: ${finalizedBlock.Txs.length} | digest: ${timer.getTotalTime()}s`, (m) => { console.info(m); });
        if (this.logValidationTime){ timer.displayResults();}
        //}
    
        const timeBetweenPosPow = ((finalizedBlock.timestamp - finalizedBlock.posTimestamp) / 1000).toFixed(2);
        const minerId = finalizedBlock.Txs[0].outputs[0].address.slice(0, 6);
        const validatorId = finalizedBlock.Txs[1].outputs[0].address.slice(0, 6);
    
        if (!isSync) { this.miniLogger.log(`#${finalizedBlock.index} -> {valid: ${validatorId} | miner: ${minerId}} - (diff[${hashConfInfo.difficulty}]+timeAdj[${hashConfInfo.timeDiffAdjustment}]+leg[${hashConfInfo.legitimacy}])=${hashConfInfo.finalDifficulty} | z: ${hashConfInfo.zeros} | a: ${hashConfInfo.adjust} | PosPow: ${timeBetweenPosPow}s | digest: ${timer.getTotalTime()}s`, (m) => { console.info(m); }); }
    
        timer.startPhase('saveSnapshot');
        this.#saveSnapshot(finalizedBlock);
        timer.endPhase('saveSnapshot');
        
        this.#updateState("idle", "applying finalized block");
        if (!broadcastNewCandidate) { return; }
        return Math.max(0, this.delayBeforeSendingCandidate - (Date.now() - waitStart)); // delay before sending a new candidate
    }

    /** @param {string} topic @param {any} message */
    async p2pBroadcast(topic, message) {
        await this.p2pNetwork.broadcast(topic, message);
        if (topic === 'new_block_finalized') { setTimeout(() => this.#reSendBlocks(message.index), 1000); }
    }
    /** @param {number} finalizedBlockHeight @param {number[]} sequence - default: [-10, -8, -6, -4, -2] */
    async #reSendBlocks(finalizedBlockHeight, sequence = [-10, -8, -6, -4, -2]) {
        const sentSequence = [];
        for (const index of sequence) {
            const blockIndex = finalizedBlockHeight + index;
            if (blockIndex < 0) { continue; }

            const block = this.blockchain.getBlock(blockIndex);
            if (!block) { continue; }

            await new Promise(resolve => setTimeout(resolve, 200));
            await this.p2pNetwork.broadcast('new_block_finalized', block);
            sentSequence.push(block.index);
        }

        this.miniLogger.log(`[NODE-${this.id.slice(0, 6)}] Re-sent blocks: [${sentSequence.join(', ')}]`, (m) => { console.info(m); });
    }
    /** @param {string} topic @param {object} message */
    async p2pHandler(topic, message) {
        const data = message.content;
        const from = message.from;
        const byteLength = message.byteLength;
        const lastBlockIndex = this.blockchain.lastBlock ? this.blockchain.lastBlock.index : -1;
        //console.log(`[P2P-HANDLER] ${topic} -> ${from} | ${byteLength} bytes`);
        try {
            switch (topic) {
                case 'new_transaction':
                    if (this.syncHandler.isSyncing || this.opStack.syncRequested) { return; }
                    if (!this.roles.includes('validator')) { break; }

                    this.opStack.push('pushTransaction', data);
                    break;
                case 'new_block_candidate':
                    try { BlockValidation.checkBlockIndexIsNumber(data); } catch (error) { throw error; }

                    if (this.ignoreIncomingBlocks) { break; }
                    if (!this.roles.includes('miner')) { break; }
                    if (!this.roles.includes('validator')) { break; }

                    if (lastBlockIndex +1 !== data.index) {
                        this.miniLogger.log(`lastBlockIndex #${lastBlockIndex} +1 !== #${data.index} -> skip candidate`, (m) => { console.info(m); });
                        break;
                    }

                    const legitimacyValidated = await BlockValidation.validateLegitimacy(data, this.vss, true);
                    if (legitimacyValidated) { this.miner.updateBestCandidate(data); break; }
                    
                    this.miniLogger.log(`${topic} -> #${data.index} -> Invalid legitimacy!`, (m) => { console.info(m); });
                    break;
                case 'new_block_finalized':
                    try { BlockValidation.checkBlockIndexIsNumber(data); } catch (error) { throw error; }
                    if (this.ignoreIncomingBlocks) { break; }
                    if (this.syncHandler.isSyncing || this.opStack.syncRequested) { break; }

                    if (!this.roles.includes('validator')) { break; }

                    const isInBlockchainCache = this.blockchain.cache.blockHeightByHash.has(data.hash);
                    const isInReorganizatorCache = this.reorganizator.isFinalizedBlockInCache(data);
                    if (!isInBlockchainCache && !isInReorganizatorCache) {
                        this.opStack.push('digestPowProposal', message);
                        break;
                    }
                    
                    //this.miniLogger.log(`Already processed ${topic} #${data.index} -> skip`, (m) => { console.warn(m); });
                    break;
                case 'test':
                    this.miniLogger.log(`[TEST] heavy msg bytes: ${new Uint8Array(Object.values(data)).length}`, (m) => { console.warn(m); });
                    break;
                default:
                    this.miniLogger.log(`Unknown topic ${topic}`, (m) => { console.error(m); });
            }
        } catch (error) { this.miniLogger.log(`${topic} -> Failed! ${error}`, (m) => { console.error(m); }); }
    }

    // API -------------------------------------------------------------------------------
    getStatus() {
        return {
            id: this.id,
            role: this.roles.join('_'),
            currentBlockHeight: this.blockchain.currentHeight,
            memPoolSize: Object.keys(this.memPool.transactionsByID).length,
            peerCount: this.p2pNetwork.getConnectedPeers().length,
        };
    }
    /** @param {Transaction} transaction */
    async pushTransaction(transaction) {
        try {
            await this.memPool.pushTransaction(this.utxoCache, transaction);
            await this.p2pBroadcast('new_transaction', transaction);
            //console.log(`Tx ${transaction.id} pushed in mempool`);
            const consumedUTXOs = transaction.inputs;
            return { broadcasted: true, pushedInLocalMempool: true, consumedUTXOs, error: null };
        } catch (error) {
            this.miniLogger.log(`Tx ${transaction.id} rejected: ${error.message}`, (m) => { console.error(m); });
            return { broadcasted: false, pushedInLocalMempool: false, consumedUTXOs: [], error: error.message };
        }
    }
    getBlocksInfo(fromHeight = 0, toHeight = 10) {
        try {
            if (fromHeight > toHeight) { throw new Error(`Invalid range: ${fromHeight} > ${toHeight}`); }
            //if (toHeight - fromHeight > 10) { throw new Error('Cannot retrieve more than 10 blocks at once'); }

            /** @type {BlockInfo[]} */
            const blocksInfo = [];
            for (let i = fromHeight; i <= toHeight; i++) {
                const blockInfo = this.blockchain.blockStorage.getBlockInfoByIndex(i);
                blocksInfo.push(blockInfo);
            }

            return blocksInfo;
        } catch (error) { this.miniLogger.log(error, (m) => { console.error(m); }); return []; }
    }
    async getExhaustiveBlocksDataByHeight(fromHeight = 0, toHeight = null) {
        try {
            toHeight = toHeight || fromHeight;
            if (fromHeight > toHeight) { throw new Error(`Invalid range: ${fromHeight} > ${toHeight}`); }

            /** @type {BlockData[]} */
            const blocksData = [];
            for (let i = fromHeight; i <= toHeight; i++) {
                const blockData = this.blockchain.getBlock(i);
                const blockInfo = this.blockchain.blockStorage.getBlockInfoByIndex(i);
                blocksData.push(this.#exhaustiveBlockFromBlockDataAndInfo(blockData, blockInfo));
            }

            return blocksData;
        } catch (error) { this.miniLogger.log(error, (m) => { console.error(m); }); return []; }
    }
    getExhaustiveBlockDataByHash(hash) {
        try {
            const blockData = this.blockchain.getBlock(hash);
            const blockInfo = this.blockchain.blockStorage.getBlockInfoByIndex(blockData.index);
            if (!blockData || !blockInfo) { throw new Error(`Block not found: ${hash}`); }

            return this.#exhaustiveBlockFromBlockDataAndInfo(blockData, blockInfo);
        } catch (error) { this.miniLogger.log(error, (m) => { console.error(m); }); return null; }
    }
    /** @param {BlockData} blockData @param {BlockInfo} blockInfo */
    #exhaustiveBlockFromBlockDataAndInfo(blockData, blockInfo) {
        blockData.powReward = blockData.Txs[0].outputs[0].amount;
        blockData.posReward = blockData.Txs[1].outputs[0].amount;
        blockData.totalFees = blockInfo.totalFees;
        blockData.lowerFeePerByte = blockInfo.lowerFeePerByte;
        blockData.higherFeePerByte = blockInfo.higherFeePerByte;
        blockData.nbOfTxs = blockInfo.nbOfTxs;
        blockData.blockBytes = blockInfo.blockBytes;

        blockData.minerAddress = blockData.Txs[0].outputs[0].address;
        blockData.validatorAddress = blockData.Txs[1].inputs[0].split(':')[0];
        return blockData;
    }
    getAddressExhaustiveData(address, from = 0, to = this.blockchain.currentHeight) {
        const addressTxsReferences = this.blockchain.getTxsReferencesOfAddress(this.memPool, address, from, to);
        const addressUTXOs = this.getAddressUtxos(address);
        return { addressUTXOs, addressTxsReferences };
    }
    /** @param {string} txReference - ex: 12:0f0f0f @param {string} address - optional: also return balanceChange for this address */
    getTransactionByReference(txReference, address = undefined) {
        try {
            if (address) { addressUtils.conformityCheck(address); }
            const result = { transaction: undefined, balanceChange: 0, inAmount: 0, outAmount: 0, fee: 0 };
            result.transaction = this.blockchain.getTransactionByReference(txReference);
            if (!result.transaction) { return result; }
            if (address === undefined) { return result; }

            for (const output of result.transaction.outputs) {
                result.outAmount += output.amount;
                if (output.address === address) { result.balanceChange += output.amount; }
            }

            for (const anchor of result.transaction.inputs) {
                if (!typeValidation.isConformAnchor(anchor)) { continue; }
                const txRef = `${anchor.split(":")[0]}:${anchor.split(":")[1]}`;
                const utxoRelatedTx = this.blockchain.getTransactionByReference(txRef);
                if (!utxoRelatedTx) { continue; }
                
                const outputIndex = parseInt(anchor.split(":")[2]);
                const output = utxoRelatedTx.outputs[outputIndex];
                result.inAmount += output.amount;

                //if (!addressTxsReferences.includes(txRef)) { continue; }
                if (output.address !== address) { continue; }

                result.balanceChange -= output.amount;
            }

            result.fee = result.inAmount === 0 ? 0 : result.inAmount - result.outAmount;

            return result;
        } catch (error) {
            this.miniLogger.log(error, (m) => { console.error(m); });
            return { transaction: undefined, balanceChange: undefined };
        }
    }
    getAddressUtxos(address) {
        const addressAnchors = this.utxoCache.getAddressAnchorsArray(address);
        let spendableBalance = 0;
        let balance = 0;
        const UTXOs = [];
        for (const anchor of addressAnchors) {
            const associatedMemPoolTx = this.memPool.transactionByAnchor[anchor];
            if (associatedMemPoolTx) { continue; } // pending spent UTXO

            const utxo = this.utxoCache.getUTXO(anchor);
            if (!utxo) { this.miniLogger.log(`UTXO not removed from AddressAnchors: ${anchor}`, (m) => { console.error(m); }); continue; } // should not happen
            if (utxo.spent) { this.miniLogger.log(`UTXO spent but not removed from AddressAnchors: ${anchor}`, (m) => { console.error(m); }); continue; } // should not happen

            balance += utxo.amount;
            UTXOs.push(utxo);

            if (utxo.rule === "sigOrSlash") { continue; }
            spendableBalance += utxo.amount;
        }

        return { spendableBalance, balance, UTXOs };
    }
    getAddressUtxosOnly(address) { // UNUSED ATM
        const addressAnchors = this.utxoCache.getAddressAnchorsArray(address);
        const UTXOs = [];
        for (const anchor of addressAnchors) {
            const associatedMemPoolTx = this.memPool.transactionByAnchor[anchor];
            if (associatedMemPoolTx) { continue; } // pending spent UTXO

            const utxo = this.utxoCache.getUTXO(anchor);
            if (!utxo) { this.miniLogger.log(`UTXO not removed from AddressAnchors: ${anchor}`, (m) => { console.error(m); }); continue; } // should not happen
            if (utxo.spent) { this.miniLogger.log(`UTXO spent but not removed from AddressAnchors: ${anchor}`, (m) => { console.error(m); }); continue; } // should not happen

            UTXOs.push(utxo);
        }
        return UTXOs;
    }
}

class BaseBlockTimer {
    constructor(type = 'Base') {
        this.measurements = [];
        this.startTime = Date.now();
        this.type = type;
    }

    startPhase(phase) { performance.mark(`${phase}-start`); }

    endPhase(phase) {
        performance.mark(`${phase}-end`);
        performance.measure(phase, `${phase}-start`, `${phase}-end`);
        this.measurements.push({ phase, duration: performance.getEntriesByName(phase)[0].duration.toFixed(2) });
        ['start', 'end'].forEach(t => performance.clearMarks(`${phase}-${t}`));
        performance.clearMeasures(phase);
    }

    getTotalTime() { return ((Date.now() - this.startTime) / 1000).toFixed(2); }

    displayResults() {
        const totalDuration = this.measurements.reduce((sum, m) => sum + parseFloat(m.duration), 0);
        console.group(`Block ${this.type} Performance Metrics`);
        console.table(this.measurements);
        console.log(`Total ${this.type.toLowerCase()} time: ${totalDuration.toFixed(2)}ms`);
        console.groupEnd();
    }
}
class BlockValidationTimer extends BaseBlockTimer {
    constructor() { super('Validation'); }
}
class BlockDigestionTimer extends BaseBlockTimer {
    constructor() { super('Digestion'); }
}