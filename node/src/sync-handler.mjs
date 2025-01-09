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

/**
 * @typedef {Object} PeerInfo
 * @property {string} peerId
 * @property {string} address
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 */

export class SyncHandler {
    /** @type {MiniLogger} */
    miniLogger = new MiniLogger('sync');
    /** @type {Map<string, number>} */
    peersHeights = {};

    /** @param {Node} node */
    constructor(node) {
        /** @type {Node} */
        this.node = node;
        this.p2pNetworkMaxMessageSize = 0;
        this.syncFailureCount = 0;
        this.maxBlocksToRemove = 100; // Set a maximum limit to prevent removing too many blocks
        this.isSyncing = false;
        this.syncDisabled = false;
    }
    async start() {
        this.node.p2pNetwork.p2pNode.handle(P2PNetwork.SYNC_PROTOCOL, this.#handleIncomingStream.bind(this));
        this.miniLogger.log('Sync node started', (m) => { console.info(m); });
    }
    async #handleIncomingStream(lstream) {
        const stream = lstream.stream;
        if (!stream) { return; }

        const peerIdStr = lstream.connection.remotePeer.toString();
        this.node.p2pNetwork.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);
        const source = lp.decode(stream.source);
        for await (const serializedMessage of source) {
            try {
                const serializedMsg = serializedMessage.subarray();
                const msg = serializer.deserialize.rawData(serializedMsg);
                if (!msg || typeof msg.type !== 'string') { throw new Error('Invalid message format'); }
                // default type is 'getStatus', returning currentHeight and latest block hash

                const response = {
                    currentHeight: this.node.blockchain.currentHeight,
                    /** @type {string} */
                    latestBlockHash: this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000",
                    /** @type {Uint8Array<ArrayBufferLike>[] | undefined} */
                    blocks: undefined
                };

                if (msg.type === 'getBlocks' && typeof msg.startIndex === 'number' && typeof msg.endIndex === 'number') {
                    this.miniLogger.log(`"getBlocks request" Received: #${msg.startIndex} to #${msg.endIndex}`, (m) => { console.info(m); });
                    response.blocks =  this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false);
                }

                const encodedResponse = lp.encode.single(serializer.serialize.rawData(response));
                await stream.sink(encodedResponse);
            } catch (err) { this.miniLogger.log(err, (m) => { console.error(m); }); }
        }

        try { stream.close(); } catch (closeErr) { this.miniLogger.log(closeErr, (m) => { console.error(m); }); }
    }
    async #getAllPeersInfo() {
        const peersToSync = Object.entries(this.node.p2pNetwork.peers);
        const responsePromises = [];
        for (const [peerIdStr, peerData] of peersToSync) {
            if (!peerData.addressStr) {
                this.miniLogger.log('Peer address is missing', (m) => { console.error(m); });
                continue;
            }

            //responsePromises.push(this.#getPeerStatus(multiaddr(peerData.addressStr), peerId));
            responsePromises.push(this.node.p2pNetwork.sendMessage(peerIdStr, { type: 'getStatus' }));
        }

        /** @type {PeerInfo[]} */
        const peersInfo = [];
        for (const [peerIdStr, peerData] of peersToSync) {
            if (!peerData.addressStr) { continue; }

            const response = await responsePromises.shift();
            if (!response) { continue; }
            if (!typeof response.currentHeight === 'number') { continue; }

            const { currentHeight, latestBlockHash } = response;
            peersInfo.push({ peerIdStr, currentHeight, latestBlockHash });
        }

        return peersInfo;
    }
    async #handleSyncFailure() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        this.isSyncing = false;
        this.syncFailureCount++;
        this.miniLogger.log('Sync failure occurred, restarting sync process', (m) => { console.error(m); });

        return false;
    }
    /** @param {string} peerIdStr @param {number} peerCurrentHeight */
    async #getMissingBlocks(peerIdStr, peerCurrentHeight) {
        this.node.blockchainStats.state = `syncing with peer ${peerIdStr}`;
        this.miniLogger.log(`Synchronizing with peer ${peerIdStr}`, (m) => { console.info(m); });
        
        let peerHeight = peerCurrentHeight;
        let desiredBlock = this.node.blockchain.currentHeight + 1;
        while (desiredBlock <= peerHeight) {
            const endIndex = Math.min(desiredBlock + MAX_BLOCKS_PER_REQUEST - 1, peerHeight);
            //const response = await this.node.p2pNetwork.sendMessage(peerMultiaddr, { type: 'getBlocks', startIndex, endIndex });
            const response = await this.node.p2pNetwork.sendMessage(peerIdStr, { type: 'getBlocks', startIndex: desiredBlock, endIndex });
            if (!response || typeof response.currentHeight !== 'number' || !Array.isArray(response.blocks)) {
                this.miniLogger.log(`Failed to get currentHeight or serialized blocks by 'getBlocks' request`, (m) => { console.error(m); });
                break;
            }

            const serializedBlocks = response.blocks;
            if (!serializedBlocks) { this.miniLogger.log(`Failed to get serialized blocks`, (m) => { console.error(m); }); break; }
            if (serializedBlocks.length === 0) { this.miniLogger.log(`No blocks found`, (m) => { console.error(m); }); break; }
            
            for (const serializedBlock of serializedBlocks) {
                try {
                    const block = serializer.deserialize.block_finalized(serializedBlock);
                    await this.node.digestFinalizedBlock(block, { skipValidation: false, broadcastNewCandidate: false, isSync: true, persistToDisk: true });
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
    
        const peersInfo = await this.#getAllPeersInfo();
        const consensus = this.#findConsensus(peersInfo);
        if (!consensus) {
            this.miniLogger.log(`Unable to get peers info -> sync failure`, (m) => { console.error(m); });
            await this.#handleSyncFailure();
            return false;
        }

        if (consensus.height <= this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Already at the consensus height #${consensus.height}, no need to sync`, (m) => { console.debug(m); });
            this.isSyncing = false;
            return true;
        }
        
        this.miniLogger.log(`consensusHeight peer height: ${consensus.height}, current height: ${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });

        for (const peerInfo of peersInfo) {
            const { peerIdStr, currentHeight, latestBlockHash } = peerInfo;
            if (latestBlockHash !== consensus.hash) { continue; } // Skip peers with different hash than consensus
            
            this.miniLogger.log(`Attempting to sync with peer ${peerIdStr}`, (m) => { console.info(m); });
            const synchronized = await this.#getMissingBlocks(peerIdStr, currentHeight);
            if (!synchronized) { continue; }
            
            this.miniLogger.log(`Successfully synced with peer ${peerIdStr}`, (m) => { console.info(m); });
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
    /** @param {PeerInfo[]} peersInfo */
    #findConsensus(peersInfo) {
        if (!peersInfo || peersInfo.length === 0) { return false }

        const consensus = { height: 0, peers: 0, hash: '' };
        const consensuses = {};
        for (const peerInfo of peersInfo) {
            const height = peerInfo.currentHeight;
            const hash = peerInfo.latestBlockHash;
            if (!consensuses[height]) { consensuses[height] = {}; }

            consensuses[height][hash] = consensuses[height][hash] ? consensuses[height][hash] + 1 : 1;
            if (consensuses[height][hash] <= consensus.peers) { continue; }

            consensus.height = height;
            consensus.peers = consensuses[height][hash];
            consensus.hash = hash;
        }

        return consensus;
    }
}