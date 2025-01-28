import path from 'path';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { Storage } from '../../utils/storage-manager.mjs';
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
 * @typedef {Object} SyncRequest
 * @property {string} type - 'getStatus' | 'getBlocks' | 'getPubKeysAddresses'
 * @property {string?} pubKeysHash - Only for 'getPubKeysAddresses' -> 
 * @property {number?} startIndex
 * @property {number?} endIndex
 * 
 * @typedef {Object} SyncResponse
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {KnownPubKeysAddressesSnapInfo} knownPubKeysInfo
 * @property {Uint8Array[]?} blocks
 * @property {Uint8Array?} knownPubKeysAddresses
 * 
 * @typedef {Object} PeerStatus
 * @property {string} peerIdStr
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {KnownPubKeysAddressesSnapInfo} knownPubKeysInfo
 * 
 * @typedef {Object} Consensus
 * @property {number} height
 * @property {number} peers
 * @property {string} blockHash
 * @property {KnownPubKeysAddressesSnapInfo} knownPubKeysInfo
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

    async syncWithPeers() {
        if (this.syncDisabled) { return 'Already at the consensus height'; }

        this.miniLogger.log(`syncWithPeers started at #${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });
        this.node.blockchainStats.state = "syncing";
    
        const peersStatus = await this.#getAllPeersStatus();
        if (!peersStatus || peersStatus.length === 0) { return 'No peers available' }

        const consensus = this.#findConsensus(peersStatus);
        if (!consensus) { return await this.#handleSyncFailure(`Unable to get consensus -> sync failure`); }
        if (consensus.height <= this.node.blockchain.currentHeight) { return 'Already at the consensus height'; }
        
        this.miniLogger.log(`consensusHeight #${consensus.height}, current #${this.node.blockchain.currentHeight} -> getblocks from ${peersStatus.length} peers`, (m) => { console.info(m); });

        // try to sync the pubKeysAddresses if possible
        const myKnownPubKeysInfo = this.node.snapshotSystem.knownPubKeysAddressesSnapInfo;
        let syncPubKeysAddresses = true;
        if (myKnownPubKeysInfo.height > consensus.knownPubKeysInfo.height) { syncPubKeysAddresses = false; }
        if (myKnownPubKeysInfo.hash === consensus.knownPubKeysInfo.hash) { syncPubKeysAddresses = false; }
        if (syncPubKeysAddresses) {
            for (const peerStatus of peersStatus) {
                const { peerIdStr, knownPubKeysInfo } = peerStatus;
                if (knownPubKeysInfo.height !== consensus.knownPubKeysInfo.height) { continue; }
                if (knownPubKeysInfo.hash !== consensus.knownPubKeysInfo.hash) { continue; }                
                
                this.miniLogger.log(`Attempting to sync PubKeysAddresses with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
                const synchronized = await this.#getPubKeysAddresses(peerIdStr, knownPubKeysInfo.hash);
                if (!synchronized) { continue; }

                this.miniLogger.log(`Successfully synced PubKeysAddresses with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
                break;
            }
        }

        // sync the blocks
        for (const peerStatus of peersStatus) {
            const { peerIdStr, currentHeight, latestBlockHash } = peerStatus;
            if (latestBlockHash !== consensus.blockHash) { continue; } // Skip peers with different hash than consensus

            this.miniLogger.log(`Attempting to sync blocks with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
            const synchronized = await this.#getMissingBlocks(peerIdStr, currentHeight);
            if (!synchronized) { continue; }
            
            this.miniLogger.log(`Successfully synced blocks with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
            return 'Verifying consensus';
        }

        return await this.#handleSyncFailure('Unable to sync with any peer');
    }
    async #handleIncomingStream(lstream) {
        if (this.node.restartRequested) { return; }
        /** @type {Stream} */
        const stream = lstream.stream;
        if (!stream) { return; }
        
        const peerIdStr = lstream.connection.remotePeer.toString();
        this.miniLogger.log(`INCOMING STREAM (${lstream.connection.id}-${stream.id}) from ${readableId(peerIdStr)}`, (m) => { console.info(m); });
        this.node.p2pNetwork.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);
        
        try {
            const data = await P2PNetwork.streamRead(stream);
            /** @type {SyncRequest} */
            const msg = serializer.deserialize.rawData(data);
            if (!msg || typeof msg.type !== 'string') { throw new Error('Invalid message format'); }
            this.miniLogger.log(`Received message (type: ${msg.type}${msg.type === 'getBlocks' ? `: ${msg.startIndex}-${msg.endIndex}` : ''} | ${data.length} bytes) from ${readableId(peerIdStr)}`, (m) => { console.info(m); });
            
            /** @type {SyncResponse} */
            const response = {
                currentHeight: this.node.blockchain.currentHeight,
                /** @type {string} */
                latestBlockHash: this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000",
                knownPubKeysInfo: this.node.snapshotSystem.knownPubKeysAddressesSnapInfo,
            };

            if (msg.type === 'getBlocks' && typeof msg.startIndex === 'number' && typeof msg.endIndex === 'number') {
                response.blocks = this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false);
            }
            
            if (msg.type === 'getPubKeysAddresses' && typeof msg.pubKeysHash === 'string' && msg.pubKeysHash === this.node.snapshotSystem.knownPubKeysAddressesSnapInfo.hash) {
                const snapPath = path.join(this.node.snapshotSystem.__snapshotPath, String(this.node.snapshotSystem.knownPubKeysAddressesSnapInfo.height));
                const trashPath = path.join(this.node.snapshotSystem.__trashPath, String(this.node.snapshotSystem.knownPubKeysAddressesSnapInfo.height));
                response.knownPubKeysAddresses = Storage.loadBinary('memPool', snapPath) || Storage.loadBinary('memPool', trashPath);
            }

            const serialized = serializer.serialize.rawData(response);
            await stream.sink([serialized]);
            await stream.close();

            let logComplement = '';
            if (msg.type === 'getBlocks') logComplement = `: ${msg.startIndex}-${msg.endIndex}`;
            if (msg.type === 'getPubKeysAddresses') logComplement = `: ${msg.pubKeysHash}`;
            this.miniLogger.log(`Sent response to ${readableId(peerIdStr)} (type: ${msg.type}${logComplement}} | ${serialized.length} bytes)`, (m) => { console.info(m); });
        } catch (err) {
            if (err.code !== 'ABORT_ERR') { this.miniLogger.log(err, (m) => { console.error(m); }); }
        }
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

            const { currentHeight, latestBlockHash, knownPubKeysInfo } = response;
            peersStatus.push({ peerIdStr, currentHeight, latestBlockHash, knownPubKeysInfo });
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
            consensuses[height][blockHash] = consensuses[height][blockHash] ? consensuses[height][blockHash] + 1 : 1;

            if (consensuses[height][blockHash] <= consensus.peers) { continue; }

            consensus.height = height;
            consensus.peers = consensuses[height][blockHash];
            consensus.blockHash = blockHash;
        }

        const pubKeysConsensus = { peers: 0, knownPubKeysAddressesSnapInfo: { height: 0, hash: '' } };
        const pubKeysConsensuses = {};
        for (const peerStatus of peersStatus) {
            const {height, hash} = peerStatus.knownPubKeysInfo;
            if (!pubKeysConsensuses[height]) { pubKeysConsensuses[height] = {}; }
            pubKeysConsensuses[height][hash] = pubKeysConsensuses[height][hash] ? pubKeysConsensuses[height][hash] + 1 : 1;

            if (pubKeysConsensuses[height][hash] <= pubKeysConsensus.peers) { continue; }

            pubKeysConsensus.peers = pubKeysConsensuses[height][hash];
            pubKeysConsensus.knownPubKeysAddressesSnapInfo = peerStatus.knownPubKeysInfo;
        }

        consensus.knownPubKeysInfo = pubKeysConsensus.knownPubKeysAddressesSnapInfo;
        return consensus;
    }
    /** @param {string} peerIdStr @param {string} pubKeysHash */
    async #getPubKeysAddresses(peerIdStr, pubKeysHash) {
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
    /** @param {string} peerIdStr @param {number} peerCurrentHeight*/
    async #getMissingBlocks(peerIdStr, peerCurrentHeight) {
        this.node.blockchainStats.state = `syncing with peer ${readableId(peerIdStr)}`;
        this.miniLogger.log(`Synchronizing with peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
        
        let peerHeight = peerCurrentHeight;
        let desiredBlock = this.node.blockchain.currentHeight + 1;
        while (desiredBlock <= peerHeight) {
            const endIndex = Math.min(desiredBlock + this.MAX_BLOCKS_PER_REQUEST - 1, peerHeight);
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
                    await this.node.digestFinalizedBlock(block, { broadcastNewCandidate: false, isSync: true }, byteLength);
                    desiredBlock++;
                } catch (blockError) {
                    this.miniLogger.log(`Sync Error while processing block #${desiredBlock}`, (m) => { console.error(m); });
                    this.miniLogger.log(blockError, (m) => { console.error(m); });
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
        const snapshotsHeights = this.node.snapshotSystem.getSnapshotsHeights();
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