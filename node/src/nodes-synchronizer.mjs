import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { serializer } from '../../utils/serializer.mjs';
import P2PNetwork from './p2p.mjs';
import * as lp from 'it-length-prefixed';
import { multiaddr } from '@multiformats/multiaddr';
import ReputationManager from './peers-reputation.mjs';
import { BlockUtils } from './block-classes.mjs';
/**
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("./p2p.mjs").P2PNetwork} P2PNetwork
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
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
    constructor(getNodeReference) {
        this.getNodeReference = getNodeReference;
        this.p2pNetworkMaxMessageSize = 0;
        this.syncFailureCount = 0;
        this.maxBlocksToRemove = 100; // Set a maximum limit to prevent removing too many blocks
        /** @type {MiniLogger} */
        this.miniLogger = new MiniLogger('sync');
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
            //this.logger.info('luid-feea692e Sync node started', { protocol: P2PNetwork.SYNC_PROTOCOL });
            this.miniLogger.log('Sync node started', (m) => { console.info(m); });
        } catch (error) {
            //this.logger.error('luid-91503910 Failed to start sync node', { error: error.message });
            this.miniLogger.log('Failed to start sync node', (m) => { console.error(m); });
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
                const message = serializer.deserialize.rawData(serializedMsg);

                if (!message || typeof message.type !== 'string') {
                    throw new Error('Invalid message format');
                }

                const response = await this.#handleMessage(message);
                // Encode the response and write it to the stream
                const encodedResponse = lp.encode.single(serializer.serialize.rawData(response));
                await stream.sink(encodedResponse);
            }
        } catch (err) {
            this.miniLogger.log('Stream error occurred', (m) => { console.error(m); });
            this.miniLogger.log(err, (m) => { console.error(m); });
        } finally {
            if (stream) {
                try {
                    stream.close();
                } catch (closeErr) {
                    this.miniLogger.log('Failed to close stream', (m) => { console.error(m); });
                    this.miniLogger.log(closeErr, (m) => { console.error(m); });
                }
            } else {
                this.miniLogger.log('Stream is undefined; cannot close stream', (m) => { console.warn(m); });
            }
        }
    }

    /** Handles incoming messages based on their type.
     * @param {Object} message - The incoming message.
     * @returns {Promise<Object>} The response to the message. */
    async #handleMessage(msg) {
        switch (msg.type) {
            case 'getBlocks':
                this.miniLogger.log(`"getBlocks request" Received: #${msg.startIndex} to #${msg.endIndex}`, (m) => { console.debug(m); });
                const blocks = this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false);

                this.miniLogger.log(`Sending ${blocks.length} blocks in response`, (m) => { console.debug(m); });
                return { status: 'success', blocks };
            case 'getStatus':
                if (!this.node.blockchain.currentHeight) {
                    this.miniLogger.log(`"getStatus request" response: #${this.node.blockchain.currentHeight}`, (m) => { console.error(m); });
                }
                return {
                    status: 'success',
                    currentHeight: this.node.blockchain.currentHeight,
                    latestBlockHash: this.node.blockchain.getLastBlockHash(),
                };
            default:
                this.miniLogger.log('Invalid request type', (m) => { console.warn(m); });
                throw new Error('Invalid request type');
        }
    }
    /** Gets the status of a peer.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance.
     * @param {string} peerMultiaddr - The multiaddress of the peer.
     * @returns {Promise<Object>} The peer's status. */
    async #getPeerStatus(p2pNetwork, peerMultiaddr, peerId) {
        this.miniLogger.log('Getting peer status', (m) => { console.debug(m); });
        const peerStatusMessage = { type: 'getStatus' };
        try {
            const response = await p2pNetwork.sendMessage(peerMultiaddr, peerStatusMessage);

            if (response === undefined) { return false; }
            if (response.status !== 'success') { return false; }
            if (typeof response.currentHeight !== 'number') { return false; }

            this.peerHeights.set(peerId, response.currentHeight);
            this.miniLogger.log(`Got peer status => height: #${response.currentHeight}`, (m) => { console.debug(m); });

            return response;
        }
        catch (error) {
            this.miniLogger.log('Failed to get peer status', (m) => { console.error(m); });
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
                    this.miniLogger.log('Peer address is missing', (m) => { console.error(m); });
                    return null;
                }

                let ma;
                try {
                    ma = multiaddr(address);
                } catch (err) {
                    this.miniLogger.log(`Invalid multiaddr for peer ${address} - ${peerId}`, (m) => { console.error(m); });
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
                    this.miniLogger.log(`Failed to get peer status ${peerId} - ${address}`, (m) => { console.warn(m); });
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
        this.miniLogger.log('Sync failure occurred, restarting sync process', (m) => { console.error(m); });
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

        this.miniLogger.log(`Snapshot erased until #${eraseUntilHeight}, waiting for restart...`, (m) => { console.info(m); });
        this.miniLogger.log(`Blockchain restored and reloaded. Current height: ${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });
        //this.isSyncing = false;
    }
    /** Get the current height of a peer.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance.
     * @param {string} peerMultiaddr - The multiaddress of the peer to sync with. */
    async #updatedPeerHeight(p2pNetwork, peerMultiaddr, peerId) {
        try {
            const peerStatus = await this.#getPeerStatus(p2pNetwork, peerMultiaddr, peerId);
            if (!peerStatus || !peerStatus.currentHeight) { this.miniLogger.log(`Failed to get peer height`, (m) => { console.info(m); }); }
            return peerStatus.currentHeight;
        } catch (error) {
            this.miniLogger.log(`Failed to get peer height: ${error.message}`, (m) => { console.error(m); });
            return false;
        }
    }
    /** Synchronizes missing blocks from a peer efficiently.
     * @param {P2PNetwork} p2pNetwork - The P2P network instance.
     * @param {string} peerMultiaddr - The multiaddress of the peer to sync with. */
    async #getMissingBlocks(p2pNetwork, peerMultiaddr, peerCurrentHeight, peerId) {
        this.node.blockchainStats.state = `syncing with peer ${peerMultiaddr}`;
        this.miniLogger.log(`Synchronizing with peer ${peerMultiaddr}`, (m) => { console.info(m); });
        
        let peerHeight = peerCurrentHeight ? peerCurrentHeight : await this.#updatedPeerHeight(p2pNetwork, peerMultiaddr, peerId);
        if (!peerHeight) { this.miniLogger.log(`Failed to get peer height`, (m) => { console.info(m); }); }

        let desiredBlock = this.node.blockchain.currentHeight + 1;
        while (desiredBlock <= peerHeight) {
            const endIndex = Math.min(desiredBlock + MAX_BLOCKS_PER_REQUEST - 1, peerHeight);
            const serializedBlocks = await this.#requestBlocksFromPeer(p2pNetwork, peerMultiaddr, desiredBlock, endIndex);
            
            if (!serializedBlocks) { this.miniLogger.log(`Failed to get serialized blocks`, (m) => { console.error(m); }); break; }
            if (serializedBlocks.length === 0) { this.miniLogger.log(`No blocks found`, (m) => { console.error(m); }); break; }
            
            for (const serializedBlock of serializedBlocks) {
                try {
                    const block = serializer.deserialize.block_finalized(serializedBlock);
                    await this.node.digestFinalizedBlock(block, { skipValidation: false, broadcastNewCandidate: false, isSync: true, persistToDisk: true });
                    desiredBlock++;
                } catch (blockError) {
                    this.miniLogger.log(`Error processing block #${desiredBlock}`, (m) => { console.error(m); });
                    this.miniLogger.log(blockError, (m) => { console.error(m); });
                    this.isSyncing = false;
                    throw new SyncRestartError('Sync failure occurred, restarting sync process');
                }
            }

            this.miniLogger.log(`Synchronized blocks from peer, next block: #${desiredBlock}`, (m) => { console.info(m); });
            // Update the peer's height when necessary
            if (peerHeight === this.node.blockchain.currentHeight) {
                peerHeight = await this.#updatedPeerHeight(p2pNetwork, peerMultiaddr, peerId);

                if (!peerHeight) { this.miniLogger.log(`Failed to get peer height`, (m) => { console.info(m); }); }
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
        this.miniLogger.log(`Requesting blocks from peer ${peerMultiaddr}, #${startIndex} to #${endIndex}`, (m) => { console.info(m); });
        
        const message = { type: 'getBlocks', startIndex, endIndex };
        let response;
        try {
            response = await p2pNetwork.sendMessage(peerMultiaddr, message);
        } catch (error) {
            this.miniLogger.log(`Failed to get blocks from peer ${peerMultiaddr}`, (m) => { console.error(m); });
            throw error;
        }

        if (response.status === 'success' && Array.isArray(response.blocks)) {
            return response.blocks;
        } else {
            this.miniLogger.log('Failed to get blocks from peer', (m) => { console.warn(m); });
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

        this.miniLogger.log(`Starting syncWithPeers at #${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });
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
                this.miniLogger.log(`No valid peers to sync with`, (m) => { console.error(m); });
                await this.handleSyncFailure();
                return false;
            }
        } else {
            // Sync with all known peers
            peerStatuses = await this.#getAllPeersStatus(this.node.p2pNetwork);
            if (!peerStatuses || peerStatuses.length === 0) {
                this.miniLogger.log(`Unable to get peer statuses`, (m) => { console.error(m); });
                await this.handleSyncFailure();
                return false;
            }
        }
    
        // Sort peers by currentHeight in descending order
        peerStatuses.sort((a, b) => b.currentHeight - a.currentHeight);
        let highestPeerHeight = this.node.blockchain.currentHeight;
        const peersHeight = {};
        for (const peer of peerStatuses) {
            const height = peer.currentHeight;
            if (!peersHeight[height]) { peersHeight[height] = 0; }
            peersHeight[height]++;

            highestPeerHeight = Math.max(highestPeerHeight, height);
        }

        const consensus = { height: 0, peers: 0 };
        for (const height in peersHeight) {
            const isHighest = peersHeight[height] > consensus.peers;
            if (!isHighest && peersHeight[height] <= consensus.peers) { continue; }

            consensus.height = height;
            consensus.peers = peersHeight[height];
        }
    
        if (highestPeerHeight <= this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Already at the highest height #${highestPeerHeight}, no need to sync`, (m) => { console.debug(m); });
            this.isSyncing = false;
            return true;
        }
        if (consensus.height <= this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Already at the consensus height #${consensus.height}, no need to sync`, (m) => { console.debug(m); });
            this.isSyncing = false;
            return true;
        }
        
        this.miniLogger.log(`consensusHeight peer height: ${consensus.height}, current height: ${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });

        // Attempt to sync with peers in order
        for (const peerInfo of peerStatuses) {
            const { peerId, address, currentHeight } = peerInfo;
            if (currentHeight < consensus.height) { continue; } // Skip peers with lower height than consensus

            const ma = multiaddr(address);
            this.miniLogger.log(`Attempting to sync with peer ${peerId}`, (m) => { console.info(m); });
            try {
                const synchronized = await this.#getMissingBlocks(this.node.p2pNetwork, ma, currentHeight, peerId);
                this.miniLogger.log(`Successfully synced with peer ${peerId}`, (m) => { console.info(m); });
                if (!synchronized) { continue; }

                break; // Sync successful, break out of loop
            } catch (error) {
                await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_PEERS));
                if (error instanceof SyncRestartError) {
                    this.miniLogger.log(`Sync restart error occurred`, (m) => { console.error(m); });
                    await this.handleSyncFailure();
                    return false;
                }
                break;
            }
        }
    
        if (consensus.height > this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Need to sync ${consensus.height - this.node.blockchain.currentHeight} more blocks, restarting sync process`, (m) => { console.debug(m); });
            return false;
        }
    
        this.miniLogger.log(`Sync process finished, current height: ${this.node.blockchain.currentHeight}`, (m) => { console.debug(m); });
        this.isSyncing = false;
        return true;
    }
    async syncWithPeers_old(peerIds = []) { // DEPRECATED
        const uniqueTopics = this.node.getTopicsToSubscribeRelatedToRoles();
        // should be done only one time
        await this.node.p2pNetwork.subscribeMultipleTopics(uniqueTopics, this.node.p2pHandler.bind(this.node));
        if (this.syncDisabled) { return true; }

        this.miniLogger.log(`Starting syncWithPeers at #${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });
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
                this.miniLogger.log(`No valid peers to sync with`, (m) => { console.error(m); });
                await this.handleSyncFailure();
                return false;
            }
        } else {
            // Sync with all known peers
            peerStatuses = await this.#getAllPeersStatus(this.node.p2pNetwork);
            if (!peerStatuses || peerStatuses.length === 0) {
                this.miniLogger.log(`Unable to get peer statuses`, (m) => { console.error(m); });
                await this.handleSyncFailure();
                return false;
            }
        }
    
        // Sort peers by currentHeight in descending order
        peerStatuses.sort((a, b) => b.currentHeight - a.currentHeight);
        const highestPeerHeight = peerStatuses[0].currentHeight;
    
        if (highestPeerHeight <= this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Already at the highest height, no need to sync`, (m) => { console.debug(m); });
            this.isSyncing = false;
            return true;
        }
    
        this.miniLogger.log(`Highest peer height: ${highestPeerHeight}, current height: ${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });

        // Attempt to sync with peers in order
        for (const peerInfo of peerStatuses) {
            const { peerId, address, currentHeight } = peerInfo;
            const ma = multiaddr(address);
            this.miniLogger.log(`Attempting to sync with peer ${peerId}`, (m) => { console.info(m); });
            try {
                const synchronized = await this.#getMissingBlocks(this.node.p2pNetwork, ma, currentHeight, peerId);
                this.miniLogger.log(`Successfully synced with peer ${peerId}`, (m) => { console.info(m); });
                if (!synchronized) { continue; }

                break; // Sync successful, break out of loop
            } catch (error) {
                await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_PEERS));
                if (error instanceof SyncRestartError) {
                    this.miniLogger.log(`Sync restart error occurred`, (m) => { console.error(m); });
                    await this.handleSyncFailure();
                    return false;
                }
                break;
            }
        }
    
        if (highestPeerHeight > this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Need to sync more blocks, restarting sync process`, (m) => { console.debug(m); });
            return false;
        }
    
        this.miniLogger.log(`Sync process finished, current height: ${this.node.blockchain.currentHeight}`, (m) => { console.debug(m); });
        this.isSyncing = false;
        return true;
    }
}