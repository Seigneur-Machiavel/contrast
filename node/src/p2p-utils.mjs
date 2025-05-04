import { serializer } from '../../utils/serializer.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { Breather } from '../../utils/breather.mjs';

/**
 * @typedef {import('@multiformats/multiaddr').Multiaddr} Multiaddr
 * @typedef {import("@libp2p/interface").Stream} Stream
 */

export class P2P_OPTIONS {
    DIRECT_PORTS = ['27260', '27261', '27262', '27263', '27264', '27265', '27266', '27267', '27268', '27269'];
}

export class PROTOCOLS {
    static RELAY_SHARE = '/relay-share/1.0.0'; // to connect to relayed peers
    static SDP_EXCHANGE = '/webrtc-sdp/1.0.0'; // to exchange SDP offers/answers
    static SYNC = '/blockchain-sync/1.0.0'; // to sync blockchain data and peers status
}

export class STREAM {
    static MAX_CHUNK_SIZE = 64 * 1024; // 64 KB
    static MAX_STREAM_BYTES = 1024 * 1024 * 1024; // 1 GB
    static NEW_DIRECT_STREAM_OPTIONS = () => { return { signal: AbortSignal.timeout(3_000) } };
    static NEW_RELAYED_STREAM_OPTIONS = () => { return { runOnLimitedConnection: true, signal: AbortSignal.timeout(3_000) } };

    /** @param {Stream} stream @param {Uint8Array} serializedMessage @param {number} [maxChunkSize] */
    static async WRITE(stream, serializedMessage, maxChunkSize = STREAM.MAX_CHUNK_SIZE) {
        const breather = new Breather();
        // limit the speed of sending chunks, at 64 KB/chunk, 1 GB would take:
        // 1 GB / 64 KB = 16384 chunks => 16384 * 2 ms = 32.768 more seconds
        async function* generateChunks(serializedMessage, maxChunkSize, delay = 2) {
            const totalChunks = Math.ceil(serializedMessage.length / maxChunkSize);
            for (let i = 0; i < totalChunks; i++) {
                const start = i * maxChunkSize;
                yield serializedMessage.slice(start, start + maxChunkSize); // send chunk
                await new Promise(resolve => setTimeout(resolve, delay));
                await breather.breathe(); // breathing
            }
        }

        try { await stream.sink( generateChunks(serializedMessage, maxChunkSize) );
        } catch (error) { console.error(error.message); return false; }
        return true;
    }
    /** @param {Stream} stream */
    static async READ(stream) {
        const dataChunks = [];
        for await (const chunk of stream.source) { dataChunks.push(chunk.subarray()); }

        const data = new Uint8Array(Buffer.concat(dataChunks));
        return { data, nbChunks: dataChunks.length };
    }
}

export class FILTERS {
    /**
     * @param {Multiaddr[]} ma
     * @param {'PUBLIC' | 'LOCAL'} [IP] - Filter by public or local IP addresses, PUBLIC ONLY, LOCAL ONLY, default: NO_FILTER
     * @param {'CIRCUIT' | 'NO_CIRCUIT'} [P2P_CIRCUIT] - Filter by p2p-circuit addresses, CIRCUIT ONLY, NO_CIRCUIT, default: NO_FILTER
     * @param {number[]} [PORT_RANGE] - Filter by port range, default: All accepted (undefined)
     */
    static multiAddrs(ma, IP, P2P_CIRCUIT, PORT_RANGE = [27260, 27269]) {
        if (Array.isArray(ma) === false) return [];
        if (IP && typeof IP !== 'string') return [];
        if (P2P_CIRCUIT && typeof P2P_CIRCUIT !== 'string') return [];

        return ma.filter(addr => {
            const addrStr = addr.toString();
            if (P2P_CIRCUIT === 'CIRCUIT' && !addrStr.includes('/p2p-circuit/')) return false;
            if (P2P_CIRCUIT === 'NO_CIRCUIT' && addrStr.includes('/p2p-circuit/')) return false;
            if (IP === 'PUBLIC' && addrStr.match(/\/172\.(1[6-9]|2[0-9]|3[0-1])\./)) return false;
            if (IP === 'LOCAL' && !addrStr.match(/\/172\.(1[6-9]|2[0-9]|3[0-1])\./)) return false;

            const address = addr.nodeAddress().address;
            if (IP === 'PUBLIC' && address.startsWith('127')) return false;
            if (IP === 'PUBLIC' && address.startsWith('192.168')) return false;
            if (IP === 'PUBLIC' && address.startsWith('10.')) return false;
            if (IP === 'LOCAL' && !address.startsWith('127')) return false;
            if (IP === 'LOCAL' && !address.startsWith('192.168')) return false;
            if (IP === 'LOCAL' && !address.startsWith('10.')) return false;

            if (!PORT_RANGE) return true;

            const port = addr.nodeAddress().port;
            if (isNaN(port)) return false;
            if (port < PORT_RANGE[0] || port > PORT_RANGE[1]) return false;

            return true;
        });
    }
    /** @param {Multiaddr[]} multiaddrs */
    static filterRelayAddrs(multiaddrs) {
        return multiaddrs.filter(addr => {
            // PUBLIC ONLY, NO LOCAL, NO CIRCUIT
            const addrStr = addr.toString();
            if (addrStr.match(/\/172\.(1[6-9]|2[0-9]|3[0-1])\./)) return false;
            if (!addrStr.includes('/p2p-circuit/')) return false;

            const address = addr.nodeAddress().address;
            if (address.startsWith('127')) return false;
            if (address.startsWith('192.168')) return false;
            if (address.startsWith('10.')) return false;

            const port = addr.nodeAddress().port;
            if (isNaN(port)) return false;
            if (port < 27260 || port > 27269) return false;

            return true;
        });
    }
}

export class PUBSUB {
    static TOPIC_BROADCAST_DELAY = {
        'self:pub:update:add': 2000,
        'self:pub:update:remove': 2000,
        'pub:connect': 2000,
        'pub:disconnect': 2000,
    }

    static TOPIC_MAX_BYTES = {
        'self:pub:update:add': 2048,
        'self:pub:update:remove': 2048,
        'pub:connect': 2048,
        'pub:disconnect': 1024,
        'new_transaction': BLOCKCHAIN_SETTINGS.maxTransactionSize * 1.02,
        'new_block_candidate': BLOCKCHAIN_SETTINGS.maxBlockSize * 1.04,
        'new_block_finalized': BLOCKCHAIN_SETTINGS.maxBlockSize * 1.05,
    }

    /** Validates the data of incoming pubsub message. @param {string} topic @param {Uint8Array} data */
    static VALIDATE(topic, data, verifySize = true) {
        if (typeof topic !== 'string') {
            console.error(`Received non-string topic: ${topic}`);
            return false;
        }
        if (!PUBSUB.TOPIC_MAX_BYTES[topic]) return false;

        if (!(data instanceof Uint8Array)) {
            console.error(`Received non-binary data dataset: ${data} topic: ${topic}`);
            return false;
        }
        if (!verifySize || data.byteLength <= PUBSUB.TOPIC_MAX_BYTES[topic]) return true;

        console.error(`Message size exceeds maximum allowed size, topic: ${topic}`, (m) => { console.error(m); });
    }
    /** @param {string} topic */
    static SERIALIZE(topic, data) {
        switch (topic) {
            case 'new_transaction': return serializer.serialize.transaction(data);
            case 'new_block_candidate': return serializer.serialize.block_candidate(data);
            case 'new_block_finalized': return serializer.serialize.block_finalized(data);
            default: return serializer.serialize.rawData(data);
        }
    }
    /** @param {string} topic @param {Uint8Array} data */
    static DESERIALIZE(topic, data) {
        switch (topic) {
            case 'new_transaction': return serializer.deserialize.transaction(data);
            case 'new_block_candidate': return serializer.deserialize.block_candidate(data);
            case 'new_block_finalized': return serializer.deserialize.block_finalized(data);
            default: return serializer.deserialize.rawData(data);
        }
    }
}