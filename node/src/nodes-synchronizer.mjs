import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { serializer } from '../../utils/serializer.mjs';
import P2PNetwork from './p2p.mjs';
import * as lp from 'it-length-prefixed';
import { multiaddr } from '@multiformats/multiaddr';
import ReputationManager from './peers-reputation.mjs';

/**
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("./p2p.mjs").P2PNetwork} P2PNetwork
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
 */

const MAX_BLOCKS_PER_REQUEST = 4;

export class SyncHandler {
    /** @type {MiniLogger} */
    miniLogger = new MiniLogger('sync');
    /** @param {Node} node */
    constructor(node) {
        /** @type {Node} */
        this.node = node;
        this.p2pNetworkMaxMessageSize = 0;
        this.syncFailureCount = 0;
        this.maxBlocksToRemove = 100; // Set a maximum limit to prevent removing too many blocks
        this.isSyncing = false;
        this.peerHeights = new Map();
        this.syncDisabled = false;
    }
    /** @param {P2PNetwork} p2pNetwork - The P2P network instance */
    async start(p2pNetwork) {
        p2pNetwork.p2pNode.handle(P2PNetwork.SYNC_PROTOCOL, this.#handleIncomingStream.bind(this));
        this.miniLogger.log('Sync node started', (m) => { console.info(m); });
    }
    async #handleIncomingStream(lstream) {
        const stream = lstream.stream;
        const peerIdStr = lstream.connection.remotePeer.toString();
        this.node.p2pNetwork.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);
        try {
            const source = lp.decode(stream.source);
            for await (const msg of source) {
                const serializedMsg = msg.subarray();
                const message = serializer.deserialize.rawData(serializedMsg);

                if (!message || typeof message.type !== 'string') { throw new Error('Invalid message format'); }

                const response = await this.#handleMessage(message);
                const encodedResponse = lp.encode.single(serializer.serialize.rawData(response));
                await stream.sink(encodedResponse);
            }
        } catch (err) { this.miniLogger.log(err, (m) => { console.error(m); }); }

        if (!stream) { return; }

        try {
            stream.close();
        } catch (closeErr) {
            this.miniLogger.log('Failed to close stream', (m) => { console.error(m); });
            this.miniLogger.log(closeErr, (m) => { console.error(m); });
        }
    }
    async #handleMessage(msg) {
        switch (msg.type) {
            case 'getBlocks':
                this.miniLogger.log(`"getBlocks request" Received: #${msg.startIndex} to #${msg.endIndex}`, (m) => { console.debug(m); });
                
                /** @type {Uint8Array<ArrayBufferLike>[]} */
                const blocks = this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false);
                return { status: 'success', blocks };
            case 'getStatus':
                this.miniLogger.log(`"getStatus request" response: #${this.node.blockchain.currentHeight}`, (m) => { console.error(m); });

                return {
                    status: 'success',
                    currentHeight: this.node.blockchain.currentHeight,
                    latestBlockHash: this.node.blockchain.lastBlock
                        ? this.node.blockchain.lastBlock.hash
                        : "0000000000000000000000000000000000000000000000000000000000000000"
                };
            default:
                this.miniLogger.log('Invalid request type', (m) => { console.warn(m); });
                throw new Error('Invalid request type');
        }
    }
    /** @param {P2PNetwork} p2pNetwork @param {string} peerMultiaddr @param {string} peerIdStr */
    async #getPeerStatus(p2pNetwork, peerMultiaddr, peerIdStr) {
        this.miniLogger.log('Getting peer status', (m) => { console.debug(m); });
        const peerStatusMessage = { type: 'getStatus' };
        try {
            const response = await p2pNetwork.sendMessage(peerMultiaddr, peerStatusMessage);
            if (response === undefined) { return false; }
            if (response.status !== 'success') { return false; }
            if (typeof response.currentHeight !== 'number') { return false; }

            this.peerHeights.set(peerIdStr, response.currentHeight);
            this.miniLogger.log(`Got peer status => height: #${response.currentHeight}`, (m) => { console.debug(m); });

            return response;
        } catch (error) { this.miniLogger.log(error, (m) => { console.error(m); }); }

        return false;
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
    async #handleSyncFailure() {
        this.isSyncing = false;
        this.syncFailureCount++;
        this.miniLogger.log('Sync failure occurred, restarting sync process', (m) => { console.error(m); });

        return false;
    }
    /** @param {P2PNetwork} p2pNetwork @param {string} peerMultiaddr */
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
    /** @param {P2PNetwork} p2pNetwork @param {string} peerMultiaddr */
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
                    //this.isSyncing = false;
                    //throw new SyncRestartError('Sync failure occurred, restarting sync process');
                    return false;
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
        
        try {
            const response = await p2pNetwork.sendMessage(peerMultiaddr, { type: 'getBlocks', startIndex, endIndex });
            if (response && response.status === 'success' && Array.isArray(response.blocks)) { return response.blocks; }
        } catch (error) {}
        
        this.miniLogger.log(`Failed to get blocks from peer ${peerMultiaddr}`, (m) => { console.error(m); });
        return false;
    }
    #getTopicsToSubscribeRelatedToRoles(roles = []) {
        const rolesTopics = {
            validator: ['new_transaction', 'new_block_finalized'],
            miner: ['new_block_candidate'],
            observer: ['new_transaction', 'new_block_finalized', 'new_block_candidate']
        }
        const topicsToSubscribe = [];
        for (const role of roles) { topicsToSubscribe.push(...rolesTopics[role]); }
        return [...new Set(topicsToSubscribe)];
    }
    async syncWithPeers() {
        const uniqueTopics = this.#getTopicsToSubscribeRelatedToRoles(this.node.roles);
        for (const topic of uniqueTopics) { this.node.p2pNetwork.subscribe(topic, this.node.p2pHandler.bind(this.node)); }
        if (this.syncDisabled) { return true; }

        this.miniLogger.log(`Starting syncWithPeers at #${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });
        this.node.blockchainStats.state = "syncing";
        this.isSyncing = true;
    
        const peerStatuses = await this.#getAllPeersStatus(this.node.p2pNetwork);
        if (!peerStatuses || peerStatuses.length === 0) {
            this.miniLogger.log(`Unable to get peer statuses`, (m) => { console.error(m); });
            await this.#handleSyncFailure();
            return false;
        }

        const consensus = { height: 0, peers: 0, hash: '' };
        const consensuses = {};
        for (const peer of peerStatuses) {
            const height = peer.currentHeight;
            const hash = peer.latestBlockHash;
            if (!consensuses[height]) { consensuses[height] = {}; }

            consensuses[height][hash] = consensuses[height][hash] ? consensuses[height][hash] + 1 : 1;
            if (consensuses[height][hash] <= consensus.peers) { continue; }

            consensus.height = height;
            consensus.peers = consensuses[height][hash];
            consensus.hash = hash;
        }
    
        if (consensus.height <= this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Already at the consensus height #${consensus.height}, no need to sync`, (m) => { console.debug(m); });
            this.isSyncing = false;
            return true;
        }
        
        this.miniLogger.log(`consensusHeight peer height: ${consensus.height}, current height: ${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });

        // Attempt to sync with peers in order
        for (const peerInfo of peerStatuses) {
            const { peerId, address, currentHeight, latestBlockHash } = peerInfo;
            //if (currentHeight < consensus.height) { continue; } // Skip peers with lower height than consensus
            if (latestBlockHash !== consensus.hash) { continue; } // Skip peers with different hash than consensus

            const ma = multiaddr(address);
            this.miniLogger.log(`Attempting to sync with peer ${peerId}`, (m) => { console.info(m); });
            const synchronized = await this.#getMissingBlocks(this.node.p2pNetwork, ma, currentHeight, peerId);
            if (!synchronized) { continue; }
                
            this.miniLogger.log(`Successfully synced with peer ${peerId}`, (m) => { console.info(m); });
            break; // Sync successful, break out of loop
        }
    
        this.isSyncing = false;

        if (consensus.height > this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Need to sync ${consensus.height - this.node.blockchain.currentHeight} more blocks, restarting sync process`, (m) => { console.debug(m); });
            return false;
        }
    
        this.miniLogger.log(`Sync process finished, current height: ${this.node.blockchain.currentHeight}`, (m) => { console.debug(m); });
        return true;
    }
}