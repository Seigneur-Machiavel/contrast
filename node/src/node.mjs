import localStorage_v1 from '../storage/local-storage-management.mjs';
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
import { SyncHandler } from './nodes-synchronizer.mjs';
import { SnapshotSystem } from './snapshot-system.mjs';
import { performance, PerformanceObserver } from 'perf_hooks';
import { ValidationWorker } from '../workers/workers-classes.mjs';
import { ConfigManager } from './config-manager.mjs';
import { TimeSynchronizer } from '../../utils/time.mjs';
//import { Logger } from '../plugins/logger.mjs';
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
    /** @param {Account} account */
    constructor(account, roles = ['validator'], p2pOptions = {}, version = 1) {
        /** @type {MiniLogger} */
        this.miniLogger = new MiniLogger('node');
        this.timeSynchronizer = new TimeSynchronizer();
        this.restartRequested = false;
        /** @type {string} */
        this.id = account.address;
        /** @type {SnapshotSystem} */
        this.snapshotSystem = new SnapshotSystem(this.id);
        /** @type {string[]} */
        this.roles = roles; // 'miner', 'validator', ...
        /** @type {OpStack} */
        this.opStack = null;
        /** @type {P2PNetwork} */
        this.p2pNetwork = new P2PNetwork({
            role: this.roles.join('_'),
            ...p2pOptions
        }, this.timeSynchronizer);
        this.p2pOptions = p2pOptions;

        /** @type {Account} */
        this.account = account;
        this.validatorRewardAddress = account.address;
        /** @type {BlockData} */
        this.blockCandidate = null;

        /** @type {Vss} */
        this.vss = new Vss(BLOCKCHAIN_SETTINGS.maxSupply);
        /** @type {MemPool} */
        this.memPool = new MemPool();
        /** @type {number} */
        this.version = version;

        /** @type {Miner} */
        this.miner = null;
        /** @type {string} */
        this.minerAddress = null;
        this.useDevArgon2 = false;
        /** @type {Blockchain} */
        this.blockchain = new Blockchain(this.id);
        /** @type {SyncHandler} */
        this.syncHandler = new SyncHandler(() => this);
        /** @type {Reorganizator} */
        this.reorganizator = new Reorganizator(this);

        /** @type {Object<string, WebSocketCallBack>} */
        this.wsCallbacks = {};
        /** @type {UtxoCache} */
        this.utxoCache = new UtxoCache(this.id, this.version, this.blockchain);

        /** @type {ValidationWorker[]} */
        this.workers = [];
        this.nbOfWorkers = 4;
        this.configManager = new ConfigManager("node/config.json");

        this.blockchainStats = {};
        this.delayBeforeSendingCandidate = 10000;
        this.ignoreIncomingBlocks = false;
        this.logValidationTime = false;
    }

    async start(startFromScratch = false) {
        this.blockchainStats.state = "starting";
        this.configManager.init();
        await this.timeSynchronizer.syncTimeWithRetry(5, 500);

        this.miniLogger.log(`Node ${this.id} (${this.roles.join('_')}) => started at time: ${this.timeSynchronizer.getCurrentTime()}`, (m) => { console.info(m); });

        for (let i = 0; i < this.nbOfWorkers; i++) { this.workers.push(new ValidationWorker(i)); }
        this.opStack = OpStack.buildNewStack(this);
        this.miner = new Miner(this.minerAddress || this.account.address, this);
        this.miner.useDevArgon2 = this.useDevArgon2;

        if (!startFromScratch) {
            this.blockchainStats.state = "loading";
            const startHeight = await this.blockchain.load(this.snapshotSystem);
            await this.loadSnapshot(startHeight);
        }

        const bootstrapNodes = this.configManager.getBootstrapNodes();
        this.p2pNetwork.options.bootstrapNodes = bootstrapNodes;

        const uniqueHash = await this.account.getUniqueHash(64);
        await this.p2pNetwork.start(uniqueHash);
        await this.syncHandler.start(this.p2pNetwork);
        if (this.roles.includes('miner')) { this.miner.startWithWorker(); }

        const nbOfPeers = await this.#waitSomePeers();
        if (!nbOfPeers || nbOfPeers < 1) { this.miniLogger.log('Failed to connect to peers, stopping the node', (m) => { console.error(m); }); return; }
        this.miniLogger.log('P2P network is ready - we are connected baby', (m) => { console.info(m); });

        if (!this.roles.includes('validator')) { return; }

        this.opStack.pushFirst('createBlockCandidateAndBroadcast', null);
        this.opStack.pushFirst('syncWithPeers', null);

        this.connexionsMaintenerLoop();
    }
    async connexionsMaintenerLoop() {
        while(true) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            const nbOfPeers = await this.#waitSomePeers();
            if (!nbOfPeers || nbOfPeers < 1) { this.restartRequested = 'connexionsMaintenerLoop'; return; }
        }
    }
    async stop() {
        this.miniLogger.log(`Node ${this.id} (${this.roles.join('_')}) => stopped`, (m) => { console.info(m); });
    }
    requestRestart(from = 'unknown') {
        this.restartRequested = from;
    }

    //#region - CONNEXION INITIALIZATION ----------------------------------------------------------
    getTopicsToSubscribeRelatedToRoles() {
        const rolesTopics = {
            validator: ['new_transaction', 'new_block_finalized'],
            miner: ['new_block_candidate'],
            observer: ['new_transaction', 'new_block_finalized', 'new_block_candidate']
        }
        const topicsToSubscribe = [];
        for (const role of this.roles) { topicsToSubscribe.push(...rolesTopics[role]); }
        return [...new Set(topicsToSubscribe)];
    }

    async #waitSomePeers(nbOfPeers = 1, maxAttempts = 60, timeOut = 30000) {
        const checkPeerCount = () => {
            const peersIds = this.p2pNetwork.getConnectedPeers();
            const myPeerId = this.p2pNetwork.p2pNode.peerId.toString();
            return peersIds.length - (peersIds.includes(myPeerId) ? 1 : 0);
        };

        const attemptConnection = async () => {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                let peerCount = checkPeerCount();
                if (peerCount >= nbOfPeers) { return peerCount; }
                /*if (peerCount >= nbOfPeers) {
                    this.miniLogger.log(`Connected to ${peerCount} peer${peerCount !== 1 ? 's' : ''}`, (m) => { console.info(m); });
                    return peerCount;
                }*/

                await this.p2pNetwork.connectToBootstrapNodes();
                peerCount = checkPeerCount();
                
                if (peerCount >= nbOfPeers) {
                    this.miniLogger.log(`Connected to ${peerCount} peer${peerCount !== 1 ? 's' : ''} after connecting to bootstrap nodes`, (m) => { console.info(m); });
                    this.opStack.pushFirst('syncWithPeers', null);
                    return peerCount;
                }

                this.miniLogger.log(`Waiting for ${nbOfPeers} peer${nbOfPeers !== 1 ? 's' : ''}, currently connected to ${peerCount} peer${peerCount !== 1 ? 's' : ''}`, (m) => { console.info(m); });
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            this.miniLogger.log(`Failed to connect to ${nbOfPeers} peers within ${maxAttempts} attempts`, (m) => { console.error(m); });
            return 0;
        };

        const result = await Promise.race([
            attemptConnection(),
            new Promise((resolve) => setTimeout(() => resolve(0), timeOut))
        ]);

        if (result < nbOfPeers) { this.miniLogger.log(`Failed to connect to ${nbOfPeers} peers within ${timeOut / 1000} seconds`, (m) => { console.error(m); }); }
        return result;
    }
    async createBlockCandidateAndBroadcast() {
        this.blockchainStats.state = "creating block candidate";
        try {
            if (!this.roles.includes('validator')) { throw new Error('Only validator can create a block candidate'); }

            this.blockCandidate = await this.#createBlockCandidate();
            if (this.blockCandidate === null) { return true; }
            if (this.roles.includes('miner')) { this.miner.updateBestCandidate(this.blockCandidate); }

            await this.p2pBroadcast('new_block_candidate', this.blockCandidate);
            return true;
        } catch (error) { this.miniLogger.log(error, (m) => { console.error(m); }); return false; }
    }
    //#endregion °°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°

    //#region - SNAPSHOT: LOAD/SAVE ---------------------------------------------------------------
    async loadSnapshot(snapshotIndex = 0, eraseHigher = true) {
        if (snapshotIndex < 0) { return; }

        this.miniLogger.log(`Last known snapshot index: ${snapshotIndex}`, (m) => { console.warn(m); });
        this.blockchain.currentHeight = snapshotIndex;
        this.blockCandidate = null;
        await this.snapshotSystem.rollBackTo(snapshotIndex, this.utxoCache, this.vss, this.memPool);

        this.miniLogger.log(`Snapshot loaded: ${snapshotIndex}`, (m) => { console.warn(m); });
        if (snapshotIndex < 1) { await this.blockchain.eraseEntireDatabase(); }

        this.blockchain.lastBlock = await this.blockchain.getBlockByHeight(snapshotIndex);
        if (!eraseHigher) { return; }

        // place snapshot to trash folder, we can restaure it if needed
        this.snapshotSystem.eraseSnapshotsHigherThan(snapshotIndex - 1);
    }
    /** @param {BlockData} finalizedBlock */
    async #saveSnapshot(finalizedBlock) {
        if (finalizedBlock.index === 0) { return; }
        if (finalizedBlock.index % this.snapshotSystem.snapshotHeightModulo !== 0) { return; }
        const eraseUnder = this.snapshotSystem.snapshotHeightModulo * this.snapshotSystem.snapshotToConserve;

        // erase the outdated blocks cache and persist the addresses transactions references to disk
        const cacheErasable = this.blockchain.erasableCacheLowerThan(finalizedBlock.index - (eraseUnder - 1));
        if (cacheErasable !== null && cacheErasable.from < cacheErasable.to) {
            await this.blockchain.persistAddressesTransactionsReferencesToDisk(this.memPool, cacheErasable.from, cacheErasable.to);
            this.blockchain.eraseCacheFromTo(cacheErasable.from, cacheErasable.to);
        }

        await this.snapshotSystem.newSnapshot(this.utxoCache, this.vss, this.memPool);
        this.snapshotSystem.eraseSnapshotsLowerThan(finalizedBlock.index - eraseUnder);
        // avoid gap between the loaded snapshot and the new one
        // at this stage we know that the loaded snapshot is consistent with the blockchain
        if (this.snapshotSystem.loadedSnapshotHeight < finalizedBlock.index - (eraseUnder*2)) {
            this.snapshotSystem.loadedSnapshotHeight = 0;
        }
        this.snapshotSystem.restoreLoadedSnapshot();
    }
    //#endregion °°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°

    //#region - BLOCK HANDLING --------------------------------------------------------------------
    /** @param {BlockData} finalizedBlock */
    async #validateBlockProposal(finalizedBlock, blockBytes) {
        const timer = new BlockValidationTimer(), validatorId = finalizedBlock.Txs[1].outputs[0].address.slice(0, 6), minerId = finalizedBlock.Txs[0].outputs[0].address.slice(0, 6);
        this.blockchainStats.state = "validating block";
        timer.startPhase('total-validation');
        
        try { timer.startPhase('block-index-check'); BlockValidation.checkBlockIndexIsNumber(finalizedBlock); timer.endPhase('block-index-check'); }
        catch (error) { this.miniLogger.log(`#${finalizedBlock.index} -> ${error.message} Miner: ${minerId} | Validator: ${validatorId}`, (m) => { console.error(m); }); throw error; }

        timer.startPhase('miner-hash');
        const { hex, bitsArrayAsString } = await BlockUtils.getMinerHash(finalizedBlock, this.useDevArgon2);
        if (finalizedBlock.hash !== hex) throw new Error(`!banBlock! !applyOffense! Invalid pow hash (not corresponding): ${finalizedBlock.hash} - expected: ${hex}`);
        timer.endPhase('miner-hash');
    
        try {
            timer.startPhase('height-timestamp-hash');
            [BlockValidation.validateBlockIndex(finalizedBlock, this.blockchain.currentHeight), 
             BlockValidation.validateBlockHash(finalizedBlock, this.blockchain.lastBlock),
             BlockValidation.validateTimestamps(finalizedBlock, this.blockchain.lastBlock, this.timeSynchronizer.getCurrentTime())];
            timer.endPhase('height-timestamp-hash');
            
            timer.startPhase('legitimacy'); await BlockValidation.validateLegitimacy(finalizedBlock, this.vss); timer.endPhase('legitimacy');
        } catch (error) { this.miniLogger.log(`#${finalizedBlock.index} -> ${error.message} ~ Miner: ${minerId} | Validator: ${validatorId}`, (m) => { console.error(m); }); throw error; }

        timer.startPhase('difficulty-check');
        const hashConfInfo = mining.verifyBlockHashConformToDifficulty(bitsArrayAsString, finalizedBlock);
        if (!hashConfInfo.conform) throw new Error(`!banBlock! !applyOffense! Invalid pow hash (difficulty): ${finalizedBlock.hash} -> ${hashConfInfo.message}`);
        timer.endPhase('difficulty-check');
    
        timer.startPhase('rewards-validation');
        const expectedCoinBase = mining.calculateNextCoinbaseReward(this.blockchain.lastBlock || finalizedBlock);
        if (finalizedBlock.coinBase !== expectedCoinBase) throw new Error(`!banBlock! !applyOffense! Invalid #${finalizedBlock.index} coinbase: ${finalizedBlock.coinBase} - expected: ${expectedCoinBase}`);
        const { powReward, posReward, totalFees } = await BlockUtils.calculateBlockReward(this.utxoCache, finalizedBlock);
        try { await BlockValidation.areExpectedRewards(powReward, posReward, finalizedBlock); } 
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
        this.blockchainStats.state = "idle";
        if (this.logValidationTime){ timer.displayResults();}
    
        return { hashConfInfo, powReward, posReward, totalFees, allDiscoveredPubKeysAddresses };
    }
    /**
     * @param {BlockData} finalizedBlock
     * @param {Object} [options] - Configuration options for the blockchain.
     * @param {boolean} [options.skipValidation] - default: false
     * @param {boolean} [options.broadcastNewCandidate] - default: true
     * @param {boolean} [options.isSync] - default: false
     * @param {boolean} [options.isLoading] - default: false
     * @param {boolean} [options.persistToDisk] - default: true
     * @param {boolean} [options.storeAsFiles] - default: false
     */
    async digestFinalizedBlock(finalizedBlock, options = {}, byteLength) {
        const timer = new BlockDigestionTimer();
        this.blockchainStats.state = "digesting finalized block";
        if (this.restartRequested) return;
    
        timer.startPhase('initialization');
        const blockBytes = byteLength || serializer.block_finalized.toBinary_v4(finalizedBlock).byteLength;
        const { skipValidation = false, broadcastNewCandidate = true, isSync = false, isLoading = false, persistToDisk = true, storeAsFiles = false } = options;
        if (!finalizedBlock || !this.roles.includes('validator') || (this.syncHandler.isSyncing && !isSync)) 
            throw new Error(!finalizedBlock ? 'Invalid block candidate' : !this.roles.includes('validator') ? 'Only validator can process PoW block' : "Node is syncing, can't process block");
        timer.endPhase('initialization');
    
        let validationResult, hashConfInfo = false, totalFees;
        if (!skipValidation) {
            timer.startPhase('block-validation');
            validationResult = await this.#validateBlockProposal(finalizedBlock, blockBytes);
            hashConfInfo = validationResult.hashConfInfo;
            if (!hashConfInfo?.conform) throw new Error('Failed to validate block');
            timer.endPhase('block-validation');
        }
    
        timer.startPhase('add-confirmed-block');
        if (!skipValidation && !hashConfInfo?.conform) throw new Error('Failed to validate block');
        const blockInfo = await this.blockchain.addConfirmedBlocks(this.utxoCache, [finalizedBlock], persistToDisk, this.wsCallbacks.onBlockConfirmed, totalFees);
        timer.endPhase('add-confirmed-block');
    
        timer.startPhase('apply-blocks'),
        await this.blockchain.applyBlocks(this.utxoCache, this.vss, [finalizedBlock], this.roles.includes('observer')),
        timer.endPhase('apply-blocks'),
        timer.startPhase('mempool-cleanup'),
        this.memPool.removeFinalizedBlocksTransactions([finalizedBlock]),
        timer.endPhase('mempool-cleanup');
    
        timer.startPhase('block-storage');
        if (!skipValidation && this.wsCallbacks.onBlockConfirmed) this.wsCallbacks.onBlockConfirmed.execute(blockInfo);
        if (storeAsFiles) this.#storeConfirmedBlock(finalizedBlock);
        timer.endPhase('block-storage');
    
        if (blockBytes > 102_400 && !skipValidation) {
            this.miniLogger.log(`#${finalizedBlock.index} blockBytes: ${blockBytes} | Txs: ${finalizedBlock.Txs.length} | digest: ${timer.getTotalTime()}s`, (m) => { console.info(m); });
            if (this.logValidationTime){ timer.displayResults();}
        }
    
        const timeBetweenPosPow = ((finalizedBlock.timestamp - finalizedBlock.posTimestamp) / 1000).toFixed(2),
              minerId = finalizedBlock.Txs[0].outputs[0].address.slice(0, 6),
              validatorId = finalizedBlock.Txs[1].outputs[0].address.slice(0, 6);
    
        if (!isLoading && !isSync) {
            this.miniLogger.log(`#${finalizedBlock.index} -> validator: ${validatorId} | miner: ${minerId}
( diff: ${hashConfInfo.difficulty} + timeAdj: ${hashConfInfo.timeDiffAdjustment} + leg: ${hashConfInfo.legitimacy} ) = finalDiff: ${hashConfInfo.finalDifficulty} | 
z: ${hashConfInfo.zeros} | a: ${hashConfInfo.adjust} | gap_PosPow: ${timeBetweenPosPow}s | digest: ${timer.getTotalTime()}s`, (m) => { console.info(m); });
        }
    
        timer.startPhase('snapshot-and-peer-wait');
        if (!isLoading) await this.#saveSnapshot(finalizedBlock);
        const waitStart = Date.now();
        const nbOfPeers = await this.#waitSomePeers();
        if (!nbOfPeers || nbOfPeers < 1) { this.miniLogger.log('Failed to connect to peers, stopping the node', (m) => { console.error(m); }); return; }
        timer.endPhase('snapshot-and-peer-wait');
    
        if (!broadcastNewCandidate) return true;
    
        timer.startPhase('candidate-creation');
        this.blockCandidate = await this.#createBlockCandidate();
        if (this.blockCandidate === null) return true;
        if (this.roles.includes('miner')) this.miner.updateBestCandidate(this.blockCandidate);
        timer.endPhase('candidate-creation');
    
        setTimeout(async () => {
            try {
                if (!this.blockCandidate) throw new Error('No block candidate to broadcast');
                await this.p2pBroadcast('new_block_candidate', this.blockCandidate);
                if (this.wsCallbacks.onBroadcastNewCandidate) 
                    this.wsCallbacks.onBroadcastNewCandidate.execute(BlockUtils.getBlockHeader(this.blockCandidate));
            } catch (error) {
                this.miniLogger.log(`Failed to broadcast new block candidate: ${error.message}`, (m) => { console.error(m); });
            }
        }, Math.max(0, this.delayBeforeSendingCandidate - (Date.now() - waitStart)));
    
        return true;
    }
    /** Aggregates transactions from mempool, creates a new block candidate, signs it and returns it */
    async #createBlockCandidate() {
        const startTime = Date.now();

        const Txs = await this.memPool.getMostLucrativeTransactionsBatch(this.utxoCache);
        const posTimestamp = this.blockchain.lastBlock ? this.blockchain.lastBlock.timestamp + 1 : this.timeSynchronizer.getCurrentTime();

        // Create the block candidate, genesis block if no lastBlockData
        let blockCandidate = BlockData(0, 0, BLOCKCHAIN_SETTINGS.blockReward, 27, 0, '0000000000000000000000000000000000000000000000000000000000000000', Txs, posTimestamp);
        if (this.blockchain.lastBlock) {
            await this.vss.calculateRoundLegitimacies(this.blockchain.lastBlock.hash);
            const myLegitimacy = this.vss.getAddressLegitimacy(this.account.address);
            if (myLegitimacy === undefined) { throw new Error(`No legitimacy for ${this.account.address}, can't create a candidate`); }
            if (myLegitimacy > this.vss.maxLegitimacyToBroadcast) { return null; }

            const olderBlock = await this.blockchain.getBlockByHeight(this.blockchain.lastBlock.index - MINING_PARAMS.blocksBeforeAdjustment);
            const averageBlockTimeMS = mining.calculateAverageBlockTime(this.blockchain.lastBlock, olderBlock);
            this.blockchainStats.averageBlockTime = averageBlockTimeMS;
            const newDifficulty = mining.difficultyAdjustment(this.blockchain.lastBlock, averageBlockTimeMS);
            const coinBaseReward = mining.calculateNextCoinbaseReward(this.blockchain.lastBlock);
            blockCandidate = BlockData(this.blockchain.lastBlock.index + 1, this.blockchain.lastBlock.supply + this.blockchain.lastBlock.coinBase, coinBaseReward, newDifficulty, myLegitimacy, this.blockchain.lastBlock.hash, Txs, posTimestamp);
        }

        // Sign the block candidate
        const { powReward, posReward } = await BlockUtils.calculateBlockReward(this.utxoCache, blockCandidate);
        const posFeeTx = await Transaction_Builder.createPosReward(posReward, blockCandidate, this.validatorRewardAddress, this.account.address);
        const signedPosFeeTx = await this.account.signTransaction(posFeeTx);
        blockCandidate.Txs.unshift(signedPosFeeTx);
        blockCandidate.powReward = powReward; // for the miner

        if (blockCandidate.Txs.length > 3) { this.miniLogger.log(`(Height:${blockCandidate.index}) => ${blockCandidate.Txs.length} txs, block candidate created in ${(Date.now() - startTime)}ms`, (m) => { console.info(m); }); }
        this.blockchainStats.lastLegitimacy = blockCandidate.legitimacy;
        return blockCandidate;
    }
    /** @param {BlockData} blockData */
    #storeConfirmedBlock(blockData) {
        if (blockData.index >= 1000) { return; }
        // save the block in local storage definitively
        const clone = BlockUtils.cloneBlockData(blockData); // clone to avoid modification
        localStorage_v1.saveBlockDataLocally(this.id, clone, 'json');
        localStorage_v1.saveBlockDataLocally(this.id, clone, 'bin');
    } // Used by developer to check the block data manually
    //#endregion °°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°

    /** @param {string} topic @param {object} message */
    async p2pHandler(topic, message) {
        // test fork

        // { content: parsedMessage, from, byteLength }
        const data = message.content;

        const from = message.from;
        const byteLength = message.byteLength;
        //console.log(`[P2P-HANDLER] ${topic} -> ${from} | ${byteLength} bytes`);
        try {
            switch (topic) {
                case 'new_transaction':
                    if (this.syncHandler.isSyncing || this.opStack.syncRequested) { return; }
                    if (!this.roles.includes('validator')) { break; }
                    this.opStack.push('pushTransaction', {
                        byteLength,
                        utxoCache: this.utxoCache,
                        transaction: data // signedTransaction
                    });
                    break;
                case 'new_block_candidate':
                    try { BlockValidation.checkBlockIndexIsNumber(data); } catch (error) { throw error; }

                    if (this.ignoreIncomingBlocks) { return; }
                    if (!this.roles.includes('miner')) { break; }
                    if (!this.roles.includes('validator')) { break; }

                    const lastBlockIndex = this.blockchain.lastBlock ? this.blockchain.lastBlock.index : -1;
                    if (this.miner.highestBlockIndex > data.index) { // avoid processing old blocks
                        this.miniLogger.log(`highest #${this.miner.highestBlockIndex} > #${data.index} -> skip`, (m) => { console.info(m); });
                        return;
                    }
                    if (lastBlockIndex +1 > data.index) {
                        this.miniLogger.log(`lastBlockIndex #${lastBlockIndex} +1 > #${data.index} -> skip`, (m) => { console.info(m); });
                        return;
                    }
                    if (lastBlockIndex +1 < data.index) {
                        this.miniLogger.log(`lastBlockIndex #${lastBlockIndex} +1 < #${data.index} -> skip`, (m) => { console.info(m); });
                        return;
                    }

                    await this.vss.calculateRoundLegitimacies(data.hash);
                    const validatorAddress = data.Txs[0].inputs[0].split(':')[0];
                    const validatorLegitimacy = this.vss.getAddressLegitimacy(validatorAddress);
                    if (validatorLegitimacy !== data.legitimacy) {
                        this.miniLogger.log(`${topic} -> #${data.index} -> Invalid legitimacy!`, (m) => { console.info(m); });
                        return;
                    }

                    this.miner.updateBestCandidate(data);
                    break;
                case 'new_block_finalized':
                    try { BlockValidation.checkBlockIndexIsNumber(data); } catch (error) { throw error; }
                    if (this.ignoreIncomingBlocks) { return; }
                    if (this.syncHandler.isSyncing || this.opStack.syncRequested) { return; }

                    if (!this.roles.includes('validator')) { break; }
                    if (this.reorganizator.isFinalizedBlockInCache(message.content)) {
                        this.miniLogger.log(`Already processed ${topic} #${message.content.index} -> skip`, (m) => { console.warn(m); });
                        return;
                    }
                    this.opStack.push('digestPowProposal', message);
                    break;
                case 'test':
                    this.miniLogger.log(`[TEST] heavy msg bytes: ${new Uint8Array(Object.values(data)).length}`, (m) => { console.warn(m); });
                    break;
                default:
                    this.miniLogger.log(`Unknown topic ${topic}`, (m) => { console.error(m); });
            }
        } catch (error) { this.miniLogger.log(`${topic} -> Failed! ${error}`, (m) => { console.error(m); }); }
    }
    /** @param {string} topic @param {any} message */
    async p2pBroadcast(topic, message) {
        await this.p2pNetwork.broadcast(topic, message);
        if (topic !== 'new_block_finalized') { return; }

        setTimeout(() => this.#reSendBlocks(message.index), 1000);
    }
    async #reSendBlocks(finalizedBlockHeight = 10) {
        const sequence = [-10, -8, -6, -4, -2];
        const sentSequence = [];
        const blocksToReSendPromises = [];
        for (const index of sequence) {
            blocksToReSendPromises.push(this.blockchain.getBlockByHeight(finalizedBlockHeight + index));
        }
        for (const blockPromise of blocksToReSendPromises) {
            const block = await blockPromise;
            if (!block) { continue; }
            await new Promise(resolve => setTimeout(resolve, 400));
            await this.p2pNetwork.broadcast('new_block_finalized', block);
            sentSequence.push(block.index);
        }
        this.miniLogger.log(`[NODE-${this.id.slice(0, 6)}] Re-sent blocks: [${sentSequence.join(', ')}]`, (m) => { console.info(m); });
    }
    //#region - API -------------------------------------------------------------------------------
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
    async getBlocksInfo(fromHeight = 0, toHeight = 10) {
        try {
            if (fromHeight > toHeight) { throw new Error(`Invalid range: ${fromHeight} > ${toHeight}`); }
            //if (toHeight - fromHeight > 10) { throw new Error('Cannot retrieve more than 10 blocks at once'); }

            /** @type {BlockInfo[]} */
            const blocksInfo = [];
            for (let i = fromHeight; i <= toHeight; i++) {
                const blockInfo = await this.blockchain.getBlockInfoFromDiskByHeight(i);
                blocksInfo.push(blockInfo);
            }

            return blocksInfo;
        } catch (error) { this.miniLogger.log(error, (m) => { console.error(m); }); return []; }
    }
    async getExhaustiveBlocksDataByHeight(fromHeight = 0, toHeight = null) {
        try {
            toHeight = toHeight || fromHeight;
            if (fromHeight > toHeight) { throw new Error(`Invalid range: ${fromHeight} > ${toHeight}`); }
            //if (toHeight - fromHeight > 10) { throw new Error('Cannot retrieve more than 10 blocks at once'); }

            /** @type {BlockData[]} */
            const blocksData = [];
            for (let i = fromHeight; i <= toHeight; i++) {
                const blockData = await this.blockchain.getBlockByHeight(i);
                const blockInfo = await this.blockchain.getBlockInfoFromDiskByHeight(i);

                blocksData.push(this.#exhaustiveBlockFromBlockDataAndInfo(blockData, blockInfo));
            }

            return blocksData;
        } catch (error) { this.miniLogger.log(error, (m) => { console.error(m); }); return []; }
    }
    async getExhaustiveBlockDataByHash(hash) {
        try {
            const blockData = await this.blockchain.getBlockByHash(hash);
            const blockInfo = await this.blockchain.getBlockInfoFromDiskByHeight(blockData.index);

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
    async getAddressExhaustiveData(address, from = 0, to = this.blockchain.currentHeight) {
        const addressTxsReferences = await this.blockchain.getTxsReferencesOfAddress(this.memPool, address, from, to);
        const addressUTXOs = await this.getAddressUtxos(address);
        return { addressUTXOs, addressTxsReferences };
    }
    /** @param {string} txReference - ex: 12:0f0f0f @param {string} address - optional: also return balanceChange for this address */
    async getTransactionByReference(txReference, address = undefined) {
        try {
            if (address) { addressUtils.conformityCheck(address); }
            const result = { transaction: undefined, balanceChange: 0, inAmount: 0, outAmount: 0, fee: 0 };
            const transaction = await this.blockchain.getTransactionByReference(txReference);
            result.transaction = transaction;
            if (address === undefined) { return result; }

            for (const output of transaction.outputs) {
                result.outAmount += output.amount;
                if (output.address === address) { result.balanceChange += output.amount; }
            }

            for (const anchor of transaction.inputs) {
                if (!typeValidation.isConformAnchor(anchor)) { continue; }
                const txRef = `${anchor.split(":")[0]}:${anchor.split(":")[1]}`;
                const utxoRelatedTx = await this.blockchain.getTransactionByReference(txRef);
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
    async getAddressUtxos(address) {
        const addressAnchors = this.utxoCache.getAddressAnchorsArray(address);
        let spendableBalance = 0;
        let balance = 0;
        const UTXOs = [];
        for (const anchor of addressAnchors) {
            const associatedMemPoolTx = this.memPool.transactionByAnchor[anchor];
            if (associatedMemPoolTx) { continue; } // pending spent UTXO

            const utxo = await this.utxoCache.getUTXO(anchor);
            if (!utxo) { this.miniLogger.log(`UTXO not removed from AddressAnchors: ${anchor}`, (m) => { console.error(m); }); continue; } // should not happen
            if (utxo.spent) { this.miniLogger.log(`UTXO spent but not removed from AddressAnchors: ${anchor}`, (m) => { console.error(m); }); continue; } // should not happen

            balance += utxo.amount;
            UTXOs.push(utxo);

            if (utxo.rule === "sigOrSlash") { continue; }
            spendableBalance += utxo.amount;
        }

        return { spendableBalance, balance, UTXOs };
    }
    async getAddressUtxosOnly(address) {
        const addressAnchors = this.utxoCache.getAddressAnchorsArray(address);
        const UTXOs = [];
        for (const anchor of addressAnchors) {
            const associatedMemPoolTx = this.memPool.transactionByAnchor[anchor];
            if (associatedMemPoolTx) { continue; } // pending spent UTXO

            const utxo = await this.utxoCache.getUTXO(anchor);
            if (!utxo) { this.miniLogger.log(`UTXO not removed from AddressAnchors: ${anchor}`, (m) => { console.error(m); }); continue; } // should not happen
            if (utxo.spent) { this.miniLogger.log(`UTXO spent but not removed from AddressAnchors: ${anchor}`, (m) => { console.error(m); }); continue; } // should not happen

            UTXOs.push(utxo);
        }
        return UTXOs;
    }

    //#endregion °°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°
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