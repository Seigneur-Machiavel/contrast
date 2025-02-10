import path from 'path';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { Storage, PATH } from '../../utils/storage-manager.mjs';
import { FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { HashFunctions } from './conCrypto.mjs';
import { P2PNetwork, readableId } from './p2p.mjs';
import ReputationManager from './peers-reputation.mjs';

/**
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("@libp2p/interface").PeerId} PeerId
 * @typedef {import("@libp2p/interface").Stream} Stream
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
 *
 * @typedef {Object} KnownPubKeysAddressesSnapInfo
 * @property {number} height
 * @property {string} hash
 * 
 * @typedef {Object} CheckpointInfo
 * @property {number} height
 * @property {string} hash
 * 
 * @typedef {Object} SyncRequest
 * @property {string} type - 'getStatus' | 'getBlocks' | 'getPubKeysAddresses' | 'getCheckpoint'
 * @property {string?} pubKeysHash - Only for 'getPubKeysAddresses' -> hash of the knownPubKeysAddresses
 * @property {string?} checkpointHash - Only for 'getCheckpoint' -> hash of the checkpoint zip archive
 * @property {number?} startIndex
 * @property {number?} endIndex
 * 
 * @typedef {Object} SyncResponse
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {KnownPubKeysAddressesSnapInfo} knownPubKeysInfo
 * @property {CheckpointInfo?} checkpointInfo
 * @property {Uint8Array[]?} blocks
 * @property {Uint8Array?} knownPubKeysAddresses
 * @property {Uint8Array?} checkpointArchive
 * 
 * @typedef {Object} PeerStatus
 * @property {string} peerIdStr
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {KnownPubKeysAddressesSnapInfo | null} knownPubKeysInfo
 * @property {CheckpointInfo | null} checkpointInfo
 * 
 * @typedef {Object} Consensus
 * @property {number} height
 * @property {number} peers
 * @property {string} blockHash
 * @property {KnownPubKeysAddressesSnapInfo} knownPubKeysInfo
 * @property {CheckpointInfo | false} checkpointInfo
 */

export class SyncHandler {
    fastConverter = new FastConverter();
    isSyncing = false;
    syncDisabled = false;
    MAX_BLOCKS_PER_REQUEST = 100;
    /** @type {MiniLogger} */
    miniLogger = new MiniLogger('sync');
    /** @type {Object<string, number>} */
    peersHeights = {};
    syncFailureCount = 0;
    node;

    /** @param {Node} node */
    constructor(node) {
        this.node = node;
        this.node.p2pNetwork.p2pNode.handle(P2PNetwork.SYNC_PROTOCOL, this.#handleIncomingStream.bind(this));
        this.miniLogger.log('SyncHandler setup', (m) => { console.info(m); });
    }

    async #handleIncomingStream(lstream) {
        if (this.node.restartRequested) { return; }
        /** @type {Stream} */
        const stream = lstream.stream;
        if (!stream) { return; }
        
        const peerIdStr = lstream.connection.remotePeer.toString();
        //this.miniLogger.log(`INCOMING STREAM (${lstream.connection.id}-${stream.id}) from ${readableId(peerIdStr)}`, (m) => { console.info(m); });
        this.node.p2pNetwork.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);
        
        try {
            const peerRequest = await P2PNetwork.streamRead(stream);
            if (!peerRequest) { throw new Error('Failed to read data from stream'); }
            
            const { data, nbChunks } = peerRequest;

            /** @type {SyncRequest} */
            const msg = serializer.deserialize.rawData(data);
            if (!msg || typeof msg.type !== 'string') { throw new Error('Invalid message format'); }
            this.miniLogger.log(`Received message (type: ${msg.type}${msg.type === 'getBlocks' ? `: ${msg.startIndex}-${msg.endIndex}` : ''} | ${data.length} bytes, ${nbChunks} chunks) from ${readableId(peerIdStr)}`, (m) => { console.info(m); });
            
            /** @type {SyncResponse} */
            const response = {
                currentHeight: this.node.blockchain.currentHeight,
                /** @type {string} */
                latestBlockHash: this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000",
                // knownPubKeysInfo: this.node.snapshotSystem.knownPubKeysAddressesSnapInfo, //? DISABLED -> use checkpoints
                knownPubKeysInfo: { height: 0, hash: '' },
                checkpointInfo: this.node.checkpointSystem.myLastCheckpointInfo()
            };

            if (msg.type === 'getBlocks' && typeof msg.startIndex === 'number' && typeof msg.endIndex === 'number') {
                response.blocks = this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false);
            }
            
            if (msg.type === 'getPubKeysAddresses' && typeof msg.pubKeysHash === 'string' && msg.pubKeysHash === this.node.snapshotSystem.knownPubKeysAddressesSnapInfo.hash) {
                const snapPath = path.join(PATH.SNAPSHOTS, String(this.node.snapshotSystem.knownPubKeysAddressesSnapInfo.height));
                const trashPath = path.join(PATH.TRASH, String(this.node.snapshotSystem.knownPubKeysAddressesSnapInfo.height));
                response.knownPubKeysAddresses = Storage.loadBinary('memPool', snapPath) || Storage.loadBinary('memPool', trashPath);
            }

            if (msg.type === 'getCheckpoint' && typeof msg.checkpointHash === 'string') {
                response.checkpointArchive = this.node.checkpointSystem.readCheckpointZipArchive(msg.checkpointHash);
                if (!response.checkpointArchive) { throw new Error('Checkpoint archive not found'); }
            }

            const serialized = serializer.serialize.rawData(response);
            await P2PNetwork.streamWrite(stream, serialized);
            //await stream.close();

            let logComplement = '';
            if (msg.type === 'getBlocks') logComplement = `: ${msg.startIndex}-${msg.endIndex}`;
            if (msg.type === 'getPubKeysAddresses') logComplement = `: ${msg.pubKeysHash}`;
            this.miniLogger.log(`Sent response to ${readableId(peerIdStr)} (type: ${msg.type}${logComplement}} | ${serialized.length} bytes)`, (m) => { console.info(m); });
        } catch (err) {
            if (err.code !== 'ABORT_ERR') { this.miniLogger.log(err, (m) => { console.error(m); }); }
        }
    }
    async syncWithPeers() {
        if (this.syncDisabled) { return 'Already at the consensus height'; }

        const myCurrentHeight = this.node.blockchain.currentHeight;
        this.miniLogger.log(`syncWithPeers started at #${myCurrentHeight}`, (m) => { console.info(m); });
        this.node.blockchainStats.state = "syncing";
    
        const peersStatus = await this.#getAllPeersStatus();
        if (!peersStatus || peersStatus.length === 0) { return 'No peers available' }
        
        const consensus = this.#findConsensus(peersStatus);
        if (!consensus) { return await this.#handleSyncFailure(`Unable to get consensus -> sync failure`); }
        if (consensus.height <= myCurrentHeight) { return 'Already at the consensus height'; }
        
        this.miniLogger.log(`consensusCheckpoint #${consensus.checkpointInfo.height}`, (m) => { console.info(m); });
        // wait a bit before starting the sync, time for previous connections to be closed
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // try to sync by checkpoint at first
        const activeCheckpoint = this.node.checkpointSystem.activeCheckpointHeight !== false;
        const tryToSyncCheckpoint = myCurrentHeight + this.node.checkpointSystem.minGapTryCheckpoint < consensus.checkpointInfo.height;
        if (!activeCheckpoint && tryToSyncCheckpoint) {
            this.node.updateState(`syncing checkpoint #${consensus.checkpointInfo.height}...`); // can be long...
            for (const peerStatus of peersStatus) {
                const { peerIdStr, checkpointInfo } = peerStatus;
                if (checkpointInfo.height !== consensus.checkpointInfo.height) { continue; }
                if (checkpointInfo.hash !== consensus.checkpointInfo.hash) { continue; }

                this.miniLogger.log(`Attempting to sync checkpoint with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
                const success = await this.#getCheckpoint(peerIdStr, consensus.checkpointInfo.hash);
                if (!success) { continue; }
                
                this.miniLogger.log(`Successfully synced checkpoint with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
                return 'Checkpoint downloaded';
            }
        }

        // try to sync the pubKeysAddresses if possible (DEPRECATED -> use checkpoints)
        /*let syncPubKeysAddresses = true; //? DISABLED -> use checkpoints
        const myKnownPubKeysInfo = this.node.snapshotSystem.knownPubKeysAddressesSnapInfo;
        if (myKnownPubKeysInfo.height > consensus.knownPubKeysInfo.height) { syncPubKeysAddresses = false; }
        if (myKnownPubKeysInfo.hash === consensus.knownPubKeysInfo.hash) { syncPubKeysAddresses = false; }
        if (!activeCheckpoint && syncPubKeysAddresses) {
            for (const peerStatus of peersStatus) {
                const { peerIdStr, knownPubKeysInfo } = peerStatus;
                if (knownPubKeysInfo.height !== consensus.knownPubKeysInfo.height) { continue; }
                if (knownPubKeysInfo.hash !== consensus.knownPubKeysInfo.hash) { continue; }                
                
                this.miniLogger.log(`Attempting to sync PubKeysAddresses with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
                const synchronized = await this.#getPubKeysAddresses(peerIdStr, knownPubKeysInfo.hash);
                if (!synchronized) { continue; }

                this.miniLogger.log(`Successfully synced PubKeysAddresses with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
                return 'PubKeysAddresses downloaded';
            }
        }*/

        // sync the blocks
        this.miniLogger.log(`consensusHeight #${consensus.height}, current #${myCurrentHeight} -> getblocks from ${peersStatus.length} peers`, (m) => { console.info(m); });
        for (const peerStatus of peersStatus) {
            const { peerIdStr, currentHeight, latestBlockHash } = peerStatus;
            if (latestBlockHash !== consensus.blockHash) { continue; } // Skip peers with different hash than consensus

            this.miniLogger.log(`Attempting to sync blocks with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
            const synchronized = await this.#getMissingBlocks(peerIdStr, currentHeight);
            if (!synchronized) { continue; }

            if (synchronized === 'Checkpoint deployed') { return synchronized; }
            
            this.miniLogger.log(`Successfully synced blocks with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
            return 'Verifying consensus';
        }

        return await this.#handleSyncFailure('Unable to sync with any peer');
    }
    async #getAllPeersStatus() {
        const peersToSync = Object.keys(this.node.p2pNetwork.peers);
        const message = { type: 'getStatus' };
        const promises = [];
        for (const peerIdStr of peersToSync) { promises.push(this.node.p2pNetwork.sendSyncRequest(peerIdStr, message)); }

        /** @type {PeerStatus[]} */
        const peersStatus = [];
        for (const peerIdStr of peersToSync) {
            const response = await promises.shift();
            if (!response || typeof response.currentHeight !== 'number') { continue; }

            const { currentHeight, latestBlockHash, knownPubKeysInfo, checkpointInfo } = response;
            peersStatus.push({ peerIdStr, currentHeight, latestBlockHash, knownPubKeysInfo, checkpointInfo });
            this.peersHeights[peerIdStr] = currentHeight;
        }

        return peersStatus;
    }
    /** @param {PeerStatus[]} peersStatus */
    #findConsensus(peersStatus) {
        if (!peersStatus || peersStatus.length === 0) { return false }
        /** @type {Consensus} */
        const consensus = { height: 0, peers: 0, blockHash: '' };
        const consensuses = {};
        for (const peerStatus of peersStatus) {
            const height = peerStatus.currentHeight;
            const blockHash = peerStatus.latestBlockHash;

            if (!consensuses[height]) { consensuses[height] = {}; }
            const heightPeers = (consensuses[height][blockHash] || 0) + 1;
            consensuses[height][blockHash] = heightPeers;

            if (heightPeers <= consensus.peers) { continue; }

            consensus.height = height;
            consensus.peers = heightPeers;
            consensus.blockHash = blockHash;
        }

        const pubKeysConsensus = { peers: 0, knownPubKeysAddressesSnapInfo: { height: 0, hash: '' } };
        const pubKeysConsensuses = {};
        for (const peerStatus of peersStatus) {
            if (!peerStatus.knownPubKeysInfo) { continue; }
            const { height, hash } = peerStatus.knownPubKeysInfo;

            if (!pubKeysConsensuses[height]) { pubKeysConsensuses[height] = {}; }
            const pubKeysPeers = (pubKeysConsensuses[height][hash] || 0) + 1;
            pubKeysConsensuses[height][hash] = pubKeysPeers;

            if (pubKeysPeers <= pubKeysConsensus.peers) { continue; }

            pubKeysConsensus.peers = pubKeysPeers;
            pubKeysConsensus.knownPubKeysAddressesSnapInfo = peerStatus.knownPubKeysInfo;
        }
        consensus.knownPubKeysInfo = pubKeysConsensus.knownPubKeysAddressesSnapInfo;

        const checkpointConsensus = { peers: 0, checkpointInfo: { height: 0, hash: '' } };
        const checkpointConsensuses = {};
        for (const peerStatus of peersStatus) {
            //this.miniLogger.log(`Peer ${readableId(peerStatus.peerIdStr)} checkpointInfo #${peerStatus.checkpointInfo}`, (m) => { console.info(m); });
            if (!peerStatus.checkpointInfo) { continue; }
            const { height, hash } = peerStatus.checkpointInfo;
            if (height === 0) { continue; }

            if (!checkpointConsensuses[height]) { checkpointConsensuses[height] = {}; }
            const checkpointPeers = (checkpointConsensuses[height][hash] || 0) + 1;
            checkpointConsensuses[height][hash] = checkpointPeers;

            if (checkpointPeers <= checkpointConsensus.peers) { continue; }

            checkpointConsensus.peers = checkpointPeers;
            checkpointConsensus.checkpointInfo = { height, hash };
        }
        consensus.checkpointInfo = checkpointConsensus.checkpointInfo;
        
        return consensus;
    }
    /** @param {string} peerIdStr @param {string} checkpointHash */
    async #getCheckpoint(peerIdStr, checkpointHash) {
        const message = { type: 'getCheckpoint', checkpointHash };
        const response = await this.node.p2pNetwork.sendSyncRequest(peerIdStr, message);
        if (!response || !response.checkpointArchive) {
            this.miniLogger.log(`Failed to get/read checkpoint archive`, (m) => { console.error(m); });
            return false;
        }

        Storage.unarchiveCheckpointBuffer(response.checkpointArchive, checkpointHash);
        const checkpointDetected = this.node.checkpointSystem.checkForActiveCheckpoint();
        if (!checkpointDetected) {
            this.miniLogger.log(`Failed to process checkpoint archive`, (m) => { console.error(m); });
            return false;
        }

        return true;
    }
    /** @param {string} peerIdStr @param {string} pubKeysHash */
    async #getPubKeysAddresses(peerIdStr, pubKeysHash) { //? DEPRECATED -> use checkpoints
        const message = { type: 'getPubKeysAddresses', pubKeysHash };
        const response = await this.node.p2pNetwork.sendSyncRequest(peerIdStr, message);

        try {
            if (!response || !response.knownPubKeysInfo) { throw new Error('knownPubKeysInfo is not defined'); }
            if (typeof response.knownPubKeysInfo.height !== 'number') { throw new Error('knownPubKeysInfo.height is not a number'); }
            if (typeof response.knownPubKeysInfo.hash !== 'string') { throw new Error('knownPubKeysInfo.hash is not a string'); }
            if (!response.knownPubKeysAddresses) { throw new Error('knownPubKeysAddresses is missing'); }
            
            const hash = HashFunctions.xxHash32(response.knownPubKeysAddresses);
            if (pubKeysHash !== hash) { throw new Error('knownPubKeysAddresses hash mismatch'); }

            const knownPubKeysAddresses = serializer.deserialize.pubkeyAddressesObj(response.knownPubKeysAddresses);
            this.node.snapshotSystem.knownPubKeysAddressesSnapInfo = { height: response.knownPubKeysInfo.height, hash };
            this.node.memPool.knownPubKeysAddresses = knownPubKeysAddresses;
        } catch (error) {
            this.miniLogger.log(`Failed to process knownPubKeysAddresses`, (m) => { console.error(m); });
            this.miniLogger.log(error, (m) => { console.error(m); });
            return false;
        }

        return true;
    }
    /** @param {string} peerIdStr @param {number} peerCurrentHeight */
    async #getMissingBlocks(peerIdStr, peerCurrentHeight) {
        const activeCheckpointHeight = this.node.checkpointSystem.activeCheckpointHeight;
        const activeCheckpointTargetHeight = this.node.checkpointSystem.activeCheckpointLastSnapshotHeight;
        const checkpointMode = activeCheckpointHeight !== false && activeCheckpointTargetHeight !== false;

        this.node.blockchainStats.state = `syncing with peer ${readableId(peerIdStr)}${checkpointMode ? " (checkpointMode)" : ""}`;
        this.miniLogger.log(`Synchronizing with peer ${readableId(peerIdStr)}${checkpointMode ? " (checkpointMode)" : ""}`, (m) => { console.info(m); });

        let peerHeight = peerCurrentHeight;
        let desiredBlock = (checkpointMode ? activeCheckpointHeight : this.node.blockchain.currentHeight) + 1;
        while (desiredBlock <= peerHeight) {
            let endIndex = Math.min(desiredBlock + this.MAX_BLOCKS_PER_REQUEST - 1, peerHeight);
            if (checkpointMode) { endIndex = Math.min(endIndex, activeCheckpointTargetHeight); }

            this.node.updateState(`Downloading blocks #${desiredBlock} to #${endIndex}...`);
            const message = { type: 'getBlocks', startIndex: desiredBlock, endIndex };
            const response = await this.node.p2pNetwork.sendSyncRequest(peerIdStr, message);
            if (!response || typeof response.currentHeight !== 'number' || !Array.isArray(response.blocks)) {
                this.miniLogger.log(`'getBlocks ${desiredBlock}-${endIndex}' request failed`, (m) => { console.error(m); });
                break;
            }

            const serializedBlocks = response.blocks;
            if (!serializedBlocks) { this.miniLogger.log(`Failed to get serialized blocks`, (m) => { console.error(m); }); break; }
            if (serializedBlocks.length === 0) { this.miniLogger.log(`No blocks received`, (m) => { console.error(m); }); break; }
            
            for (const serializedBlock of serializedBlocks) {
                try {
                    const byteLength = serializedBlock.byteLength;
                    const block = serializer.deserialize.block_finalized(serializedBlock);
                    if (checkpointMode) {
                        this.node.updateState(`Fills checkpoint's block #${block.index}/${activeCheckpointTargetHeight}...`);
                        this.miniLogger.log(`Fills checkpoint's block #${block.index}/${activeCheckpointTargetHeight}...`, (m) => { console.info(m); });
                        await this.node.checkpointSystem.fillActiveCheckpointWithBlock(block, serializedBlock); // throws if failure
                    } else {
                        await this.node.digestFinalizedBlock(block, { broadcastNewCandidate: false, isSync: true }, byteLength); // throws if failure
                    }

                    if (activeCheckpointTargetHeight === block.index) {
                        this.node.updateState(`Deploying checkpoint #${this.node.checkpointSystem.activeCheckpointHeight}...`); // can be long...
                        this.node.checkpointSystem.deployActiveCheckpoint(); // throws if failure
                        return 'Checkpoint deployed';
                    }

                    desiredBlock++;
                } catch (blockError) {
                    this.miniLogger.log(`Sync Error while processing block #${desiredBlock}`, (m) => { console.error(m); });
                    this.miniLogger.log(blockError.message, (m) => { console.error(m); });
                    return false;
                }
            }

            peerHeight = response.currentHeight;
        }

        return peerHeight === this.node.blockchain.currentHeight;
    }
    async #handleSyncFailure(message = '') {
        this.syncFailureCount++;
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // METHOD 1: try to sync from snapshots
        // if syncFailureCount is a multiple of 10, try to sync from snapshots
        const snapshotsHeights = this.node.snapshotSystem.mySnapshotsHeights();
        if (this.syncFailureCount % 10 === 0 && snapshotsHeights.length > 0) {
            const modulo = (this.syncFailureCount / 10) % snapshotsHeights.length;
            const previousSnapHeight = snapshotsHeights[snapshotsHeights.length - 1 - modulo];
            this.node.loadSnapshot(previousSnapHeight, false); // non-destructive
        }

        // METHOD 2: restart the node
        // if syncFailureCount is a multiple of 25, restart the node
        if (this.syncFailureCount % 25 === 0) {
            this.miniLogger.log(`Restarting the node after ${this.syncFailureCount} sync failures`, (m) => { console.error(m); });
            this.node.restartRequested = 'syncFailure (this.syncFailureCount % 25)';
            return message;
        }

        //this.miniLogger.log('Sync failure occurred, restarting sync process', (m) => { console.error(m); });
        return message;
    }
}