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
 * @typedef {Object} SyncRequest
 * @property {string} type - 'getStatus' | 'getBlocks' | 'getCheckpoint'
 * @property {number?} startIndex - Only for 'getBlocks'
 * @property {number?} endIndex - Only for 'getBlocks'
 * @property {string?} checkpointHash - Only for 'getCheckpoint' -> hash of the checkpoint zip archive
 * @property {number?} bytesStart - start byte of the serialized data to continue uploading
 * 
 * @typedef {Object} CheckpointInfo
 * @property {number} height
 * @property {string} hash
 * 
 * @typedef {Object} SyncStatus
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {CheckpointInfo} checkpointInfo
 * 
 * @typedef {Object} PeerStatus
 * @property {string} peerIdStr
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {CheckpointInfo | null} checkpointInfo
 * 
 * @typedef {Object} Consensus
 * @property {number} height
 * @property {number} peers
 * @property {string} blockHash
 * @property {CheckpointInfo | false} checkpointInfo
 */

export class SyncHandler {
    /** @type {P2PNetwork} */
    p2pNet;
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
        node.p2pNetwork.p2pNode.handle(P2PNetwork.SYNC_PROTOCOL, this.#handleIncomingStream.bind(this));
        this.node = node;
        this.p2pNet = node.p2pNetwork;
        this.miniLogger.log('SyncHandler setup', (m) => { console.info(m); });
    }

    async #handleIncomingStream(lstream) {
        if (this.node.restartRequested) { return; }
        /** @type {Stream} */
        const stream = lstream.stream;
        if (!stream) { return; }
        
        const peerIdStr = lstream.connection.remotePeer.toString();
        this.p2pNet.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);
        //this.miniLogger.log(`INCOMING STREAM (${lstream.connection.id}-${stream.id}) from ${readableId(peerIdStr)}`, (m) => { console.info(m); });
        
        try {
            const readResult = await P2PNetwork.streamRead(stream, this.fastConverter);
            if (!readResult) { throw new Error('Failed to read data from stream'); }

            /** @type {SyncRequest} */
            const msg = serializer.deserialize.rawData(readResult.data);
            if (!msg || typeof msg.type !== 'string') { throw new Error('Invalid message format'); }
            this.miniLogger.log(`Received message (type: ${msg.type}${msg.type === 'getBlocks' ? `: ${msg.startIndex}-${msg.endIndex}` : ''} | ${readResult.data.length} bytes, ${readResult.nbChunks} chunks) from ${readableId(peerIdStr)}`, (m) => { console.info(m); });
            
            /** @type {SyncStatus} */
            const mySyncStatus = {
                currentHeight: this.node.blockchain.currentHeight,
                latestBlockHash: this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000",
                checkpointInfo: this.node.checkpointSystem.myLastCheckpointInfo()
            }

            let data = new Uint8Array(0);
            if (msg.type === 'getBlocks' && typeof msg.startIndex === 'number' && typeof msg.endIndex === 'number') {
                /** @type {Uint8Array[]} */
                const serializedBlocksArray = this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false);
                if (!serializedBlocksArray) { throw new Error('Failed to get serialized blocks'); }
            
                data = serializer.serialize.rawData(serializedBlocksArray);
            }

            if (msg.type === 'getCheckpoint' && typeof msg.checkpointHash === 'string') {
                data = this.node.checkpointSystem.readCheckpointZipArchive(msg.checkpointHash);
                if (!data) { throw new Error('Checkpoint archive not found'); }
            }

            // crop data and add the length of the serialized data at the beginning of the response
            data = data.slice(msg.bytesStart || 0);
            const serializedResponse = serializer.serialize.syncResponse(mySyncStatus, data);
            await P2PNetwork.streamWrite(stream, serializedResponse);

            let logComplement = '';
            if (msg.type === 'getBlocks') logComplement = `: ${msg.startIndex}-${msg.endIndex}`;
            if (msg.type === 'getCheckpoint') logComplement = `: ${msg.checkpointHash}`;
            this.miniLogger.log(`Sent response to ${readableId(peerIdStr)} (type: ${msg.type}${logComplement}} | ${serializedResponse.length} bytes)`, (m) => { console.info(m); });
        } catch (err) {
            if (err.code !== 'ABORT_ERR') { this.miniLogger.log(err, (m) => { console.error(m); }); }
        }
    }
    /** @param {string} peerIdStr @param {SyncRequest} msg */
    async #sendSyncRequest(peerIdStr, msg, maxSuccessiveFailures = 5) {
        let peer = this.p2pNet.peers[peerIdStr];
        const syncRes = { currentHeight: 0, latestBlockHash: '', checkpointInfo: null, data: new Uint8Array(0) };
        const failures = { successive: 0, total: 0 };
        const dataBytes = { acquired: 0, expected: 0, percentage: 0 };

        while (true) { // Wait peer to be dialable at first...
            let waitingCount = 100;
            while (!peer || !peer.dialable) { // unreachable peer, timeout (100 * 100ms = 10s)
                peer = this.p2pNet.peers[peerIdStr];
                if (waitingCount <= 0) { return false; } else { waitingCount-- }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            
            try { // try to get the remaining data
                msg.bytesStart = dataBytes.acquired;
                const stream = await this.p2pNet.p2pNode.dialProtocol(peer.id, [P2PNetwork.SYNC_PROTOCOL], { negotiateFully: true });
                await P2PNetwork.streamWrite(stream, serializer.serialize.rawData(msg));

                const readResult = await P2PNetwork.streamRead(stream);
                if (!readResult) { throw new Error('Failed to read data from stream'); }
                if (!readResult.data.byteLength < serializer.syncResponseMinLen) throw new Error('Invalid response format');
                
                const syncResponse = serializer.deserialize.syncResponse(readResult.data);
                syncRes.currentHeight = syncResponse.currentHeight;
                syncRes.latestBlockHash = syncResponse.latestBlockHash;
                syncRes.checkpointInfo = syncResponse.checkpointInfo;

                if (!dataBytes.expected) { // initializing the data
                    dataBytes.expected = syncResponse.dataLength;
                    syncRes.data = new Uint8Array(dataBytes.expected);
                }
                
                if (result.data) { // filling the data
                    syncRes.data.set(syncResponse.data, dataBytes.acquired);
                    dataBytes.acquired += syncResponse.data.length;
                    dataBytes.percentage = (dataBytes.acquired / dataBytes.expected * 100).toFixed(2);
                }

                if (dataBytes.acquired > dataBytes.expected) throw new Error('Received more data than expected');
                if (dataBytes.acquired === dataBytes.expected) { break; } // all data acquired
                failures.successive = 0;
            } catch (err) {
               //this.node.updateState(`${msg.type }
                if (msg.type === 'getBlocks') { this.node.updateState(`Downloading blocks #${msg.startIndex}-${msg.endIndex}, ${dataBytes.percentage}%...`); }
                if (msg.type === 'getCheckpoint') { this.node.updateState(`Downloading checkpoint ${msg.checkpointHash.slice(0,10)}, ${dataBytes.percentage}%...`); }
                this.miniLogger.log(`(${msg.type}) ${dataBytes.acquired}/${dataBytes.expected}Bytes acquired (+${nbChunks} chunks - ${dataBytes.percentage}%`, (m) => { console.info(m); });
                if (err.code !== 'ABORT_ERR') { this.miniLogger.log(err, (m) => { console.error(m); }); }
                failures.successive++; failures.total++;
                if (failures.successive >= maxSuccessiveFailures) { return false; }
            }

            await new Promise((resolve) => setTimeout(resolve, 1000)); // then try again
        }

        return syncRes;
    }
    /** @param {string} peerIdStr @param {SyncRequest} msg */
    async #sendSyncRequestOLD(peerIdStr, msg) { // DEPRECATED
        const peer = this.p2pNet.peers[peerIdStr];
        if (!peer || !peer.dialable) { return false; }

        try {
            // Negotiate fully on possibly big messages, prevent backpressure
            const options = msg.type === 'getStatus' ? {} : { negotiateFully: true };
            const stream = await this.p2pNet.p2pNode.dialProtocol(peer.id, [P2PNetwork.SYNC_PROTOCOL], options);
            const serialized = serializer.serialize.rawData(msg);

            await P2PNetwork.streamWrite(stream, serialized);
            
            this.miniLogger.log(`Message written to stream, topic: ${msg.type} (${serialized.length} bytes)`, (m) => { console.info(m); });
            
            const peerResponse = await P2PNetwork.streamRead(stream);
            if (!peerResponse) { throw new Error('Failed to read data from stream'); }
            
            const { data, nbChunks } = peerResponse;
            this.miniLogger.log(`Message read from stream, topic: ${msg.type} (${data.length} bytes, ${nbChunks} chunks)`, (m) => { console.info(m); });
            
            /** @type {SyncResponse} */
            const response = serializer.deserialize.rawData(data);
            return response;
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
        //?await new Promise((resolve) => setTimeout(resolve, 5000));

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
        const peersToSync = Object.keys(this.p2pNet.peers);
        const msg = { type: 'getStatus' };
        const promises = [];
        for (const peerIdStr of peersToSync) {
            const peer = this.p2pNet.peers[peerIdStr];
            if (!peer || !peer.dialable) { return false; } // only try to sync status with dialable peers
            promises.push(this.#sendSyncRequest(peerIdStr, msg, 1));
        }

        /** @type {PeerStatus[]} */
        const peersStatus = [];
        for (const peerIdStr of peersToSync) {
            const response = await promises.shift();
            if (!response || typeof response.currentHeight !== 'number') { continue; }

            const { currentHeight, latestBlockHash, checkpointInfo } = response;
            peersStatus.push({ peerIdStr, currentHeight, latestBlockHash, checkpointInfo });
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
        const response = await this.#sendSyncRequest(peerIdStr, message);
        if (!response || response.data.byteLength === 0) {
            this.miniLogger.log(`Failed to get/read checkpoint archive`, (m) => { console.error(m); });
            return false;
        }

        Storage.unarchiveCheckpointBuffer(response.data, checkpointHash);
        const checkpointDetected = this.node.checkpointSystem.checkForActiveCheckpoint();
        if (!checkpointDetected) {
            this.miniLogger.log(`Failed to process checkpoint archive`, (m) => { console.error(m); });
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
        try {
            while (desiredBlock <= peerHeight) {
                let endIndex = Math.min(desiredBlock + this.MAX_BLOCKS_PER_REQUEST - 1, peerHeight);
                if (checkpointMode) { endIndex = Math.min(endIndex, activeCheckpointTargetHeight); }
    
                this.node.updateState(`Downloading blocks #${desiredBlock} to #${endIndex}...`);
                const message = { type: 'getBlocks', startIndex: desiredBlock, endIndex };
                const syncRes = await this.#sendSyncRequest(peerIdStr, message);
                if (!syncRes || syncRes.data.byteLength === 0) {
                    this.miniLogger.log(`'getBlocks ${desiredBlock}-${endIndex}' request failed`, (m) => { console.error(m); });
                    break;
                }
    
                const serializedBlocks = serializer.deserialize.rawData(syncRes.data);
                if (!serializedBlocks) { this.miniLogger.log(`Failed to get serialized blocks`, (m) => { console.error(m); }); break; }
                if (!Array.isArray(serializedBlocks)) { this.miniLogger.log(`Invalid serialized blocks format`, (m) => { console.error(m); }); break; }
                if (serializedBlocks.length === 0) { this.miniLogger.log(`No blocks received`, (m) => { console.error(m); }); break; }
                
                for (const serializedBlock of serializedBlocks) {
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
                }
    
                peerHeight = syncRes.currentHeight;
            }
        } catch (error) {
            this.miniLogger.log(`#getMissingBlocks() error occurred`, (m) => { console.error(m); });
            this.miniLogger.log(error, (m) => { console.error(m); });
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