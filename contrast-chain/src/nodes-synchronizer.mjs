import pino from 'pino';
import utils from './utils.mjs';
import P2PNetwork from './p2p.mjs';
import * as lp from 'it-length-prefixed';
import { multiaddr } from '@multiformats/multiaddr';
import ReputationManager from './peers-reputation.mjs';
import { Logger } from '../plugins/logger.mjs';
import { BlockUtils } from './block-classes.mjs';
/**
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("./p2p.mjs").P2PNetwork} P2PNetwork
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
 * @typedef {import("../plugins/logger.mjs").Logger} Logger
 */

const MAX_BLOCKS_PER_REQUEST = 4;
const DELAY_BETWEEN_PEERS = 1000; // 2 seconds

// Define a custom error class for sync restarts
class SyncRestartError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SyncRestartError';
    }
}

export class SyncHandler {
    constructor(getNodeReference, logger) {
        this.getNodeReference = getNodeReference;
        this.p2pNetworkMaxMessageSize = 0;
        this.syncFailureCount = 0;
        this.maxBlocksToRemove = 100; // Set a maximum limit to prevent removing too many blocks
        /** @type {Logger} */
        this.logger = logger;
        this.isSyncing = false;
        this.peerHeights = new Map();
        this.syncDisabled = false;
    }
    /** @type {Node} */
    get node() {
        return this.getNodeReference();
    }
    get myPeerId() {
        return this.node.p2pNetwork.p2pNode.peerId.toString();
    }
    /** Starts the sync handler.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance */
    async start(p2pNetwork) {
        try {
            p2pNetwork.p2pNode.handle(P2PNetwork.SYNC_PROTOCOL, this.handleIncomingStream.bind(this));
            this.logger.info('luid-feea692e Sync node started', { protocol: P2PNetwork.SYNC_PROTOCOL });
        } catch (error) {
            this.logger.error('luid-91503910 Failed to start sync node', { error: error.message });
            throw error;
        }
    }

    /** Handles incoming streams from peers.
     * @param {Object} param0 - The stream object.
     * @param {import('libp2p').Stream} param0.stream - The libp2p stream. */
    async handleIncomingStream(lstream) {
        const stream = lstream.stream;
        const peerId = lstream.connection.remotePeer.toString();
        this.node.p2pNetwork.reputationManager.recordAction({ peerId }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);
        try {
            // Decode the stream using lp.decode()
            const source = lp.decode(stream.source);

            for await (const msg of source) {
                const serializedMsg = msg.subarray();
                const message = utils.serializer.rawData.fromBinary_v1(serializedMsg);

                if (!message || typeof message.type !== 'string') {
                    throw new Error('Invalid message format');
                }

                const response = await this.#handleMessage(message);
                // Encode the response and write it to the stream
                const encodedResponse = lp.encode.single(utils.serializer.rawData.toBinary_v1(response));
                await stream.sink(encodedResponse);
            }
        } catch (err) {
            this.logger.error('luid-0afb2862 Stream error occurred', { error: err.message });
        } finally {
            if (stream) {
                try {
                    stream.close();
                } catch (closeErr) {
                    this.logger.error('luid-c46e58f3 Failed to close stream', { error: closeErr.message });
                }
            } else {
                this.logger.warn('luid-fd5a00b6 Stream is undefined; cannot close stream');
            }
        }
    }

    /** Handles incoming messages based on their type.
     * @param {Object} message - The incoming message.
     * @returns {Promise<Object>} The response to the message. */
    async #handleMessage(msg) {
        switch (msg.type) {
            case 'getBlocks':
                this.logger.debug('luid-4a957975 Received getBlocks request', msg);
                const blocks = await this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false);
                this.logger.debug('luid-6aa075d3 Sending blocks in response', { count: blocks.length });
                return { status: 'success', blocks };
            case 'getStatus':
                if (!this.node.blockchain.currentHeight) { this.logger.error(`luid-6ae382b8 [SYNC] currentHeight is: ${this.node.blockchain.currentHeight}`); }
                return {
                    status: 'success',
                    currentHeight: this.node.blockchain.currentHeight,
                    latestBlockHash: this.node.blockchain.getLatestBlockHash(),
                };
            default:
                this.logger.warn('luid-f04b2516 Invalid request type', { type: msg.type });
                throw new Error('Invalid request type');
        }
    }
    /** Gets the status of a peer.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance.
     * @param {string} peerMultiaddr - The multiaddress of the peer.
     * @returns {Promise<Object>} The peer's status. */
    async #getPeerStatus(p2pNetwork, peerMultiaddr, peerId) {
        this.logger.debug('luid-0269246d Getting peer status', { peerMultiaddr, peerId });
        const peerStatusMessage = { type: 'getStatus' };
        try {
            const response = await p2pNetwork.sendMessage(peerMultiaddr, peerStatusMessage);

            if (response === undefined) { return false; }
            if (response.status !== 'success') { return false; }
            if (typeof response.currentHeight !== 'number') { return false; }

            this.peerHeights.set(peerId, response.currentHeight);
            this.logger.debug('luid-0c8cccd8 Got peer status', { peerMultiaddr, currentHeight: response.currentHeight, id: peerId });

            return response;
        }
        catch (error) {
            this.logger.error('luid-c09bcb4d Failed to get peer status', { error: error.message });
            return false;
        }
    }
    /** Retrieves the statuses of all peers in parallel with proper timeout handling.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance.
     * @returns {Promise<Array<{ peerId: string, address: string, currentHeight: number, latestBlockHash: string }>>} 
     * An array of peer statuses. */
    async #getAllPeersStatus(p2pNetwork) {
        const peersToSync = Array.from(p2pNetwork.peers.entries());
        // Create array of peer status promises with timeout
        const statusPromises = peersToSync
            .map(([peerId, peerData]) => {
                const address = peerData.address;
                if (!address) {
                    this.logger.error('luid-35e1f975 Peer address is missing', { peerId });
                    return null;
                }

                let ma;
                try {
                    ma = multiaddr(address);
                } catch (err) {
                    this.logger.error('luid-35e1f975 Invalid multiaddr for peer',
                        { address, peerId, error: err.message });
                    return null;
                }

                // Create a promise that rejects on timeout
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Timeout')), 5000);
                });

                // Combine peer status retrieval with timeout
                return Promise.race([
                    this.#getPeerStatus(p2pNetwork, ma, peerId)
                        .then(status => ({
                            peerId,
                            address,
                            ...status
                        })),
                    timeoutPromise
                ]).catch(error => {
                    this.logger.warn('luid-1d4fb7c0 Failed to get peer status',
                        { peerId, address, error: error.message });
                    return null;
                });
            })
            .filter(Boolean); // Remove null entries

        // Wait for all promises to complete
        const results = await Promise.all(statusPromises);

        // Filter out failed requests and add successful ones to allStatus
        return results.filter(Boolean);
    }

    /** Handles synchronization failure by rolling back to snapshot and requesting a restart handled by the factory. */
    async handleSyncFailure() {
        this.logger.error(`luid-33c856d9 [SYNC] Sync failure occurred, restarting sync process`);
        if (this.node.restartRequested) {
            //this.isSyncing = false;
            return;
        }

        if (this.node.blockchain.currentHeight === -1) {
            this.node.requestRestart('SyncHandler.handleSyncFailure() - blockchain currentHeight is -1');
            //this.isSyncing = false;
            return;
        }
     
        const currentHeight = this.node.blockchain.currentHeight;
        const snapshotHeights = this.node.snapshotSystem.getSnapshotsHeights();

        if (snapshotHeights.length === 0) {
            this.node.requestRestart('SyncHandler.handleSyncFailure() - no snapshots available');
            //this.isSyncing = false;
            return;
        }
        const lastSnapshotHeight = snapshotHeights[snapshotHeights.length - 1];
        let eraseUntilHeight = currentHeight - 10;
        if (typeof lastSnapshotHeight === 'number') {
            eraseUntilHeight = Math.min(currentHeight - 10, lastSnapshotHeight - 10);
            this.node.snapshotSystem.eraseSnapshotsHigherThan(eraseUntilHeight);
        }

        this.node.requestRestart('SyncHandler.handleSyncFailure()');

        this.logger.info(`luid-cd98e436 [SYNC-${this.node.id.slice(0, 6)}] Snapshot erased until #${eraseUntilHeight}, waiting for restart...`);
        this.logger.info(`luid-3ef67123 [SYNC] Blockchain restored and reloaded. Current height: ${this.node.blockchain.currentHeight}`);
        //this.isSyncing = false;
    }
    /** Get the current height of a peer.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance.
     * @param {string} peerMultiaddr - The multiaddress of the peer to sync with. */
    async #updatedPeerHeight(p2pNetwork, peerMultiaddr, peerId) {
        try {
            const peerStatus = await this.#getPeerStatus(p2pNetwork, peerMultiaddr, peerId);
            if (!peerStatus || !peerStatus.currentHeight) { this.logger.info(`luid-d8e694f9 [SYNC] Failed to get peer height`); }
            return peerStatus.currentHeight;
        } catch (error) {
            this.logger.error(`luid-3c81f6ba [SYNC] (#updatedPeerHeight) Failed to get peer height: ${error.message}`);
            return false;
        }
    }
    /** Synchronizes missing blocks from a peer efficiently.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance.
     * @param {string} peerMultiaddr - The multiaddress of the peer to sync with. */
    async #getMissingBlocks(p2pNetwork, peerMultiaddr, peerCurrentHeight, peerId) {
        this.node.blockchainStats.state = `syncing with peer ${peerMultiaddr}`;
        this.logger.info(`luid-1b1b1b1b [SYNC] Synchronizing with peer ${peerMultiaddr}`);
        let peerHeight = peerCurrentHeight ? peerCurrentHeight : await this.#updatedPeerHeight(p2pNetwork, peerMultiaddr, peerId);
        if (!peerHeight) { this.logger.info(`luid-e9f9d488 [SYNC] (#getMissingBlocks) Failed to get peer height`); }

        let desiredBlock = this.node.blockchain.currentHeight + 1;
        while (desiredBlock <= peerHeight) {
            const endIndex = Math.min(desiredBlock + MAX_BLOCKS_PER_REQUEST - 1, peerHeight);
            const serializedBlocks = await this.#requestBlocksFromPeer(p2pNetwork, peerMultiaddr, desiredBlock, endIndex);
            if (!serializedBlocks) { this.logger.error(`luid-b93d9bf2 [SYNC] (#getMissingBlocks: while()) Failed to get serialized blocks`); break; }
            if (serializedBlocks.length === 0) { this.logger.error(`luid-6e5c9454 [SYNC] (#getMissingBlocks: while()) No blocks found`); break; }
            // Process blocks
            for (const serializedBlock of serializedBlocks) {
                try {
                    const block = BlockUtils.blockDataFromSerializedHeaderAndTxs(
                        serializedBlock.header,
                        serializedBlock.txs
                    );
                    await this.node.digestFinalizedBlock(block, { skipValidation: false, broadcastNewCandidate: false, isSync: true, persistToDisk: true });
                    desiredBlock++;
                } catch (blockError) {
                    this.logger.error('luid-63446bae Error processing block', { error: blockError.message, blockIndex: desiredBlock });
                    this.isSyncing = false;
                    throw new SyncRestartError('Sync failure occurred, restarting sync process');
                }
            }

            this.logger.info('luid-09a78e43 Synchronized blocks from peer', { count: serializedBlocks.length, nextBlock: desiredBlock });
            // Update the peer's height when necessary
            if (peerHeight === this.node.blockchain.currentHeight) {
                peerHeight = await this.#updatedPeerHeight(p2pNetwork, peerMultiaddr, peerId);
                if (!peerHeight) { this.logger.error(`luid-f1def041 [SYNC] (#getMissingBlocks: while()) Failed to get peer height`); }
            }

        }

        if (peerHeight === this.node.blockchain.currentHeight) { return true; }
        // No bug, but not fully synchronized
        return false;
    }
    /** Requests blocks from a peer.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance.
     * @param {string} peerMultiaddr - The multiaddress of the peer.
     * @param {number} startIndex - The starting block index.
     * @param {number} endIndex - The ending block index.
     * @returns {Promise<Array>} An array of blocks. */
    async #requestBlocksFromPeer(p2pNetwork, peerMultiaddr, startIndex, endIndex) {
        const message = { type: 'getBlocks', startIndex, endIndex };
        this.logger.debug('luid-69db154c Requesting blocks from peer', { startIndex, endIndex, peerMultiaddr });

        let response;
        try {
            response = await p2pNetwork.sendMessage(peerMultiaddr, message);
        } catch (error) {
            this.logger.error(`luid-5f4a2946 Failed to get blocks from peer ${peerMultiaddr}`, { error: error.message },);
            throw error;
        }

        if (response.status === 'success' && Array.isArray(response.blocks)) {
            return response.blocks;
        } else {
            this.logger.warn('luid-fd24299d Failed to get blocks from peer', { status: response.status });
            throw new Error('Failed to get blocks from peer');
        }
    }

    getPeerHeight(peerId) {
        return this.peerHeights.get(peerId) ?? 0;
    }
    getAllPeerHeights() {
        // return as Object
        return Object.fromEntries(this.peerHeights);
    }
    async syncWithPeers(peerIds = []) {
        const uniqueTopics = this.node.getTopicsToSubscribeRelatedToRoles();
        // should be done only one time
        await this.node.p2pNetwork.subscribeMultipleTopics(uniqueTopics, this.node.p2pHandler.bind(this.node));
        if (this.syncDisabled) { return true; }

        this.logger.info(`luid-4dce8bb0 [SYNC] Starting syncWithPeers at #${this.node.blockchain.currentHeight}`);
        this.node.blockchainStats.state = "syncing";
        this.isSyncing = true;
    
        let peerStatuses = [];
    
        if (peerIds.length > 0) {
            // Sync with specific peers
            for (const peerId of peerIds) {
                const peerData = this.node.p2pNetwork.peers.get(peerId);
                if (!peerData) { continue; }

                const { address } = peerData;
                const ma = multiaddr(address);
                const peerStatus = await this.#getPeerStatus(this.node.p2pNetwork, ma, peerId);
                if (!peerStatus || !peerStatus.currentHeight) { continue; }

                peerStatuses.push({
                    peerId,
                    address,
                    currentHeight: peerStatus.currentHeight,
                });
            }
    
            if (peerStatuses.length === 0) {
                this.logger.error(`luid-909bb94c [SYNC] No valid peers to sync with`);
                await this.handleSyncFailure();
                return false;
            }
        } else {
            // Sync with all known peers
            peerStatuses = await this.#getAllPeersStatus(this.node.p2pNetwork);
            if (!peerStatuses || peerStatuses.length === 0) {
                this.logger.error(`luid-eec3c612 [SYNC] Unable to get peer statuses`);
                await this.handleSyncFailure();
                return false;
            }
        }
    
        // Sort peers by currentHeight in descending order
        peerStatuses.sort((a, b) => b.currentHeight - a.currentHeight);
        const highestPeerHeight = peerStatuses[0].currentHeight;
        const peersHeight = {};
        for (const peer of peerStatuses) {
            const height = peer.currentHeight;
            if (!peersHeight[height]) { peersHeight[height] = 0; }
            peersHeight[height]++;
        }

        const consensus = { height: 0, peers: 0 };
        for (const height in peersHeight) {
            const isHighest = peersHeight[height] > consensus.peers;
            if (!isHighest && peersHeight[height] <= consensus.peers) { continue; }

            consensus.height = height;
            consensus.peers = peersHeight[height];
        }
    
        if (highestPeerHeight <= this.node.blockchain.currentHeight) {
            this.logger.debug(`luid-ff391762 [SYNC] Already at the highest height #${highestPeerHeight}, no need to sync`);
            this.isSyncing = false;
            return true;
        }
        if (consensus.height <= this.node.blockchain.currentHeight) {
            this.logger.debug(`luid-ff391762 [SYNC] Already at the consensus height #${consensus.height}, no need to sync`);
            this.isSyncing = false;
            return true;
        }
        
        this.logger.info(`luid-a050ac5b [SYNC] consensusHeight peer height: ${consensus.height}, current height: ${this.node.blockchain.currentHeight}`);
    
        // Attempt to sync with peers in order
        for (const peerInfo of peerStatuses) {
            const { peerId, address, currentHeight } = peerInfo;
            if (currentHeight < consensus.height) { continue; } // Skip peers with lower height than consensus

            const ma = multiaddr(address);
            this.logger.info(`luid-89219133 Attempting to sync with peer`, { peerId, currentHeight });
            try {
                const synchronized = await this.#getMissingBlocks(this.node.p2pNetwork, ma, currentHeight, peerId);
                this.logger.info(`luid-5eb266ed Successfully synced with peer`, { peerId });
                if (!synchronized) { continue; }

                break; // Sync successful, break out of loop
            } catch (error) {
                await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_PEERS));
                if (error instanceof SyncRestartError) {
                    this.logger.error(`luid-75e514b1 Sync restart error occurred`, { error: error.message });
                    await this.handleSyncFailure();
                    return false;
                }
                break;
            }
        }
    
        if (consensus.height > this.node.blockchain.currentHeight) {
            this.logger.debug(`luid-8e1fa028 [SYNC] Need to sync ${consensus.height - this.node.blockchain.currentHeight} more blocks, restarting sync process`);
            return false;
        }
    
        this.logger.debug(`luid-29036e62 [SYNC] Sync process finished, current height: ${this.node.blockchain.currentHeight}`);
        this.isSyncing = false;
        return true;
    }
    async syncWithPeers_old(peerIds = []) { // DEPRECATED
        const uniqueTopics = this.node.getTopicsToSubscribeRelatedToRoles();
        // should be done only one time
        await this.node.p2pNetwork.subscribeMultipleTopics(uniqueTopics, this.node.p2pHandler.bind(this.node));
        if (this.syncDisabled) { return true; }

        this.logger.info(`luid-4dce8bb0 [SYNC] Starting syncWithPeers at #${this.node.blockchain.currentHeight}`);
        this.node.blockchainStats.state = "syncing";
        this.isSyncing = true;
    
        let peerStatuses = [];
    
        if (peerIds.length > 0) {
            // Sync with specific peers
            for (const peerId of peerIds) {
                const peerData = this.node.p2pNetwork.peers.get(peerId);
                if (!peerData) { continue; }

                const { address } = peerData;
                const ma = multiaddr(address);
                const peerStatus = await this.#getPeerStatus(this.node.p2pNetwork, ma, peerId);
                if (!peerStatus || !peerStatus.currentHeight) { continue; }

                peerStatuses.push({
                    peerId,
                    address,
                    currentHeight: peerStatus.currentHeight,
                });
            }
    
            if (peerStatuses.length === 0) {
                this.logger.error(`luid-909bb94c [SYNC] No valid peers to sync with`);
                await this.handleSyncFailure();
                return false;
            }
        } else {
            // Sync with all known peers
            peerStatuses = await this.#getAllPeersStatus(this.node.p2pNetwork);
            if (!peerStatuses || peerStatuses.length === 0) {
                this.logger.error(`luid-eec3c612 [SYNC] Unable to get peer statuses`);
                await this.handleSyncFailure();
                return false;
            }
        }
    
        // Sort peers by currentHeight in descending order
        peerStatuses.sort((a, b) => b.currentHeight - a.currentHeight);
        const highestPeerHeight = peerStatuses[0].currentHeight;
    
        if (highestPeerHeight <= this.node.blockchain.currentHeight) {
            this.logger.debug(`luid-ff391762 [SYNC] Already at the highest height, no need to sync`);
            this.isSyncing = false;
            return true;
        }
    
        this.logger.info(`luid-a050ac5b [SYNC] Highest peer height: ${highestPeerHeight}, current height: ${this.node.blockchain.currentHeight}`);
    
        // Attempt to sync with peers in order
        for (const peerInfo of peerStatuses) {
            const { peerId, address, currentHeight } = peerInfo;
            const ma = multiaddr(address);
            this.logger.info(`luid-89219133 Attempting to sync with peer`, { peerId, currentHeight });
            try {
                const synchronized = await this.#getMissingBlocks(this.node.p2pNetwork, ma, currentHeight, peerId);
                this.logger.info(`luid-5eb266ed Successfully synced with peer`, { peerId });
                if (!synchronized) { continue; }

                break; // Sync successful, break out of loop
            } catch (error) {
                await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_PEERS));
                if (error instanceof SyncRestartError) {
                    this.logger.error(`luid-75e514b1 Sync restart error occurred`, { error: error.message });
                    await this.handleSyncFailure();
                    return false;
                }
                break;
            }
        }
    
        if (highestPeerHeight > this.node.blockchain.currentHeight) {
            this.logger.debug(`luid-8e1fa028 [SYNC] Need to sync more blocks, restarting sync process`);
            return false;
        }
    
        this.logger.debug(`luid-29036e62 [SYNC] Sync process finished, current height: ${this.node.blockchain.currentHeight}`);
        this.isSyncing = false;
        return true;
    }
}