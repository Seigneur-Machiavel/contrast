import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { kadDHT } from '@libp2p/kad-dht';
import { multiaddr } from '@multiformats/multiaddr';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { yamux } from '@chainsafe/libp2p-yamux';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import EventEmitter from 'events';
import { pipe } from 'it-pipe';
import { concat as uint8ArrayConcat } from 'uint8arrays/concat';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { convert } from '../../../utils/converters.mjs';


const BOOTSTRAP_LIST = [
    '',
/*     '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa', */
];

const MAX_HISTORY = 100;


export class P2P extends EventEmitter {
    constructor(nickname, listenAddr, options = {}) {
        super();
        this.nickname = nickname;
        this.node = null;
        this.channels = new Set();
        this.channelPrefix = '@@p2pchat/';
        this.peers = new Set();
        this.bootstrapNodes = options.bootstrapNodes || BOOTSTRAP_LIST;
        this.lastBootstrap = Date.now();
        this.messageHistory = new Map();
        this.listenAddr = listenAddr;
        this.dhtStats = {
            found: [],
            connected: [],
            errors: []
        };
        this.files = new Map(); // Map<cid, metadata>
        this.chunkSize = 1024 * 256;
        this.uniqueHash = options.uniqueHash || this.#generateRandomNonce(32);
    }

    #generateRandomNonce(length) {
        return Array.from(crypto.getRandomValues(new Uint8Array(length)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
    async start() {
        console.log(` Address: ${this.listenAddr} started p2p chat`);
        const hashUint8Array = convert.hex.toUint8Array(this.uniqueHash);
        const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);

        const dht = kadDHT({
            protocol: '/ipfs/kad/1.0.0',
            clientMode: false,
            protocolPrefix: '/dchat',
            timeout: 3000
        });
        this.node = await createLibp2p({
            addresses: {listen: [this.listenAddr, '/ip4/0.0.0.0/tcp/0' ]},
            transports: [tcp()],
            streamMuxers: [yamux()],
            connectionEncrypters: [noise()],
            privateKey: privateKeyObject,
            services: {
                identify: identify({
                    protocolPrefix: '/dchat',
                    host: { agentVersion: 'p2pchat/1.0.0' },
                    push: true
                }),
                pubsub: gossipsub({
                    allowPublishToZeroPeers: true,
                    emitSelf: true,
                    heartbeatInterval: 1000,
                    directPeers: []
                }),
                dht: dht
            },
            peerDiscovery: [
                mdns({
                    interval: 1000,
                    enabled: true,
                    serviceTag: 'dchat', 
                    broadcast: true, 
                    timeout: 1000,
                    ttl: 120
                }),
                bootstrap({
                    list: this.bootstrapNodes,
                    timeout: 3000,
                }),  
            ],
            connectionManager: {
                minConnections: 5,
                maxConnections: 50,
                pollInterval: 2000,
                autoDial: true,
                maxParallelDials: 5,
                dialTimeout: 30000,
            },

        });
        this.node.services.pubsub.addEventListener('message', msg => {
            try {
                const { topic, data } = msg.detail;
                const channel = topic.replace(this.channelPrefix, '');
                const parsed = JSON.parse(uint8ArrayToString(data));
                
                console.log(`📨 [${this.nickname}] Message in ${channel}:`, {
                    type: parsed.type || 'chat',
                    from: parsed.nickname || parsed.from,
                    content: parsed.content?.slice(0, 50),
                    timestamp: parsed.timestamp
                });
    
                // Handle different message types
                switch(parsed.type) {
                    case 'history_request':
                        this._sendChannelHistory(channel, parsed.requestId, parsed.from);
                        break;
                        
                    case 'history_response':
                        if (parsed.requestId === this._lastHistoryRequest) {
                            console.log(`📚 [${this.nickname}] Got history for ${channel}: ${parsed.messages.length} messages`);
                            this._updateHistory(channel, parsed.messages);
                            parsed.messages.forEach(msg => this.emit('message', { ...msg, channel }));
                        }
                        break;
    
                    case 'file:metadata': 
                        this.files.set(parsed.data.cid, parsed.data);
                        console.log(`📁 [${this.nickname}] Stored file metadata:`, {
                            cid: parsed.data.cid,
                            name: parsed.data.filename,
                            channel: parsed.data.channel
                        });
                        break;
    
                    default: // Regular chat message
                        const latency = Date.now() - parsed.timestamp;
                        const messageData = {
                            from: parsed.nickname,
                            content: parsed.content,
                            timestamp: parsed.timestamp,
                            latency
                        };
    
                        if (parsed.content?.startsWith('/file ')) {
                            const [_, filename, cid, size, type] = parsed.content.split(' ');
                            if (!this.files.has(cid)) {
                                // Request metadata if we don't have it
                                this.node.services.pubsub.publish(
                                    this.channelPrefix + channel,
                                    uint8ArrayFromString(JSON.stringify({
                                        type: 'file:request',
                                        cid,
                                        from: this.nickname,
                                        timestamp: Date.now()
                                    }))
                                );
                            }
                        }
    
                        this._addToHistory(channel, messageData);
                        this.emit('message', { channel, ...messageData });
                }
            } catch (err) {
                console.error(`📛 [${this.nickname}] Message error:`, err);
                this.dhtStats.errors.push({ type: 'message', error: err.message });
            }
        });
        this.node.addEventListener('peer:connect', async (evt) => {
            const peerId = evt.detail.toString();
            if (!this.peers.has(peerId)) {
                this.peers.add(peerId);
                console.log(`🤝 [${this.nickname}] Connected (CM): ${peerId}`);
                this.dhtStats.connected.push(peerId);
                this.emit('peer-joined', peerId);
            }
        });
        this.node.addEventListener('peer:disconnect', evt => {
            const peerId = evt.detail.toString();
            this.peers.delete(peerId);
            console.log(`👋 [${this.nickname}] Disconnected: ${peerId}`);
            this.emit('peer-left', peerId);
        });
        this.node.addEventListener('peer:discovery', async (evt) => {
            const peerId = evt.detail.id.toString();
            console.log(`🔍 [${this.nickname}] Discovered:`, peerId);
            
            // Check if we're already connected
            if (!this.peers.has(peerId)) {
                try {
                    await this.node.dial(evt.detail.id);
                    // Connection event will handle the rest
                } catch (err) {
                    console.error(`❌ [${this.nickname}] Peer connection failed:`, err.message);
                    this.dhtStats.errors.push({ peerId, error: err.message });
                }
            }
        });
    
        
        await this.node.handle('/file-transfer/1.0.0', async ({ stream }) => {
            try {
                const chunks = await pipe(
                    stream,
                    async function* (source) {
                        for await (const chunk of source) {
                            yield chunk;
                        }
                    }
                );
                
                const data = uint8ArrayConcat(chunks);
                const fileData = JSON.parse(uint8ArrayToString(data));
                
                this.files.set(fileData.cid, fileData);
                console.log(`📁 [${this.nickname}] Received file metadata:`, {
                    filename: fileData.filename,
                    size: fileData.size,
                    cid: fileData.cid,
                    channel: fileData.channel
                });
        
                // Broadcast to channel
                await this.sendMessage(fileData.channel, `/file ${fileData.filename} ${fileData.cid} ${fileData.size} ${fileData.type}`);
            } catch (err) {
                console.error(`📛 [${this.nickname}] File transfer error:`, err);
            }
        });
    
        await this.node.start();
        console.log(`🚀 [${this.nickname}] Started:`, this.node.peerId.toString());
        
        await this.joinChannel('system');
    
        // concat all the addresses in multiaddr format
        return this.getMultiaddrs().map(ma => ma.toString() + '\n\n').join('');
    }
    getMultiaddrs() {
        return this.node.getMultiaddrs().map(ma => ma.toString());
    }

    _addToHistory(channel, message) {
        if (!this.messageHistory.has(channel)) {
            this.messageHistory.set(channel, []);
        }
        const history = this.messageHistory.get(channel);
        history.push(message);
        if (history.length > MAX_HISTORY) {
            history.shift(); // Keep size bounded
        }
    }
    _updateHistory(channel, messages) {
        this.messageHistory.set(channel, messages.slice(-MAX_HISTORY));
    }
    _generateRequestId() {
        return `${this.nickname}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    async _requestHistory(channel) {
        const requestId = this._generateRequestId();
        this._lastHistoryRequest = requestId; // Store for validation
        
        await this.node.services.pubsub.publish(
            this.channelPrefix + channel,
            uint8ArrayFromString(JSON.stringify({
                type: 'history_request',
                from: this.nickname,
                requestId,
                timestamp: Date.now()
            }))
        );
    }
    async _sendChannelHistory(channel, requestId, requester) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
        
        const history = this.messageHistory.get(channel) || [];
        await this.node.services.pubsub.publish(
            this.channelPrefix + channel,
            uint8ArrayFromString(JSON.stringify({
                type: 'history_response',
                messages: history,
                requestId,
                timestamp: Date.now()
            }))
        );
        console.log(`📚 [${this.nickname}] Sent history to ${requester}: ${history.length} messages`);
    }

    async joinChannel(channel) {
        const topicName = this.channelPrefix + channel;
        if (!this.channels.has(channel)) {
            await this.node.services.pubsub.subscribe(topicName);
            this.channels.add(channel);
            console.log(`📻 [${this.nickname}] Joined: ${channel}`);
            
            // Add a small delay to let subscriptions propagate
            await new Promise(resolve => setTimeout(resolve, 100));

            try {
                // Only try to send join message if we have peers
                const peers = Array.from(await this.node.services.pubsub.getSubscribers(topicName));
                if (peers.length > 0) {
                    await this.sendMessage(channel, '/join');
                    console.log(`👋 [${this.nickname}] Announced join to ${peers.length} peers in ${channel}`);
                } else {
                    console.log(`🔕 [${this.nickname}] No peers in ${channel} yet, skipping join announcement`);
                }
                
                // Request history only if there are peers
                if (peers.length > 0) {
                    await this._requestHistory(channel);
                }
            } catch (err) {
                // Don't throw on announcement failure, just log it
                console.warn(`⚠️ [${this.nickname}] Join announcement failed in ${channel}:`, err.message);
            }
        }
    }
    async leaveChannel(channel) {
        const topicName = this.channelPrefix + channel;
        if (this.channels.has(channel)) {
            await this.sendMessage(channel, '/leave').catch(err => {
                console.error(`📛 [${this.nickname}] Leave message failed:`, err.message);
            });
            await this.node.services.pubsub.unsubscribe(topicName);
            this.channels.delete(channel);
            console.log(`🚪 [${this.nickname}] Left: ${channel}`);
        }
    }
    async sendMessage(channel, content) {
        if (!this.channels.has(channel)) {
            throw new Error(`Not subscribed to: ${channel}`);
        }

        const message = {
            nickname: this.nickname,
            content,
            timestamp: Date.now()
        };

        await this.node.services.pubsub.publish(
            this.channelPrefix + channel,
            uint8ArrayFromString(JSON.stringify(message))
        );

        console.log(`📤 [${this.nickname}] Sent to ${channel}:`, content.slice(0, 50) + (content.length > 50 ? '...' : ''));
    }
    async connectToPeer(addr) {
        try {
            await this.node.dial(multiaddr(addr));
            console.log(`🔗 [${this.nickname}] Connected to: ${addr}`);
            return true;
        } catch (err) {
            console.error(`📛 [${this.nickname}] Connection failed to ${addr}:`, err.message);
            this.dhtStats.errors.push({ addr, error: err.message });
            return false;
        }
    }

    async shareFile(channel, file) {
        try {
            console.log(`📤 [${this.nickname}] Sharing file in ${channel}:`, {
                name: file.name, size: file.size, type: file.type
            });

            // Collect file data
            const chunks = [];
            let totalRead = 0;
            for await (const chunk of file.stream()) {
                chunks.push(chunk);
                totalRead += chunk.length;
                this.emit('file-progress', {
                    channel, filename: file.name,
                    progress: Math.floor((totalRead / file.size) * 100)
                });
            }

            
            const content = uint8ArrayConcat(chunks);
            const result = await this.ipfs.add(content);
            await this.ipfs.pin.add(result.cid);

            const fileData = {
                cid: result.cid.toString(),
                filename: file.name,
                size: file.size,
                type: file.type,
                sender: this.nickname,
                timestamp: Date.now(),
                channel
            };

            
            this.files.set(fileData.cid, fileData);

            
            await this._broadcastFileMetadata(fileData);

            // Announce file in channel
            await this.sendMessage(channel, `/file ${file.name} ${fileData.cid} ${file.size} ${file.type}`);

            console.log(`✅ [${this.nickname}] File shared successfully:`, {
                cid: fileData.cid,
                name: file.name,
                size: this.#formatSize(file.size)
            });

            return fileData.cid;
        } catch (err) {
            console.error(`❌ [${this.nickname}] File share failed:`, err);
            throw err;
        }
    }
    async downloadFile(cid) {
        try {
            const fileData = this.files.get(cid); 
            
            if (!fileData) {
                console.error(`❌ [${this.nickname}] File metadata not found for CID:`, cid);
                throw new Error('File metadata not found');
            }
            
            console.log(`📥 [${this.nickname}] Downloading file:`, {
                cid,
                filename: fileData.filename,
                size: this.#formatSize(fileData.size),
                channel: fileData.channel
            });
            
            const chunks = [];
            for await (const chunk of this.ipfs.cat(cid)) {
                chunks.push(chunk);
            }
            
            const content = uint8ArrayConcat(chunks);
            console.log(`✅ [${this.nickname}] Downloaded file:`, fileData.filename);
            
            return { content, metadata: fileData };
        } catch (err) {
            console.error(`📛 [${this.nickname}] File download error:`, err);
            throw err;
        }
    }
    #formatSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = parseInt(bytes);
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit++;
        }
        return `${size.toFixed(1)} ${units[unit]}`;
    }

    async _broadcastFileMetadata(fileData) {
        await this.node.services.pubsub.publish(
            this.channelPrefix + fileData.channel,
            uint8ArrayFromString(JSON.stringify({
                type: 'file:metadata',
                data: fileData
            }))
        );
    }
    async _requestFileMetadata(channel, cid) {
        await this.node.services.pubsub.publish(
            this.channelPrefix + channel,
            uint8ArrayFromString(JSON.stringify({
                type: 'file:request',
                cid,
                from: this.nickname
            }))
        );
    }
    async _sendFileMetadata(fileData) {
        await this._broadcastFileMetadata(fileData);
    }

    getChannels() { 
        return Array.from(this.channels);
    }
    getPeers() { 
        return Array.from(this.peers);
    }
    getDHTStats() { 
        return { 
            ...this.dhtStats,
            uptime: Date.now() - this.lastBootstrap,
            peersCount: this.peers.size,
            channels: this.getChannels()
        };
    }
    async stop() {
        if (this.node) {
            for (const channel of this.channels) {
                await this.leaveChannel(channel).catch(err => {
                    console.error(`📛 [${this.nickname}] Error leaving ${channel}:`, err.message);
                });
            }
            
            await this.node.stop();
            this.node = null;
            console.log(`🛑 [${this.nickname}] Stopped`);
        }
    }
}