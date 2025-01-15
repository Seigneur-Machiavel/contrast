import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { serializer } from '../../utils/serializer.mjs';
import P2PNetwork from './p2p.mjs';
import * as lp from 'it-length-prefixed';
import { pipe } from 'it-pipe';
//import { lpStream } from 'it-length-prefixed-stream';
import ReputationManager from './peers-reputation.mjs';

/**
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("./p2p.mjs").P2PNetwork} P2PNetwork
 * @typedef {import("@libp2p/interface").PeerId} PeerId
 * @typedef {import("@libp2p/interface").Stream} Stream
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
 *
 * @typedef {Object} PeerInfo
 * @property {string} peerId
 * @property {string} address
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 */

export class SyncHandler {
    isSyncing = false;
    syncDisabled = false;
    MAX_BLOCKS_PER_REQUEST = 4;
    /** @type {MiniLogger} */
    miniLogger = new MiniLogger('sync');
    /** @type {Object<string, number>} */
    peersHeights = {};

    /** @param {Node} node */
    constructor(node) {
        /** @type {Node} */
        this.node = node;
        this.syncFailureCount = 0;
    }
    streamHandleCount = 0;
    async #handleIncomingStream(lstream) {
        /** @type {Stream} */
        const stream = lstream.stream;
        if (!stream) { return; }
        
        //const lp = lpStream(stream);
        const peerIdStr = lstream.connection.remotePeer.toString();
        const readablePeerId = peerIdStr.replace('12D3KooW', '').slice(0, 12);
        console.info(`INCOMING STREAM #${this.streamHandleCount++} (${lstream.connection.id}-${stream.id}) from ${readablePeerId}`);
        this.node.p2pNetwork.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);
        
        try {
            const source = lp.decode(stream.source);

            for await (const msg of source) {
                const serializedMsg = msg.subarray();
                const message = serializer.deserialize.rawData(serializedMsg);
                if (!message || typeof message.type !== 'string') { throw new Error('Invalid message format'); }

                this.miniLogger.log(`Received message (type: ${message.type} - ${serializedMsg.length} bytes) from ${readablePeerId}`, (m) => { console.info(m); });
                const validGetBlocksRequest = message.type === 'getBlocks' && typeof message.startIndex === 'number' && typeof message.endIndex === 'number';
                const response = {
                    currentHeight: this.node.blockchain.currentHeight,
                    /** @type {string} */
                    latestBlockHash: this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000",
                    /** @type {Uint8Array<ArrayBufferLike>[] | undefined} */
                    blocks: validGetBlocksRequest
                    ? this.node.blockchain.getRangeOfBlocksByHeight(msgObj.startIndex, msgObj.endIndex, false)
                    : undefined
                };

                const serializedResponse = serializer.serialize.rawData(response);
                const encodedResponse = lp.encode.single(serializedResponse);
                await stream.sink(encodedResponse);
            }
        } catch (err) {
            if (err.code !== 'ABORT_ERR') { this.miniLogger.log(err, (m) => { console.error(m); }); }
            this.miniLogger.log(`Closing incoming stream from ${readablePeerId}`, (m) => { console.info(m); });
            await stream.close();
        }
    }
    async #handleIncomingStreamPIPE(lstream) {
        /** @type {Stream} */
        const stream = lstream.stream;
        if (!stream) { return; }
        
        //const lp = lpStream(stream);
        const peerIdStr = lstream.connection.remotePeer.toString();
        const readablePeerId = peerIdStr.replace('12D3KooW', '').slice(0, 12);
        console.info(`INCOMING STREAM #${this.streamHandleCount++} (${lstream.connection.id}-${stream.id}) from ${readablePeerId}`);
        this.node.p2pNetwork.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);
        
        try {
            //const source = lp.decode(stream.source);
            await pipe(
                stream.source, // Flux of incoming messages
                source => lp.decode(source), // Decoder for length-prefixed messages
                async function (source) {
                    //while (true) {
                        for await (const msgUint8 of source) {
                            const serialized = msgUint8.subarray();
                            const msg = serializer.deserialize.rawData(serialized.subarray());
                            if (!msg || typeof msg.type !== 'string') { throw new Error('Invalid message format'); }
                            this.miniLogger.log(`Received message (type: ${msg.type} - ${serialized.length} bytes) from ${readablePeerId}`, (m) => { console.info(m); });
                            
                            const validGetBlocksRequest = msg.type === 'getBlocks' && typeof msg.startIndex === 'number' && typeof msg.endIndex === 'number';
                            const response = {
                                currentHeight: this.node.blockchain.currentHeight,
                                /** @type {string} */
                                latestBlockHash: this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000",
                                /** @type {Uint8Array<ArrayBufferLike>[] | undefined} */
                                blocks: validGetBlocksRequest
                                ? this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false)
                                : undefined
                            };
                            
                            const serializedResponse = serializer.serialize.rawData(response);
                            this.miniLogger.log(`Sending response (type: ${msg.type} - ${serializedResponse.length} bytes) to ${readablePeerId}`, (m) => { console.info(m); });
                            await pipe([serializedResponse], lp.encode, stream.sink);
                            //const encodedResponse = lp.encode.single(serializer.serialize.rawData(response));
                            //await stream.sink(encodedResponse);
                        }
                        console.info(`END OF STREAM from ${readablePeerId}`);
                    //}
                }.bind(this)
            );
        } catch (err) {
            if (err.code !== 'ABORT_ERR') { this.miniLogger.log(err, (m) => { console.error(m); }); }
            this.miniLogger.log(`Closing incoming stream from ${readablePeerId}`, (m) => { console.info(m); });
            await stream.close();
        }

        //await stream.close();
    }
    async #handleIncomingStreamNOPIPE(lstream) {
        /** @type {Stream} */
        const stream = lstream.stream;
        if (!stream) { return; }
        
        const peerIdStr = lstream.connection.remotePeer.toString();
        const readablePeerId = peerIdStr.replace('12D3KooW', '').slice(0, 12);
        console.info(`INCOMING STREAM #${this.streamHandleCount++} (${lstream.connection.id}-${stream.id}) from ${readablePeerId}`);
        this.node.p2pNetwork.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.SYNC_INCOMING_STREAM);

        try {
            const lp = lpStream(stream, { maxDataLength: 2**21 });
            const serialized = await lp.read();
            const msg = serializer.deserialize.rawData(serialized.subarray());
            if (!msg || typeof msg.type !== 'string') { throw new Error('Invalid message format'); }

            this.miniLogger.log(`Received message (type: ${msg.type}${msg.type === 'getBlocks' ? `: ${msg.startIndex}-${msg.endIndex}` : ''} | ${serialized.length} bytes) from ${readablePeerId}`, (m) => { console.info(m); });
            const validGetBlocksRequest = msg.type === 'getBlocks' && typeof msg.startIndex === 'number' && typeof msg.endIndex === 'number';
            const response = {
                currentHeight: this.node.blockchain.currentHeight,
                /** @type {string} */
                latestBlockHash: this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000",
                /** @type {Uint8Array<ArrayBufferLike>[] | undefined} */
                blocks: validGetBlocksRequest
                ? this.node.blockchain.getRangeOfBlocksByHeight(msg.startIndex, msg.endIndex, false)
                : undefined
            };

            const serializedResponse = serializer.serialize.rawData(response);
            this.miniLogger.log(`Sending response (type: ${msg.type} | ${serializedResponse.length} bytes) to ${readablePeerId}`, (m) => { console.info(m); });

            if (validGetBlocksRequest) {
                console.log('toto');
            }
            await lp.write(serializedResponse);
        } catch (err) {
            if (err.code !== 'ABORT_ERR') { this.miniLogger.log(err, (m) => { console.error(m); }); }
            if (!stream || stream.status !== 'open') { return; }
            this.miniLogger.log(`Closing incoming stream from ${readablePeerId}`, (m) => { console.info(m); });
            await stream.close();
        }
    }
    async #getAllPeersInfo() {
        const peersToSync = Object.keys(this.node.p2pNetwork.peers);
        const responsePromises = [];

        for (const peerIdStr of peersToSync) {
            responsePromises.push(this.node.p2pNetwork.sendMessage(peerIdStr, { type: 'getStatus' }));
        }

        /** @type {PeerInfo[]} */
        const peersInfo = [];
        for (const peerIdStr of peersToSync) {
            const response = await responsePromises.shift();
            if (!response) { continue; }
            if (!typeof response.currentHeight === 'number') { continue; }

            const { currentHeight, latestBlockHash } = response;
            peersInfo.push({ peerIdStr, currentHeight, latestBlockHash });
            this.peersHeights[peerIdStr] = currentHeight;
        }

        return peersInfo;
    }
    #handleSyncFailure() {
        const snapshotsHeights = this.node.snapshotSystem.getSnapshotsHeights();
        
        // METHOD 1: try to sync from snapshots
        // if syncFailureCount is a multiple of 10, try to sync from snapshots
        /*if (this.syncFailureCount > 0 && this.syncFailureCount % 6 === 0 && snapshotsHeights.length > 0) {
            // retry sync from snapshots, ex: 15, 10, 5.. 15, 10, 5.. Etc...
            const modulo = (this.syncFailureCount / 6) % snapshotsHeights.length;
            const previousSnapHeight = snapshotsHeights[snapshotsHeights.length - 1 - modulo];
            this.node.loadSnapshot(previousSnapHeight, false); // non-destructive
        }*/

        // METHOD 2: restart the node
        // if syncFailureCount is a multiple of 10, restart the node
        if (this.syncFailureCount > 0 && this.syncFailureCount % 10 === 0) {
            this.miniLogger.log(`Restarting the node after ${this.syncFailureCount} sync failures`, (m) => { console.error(m); });
            this.node.restartRequested = 'syncFailure (this.syncFailureCount % 10)';
            return false;
        }

        this.syncFailureCount++;
        this.miniLogger.log('Sync failure occurred, restarting sync process', (m) => { console.error(m); });

        return false;
    }
    gmbCounter = 0;
    /** @param {string} peerIdStr @param {number} peerCurrentHeight */
    async #getMissingBlocks(peerIdStr, peerCurrentHeight) {
        this.gmbCounter++;
        this.node.blockchainStats.state = `syncing with peer ${peerIdStr}`;
        //this.miniLogger.log(`Synchronizing with peer ${peerIdStr}`, (m) => { console.info(m); });
        this.miniLogger.log(`Synchronizing with peer ${peerIdStr} (gmb: ${this.gmbCounter})`, (m) => { console.info(m); });
        
        let peerHeight = peerCurrentHeight;
        let desiredBlock = this.node.blockchain.currentHeight + 1;
        while (desiredBlock <= peerHeight) {
            const endIndex = Math.min(desiredBlock + this.MAX_BLOCKS_PER_REQUEST - 1, peerHeight);
            const response = await this.node.p2pNetwork.sendMessage(peerIdStr, { type: 'getBlocks', startIndex: desiredBlock, endIndex });
            if (!response || typeof response.currentHeight !== 'number' || !Array.isArray(response.blocks)) {
                this.miniLogger.log(`'getBlocks ${desiredBlock}-${endIndex}' request failed`, (m) => { console.error(m); });
                break;
            }

            const serializedBlocks = response.blocks;
            if (!serializedBlocks) { this.miniLogger.log(`Failed to get serialized blocks`, (m) => { console.error(m); }); break; }
            if (serializedBlocks.length === 0) { this.miniLogger.log(`No blocks received`, (m) => { console.error(m); }); break; }
            
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
    /** @param {P2PNetwork} p2pNetwork */
    async start(p2pNetwork) {
        p2pNetwork.p2pNode.handle(P2PNetwork.SYNC_PROTOCOL, this.#handleIncomingStream.bind(this));
        this.miniLogger.log('SyncHandler started', (m) => { console.info(m); });
    }
    async syncWithPeers() {
        if (this.syncDisabled) { return 'Already at the consensus height'; }

        this.miniLogger.log(`syncWithPeers started at #${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });
        this.node.blockchainStats.state = "syncing";
    
        const peersInfo = await this.#getAllPeersInfo();
        const consensus = this.#findConsensus(peersInfo);
        if (!consensus) {
            this.miniLogger.log(`Unable to get consensus -> sync failure`, (m) => { console.error(m); });
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return this.#handleSyncFailure();
        }

        if (consensus.height <= this.node.blockchain.currentHeight) {
            this.miniLogger.log(`Already at the consensus height #${consensus.height}, no need to sync`, (m) => { console.debug(m); });
            return 'Already at the consensus height';
        }
        
        this.miniLogger.log(`consensusHeight #${consensus.height}, current #${this.node.blockchain.currentHeight}`, (m) => { console.info(m); });

        for (const peerInfo of peersInfo) {
            const { peerIdStr, currentHeight, latestBlockHash } = peerInfo;
            if (latestBlockHash !== consensus.hash) { continue; } // Skip peers with different hash than consensus
            
            this.miniLogger.log(`Attempting to sync with peer ${peerIdStr}`, (m) => { console.info(m); });
            const synchronized = await this.#getMissingBlocks(peerIdStr, currentHeight);
            if (!synchronized) { continue; }
            
            this.miniLogger.log(`Successfully synced with peer ${peerIdStr}`, (m) => { console.info(m); });
            break; // Sync successful, break out of loop
        }
        
        if (consensus.height > this.node.blockchain.currentHeight) { return this.#handleSyncFailure(); }
        
        this.miniLogger.log(`Sync process finished at #${this.node.blockchain.currentHeight}`, (m) => { console.debug(m); });
        return true;
    }
}