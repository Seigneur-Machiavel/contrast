import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';

/**
 * @typedef {import("@multiformats/multiaddr").Multiaddr} Multiaddr
 * @typedef {import("../../utils/time.mjs").TimeSynchronizer} TimeSynchronizer
 */

class PeerFloodCounter {
    maxEventsPerMinute = { CONNECT: 5 }
    eventsTimestamps = { CONNECT: [] };

    constructor() {}
    /** @param {'CONNECT' | 'RESERVATION'} type @param {number} timestamp */
    isAuthorized(type, timestamp) {
        this.eventsTimestamps[type] = this.eventsTimestamps[type].filter(eventTimestamp => eventTimestamp > timestamp - 60000);
        return this.eventsTimestamps[type].length + 1 <= this.maxEventsPerMinute[type];
    }
    /** @param {'CONNECT' | 'RESERVATION'} type @param {number} timestamp */
    new(type, timestamp) {
        this.eventsTimestamps[type].push(timestamp);
        return timestamp;
    }
}

/**
 * Informations about a peer can be furnished by the peer himself or by other peers
 * Theses informations cannot be considered as reliable
 */
class Peer {
    updateTime = 0; // timestamp
    /** @type {string | undefined} Not includes "/p2p/..." */
    directAddr;
    /** @type {string[]} The peers that are directly connected to this peer */
    neighboursIds = [];
    /** @type {string[]} The peers that can be use as relay to connect to this peer (can be empty) */
    relayedTroughsIds = [];

    floodCounter = new PeerFloodCounter();
}

export class PeersManager {
    /** @type {TimeSynchronizer} */
    timeSynchronizer;
    /** @type {Object<string, Peer>} */
    store = {}; // by peerIdStr
    /** @type {string | undefined} */
    idStr; // my peerIdStr

    constructor() {}

    // re simplify , only two case
    /** @param {string} peerIdStr @param {string} neighbourIdStr @param {number} timestamp */
    setNeighbours(peerIdStr, neighbourIdStr, timestamp) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        if (!this.store[peerIdStr].neighboursIds.includes(neighbourIdStr))
            if (this.updateTimeIfNotOutdated(peerIdStr, timestamp))
                this.store[peerIdStr].neighboursIds.push(neighbourIdStr);
        
        if (!this.store[neighbourIdStr]) this.store[neighbourIdStr] = new Peer();
        if (!this.store[neighbourIdStr].neighboursIds.includes(peerIdStr))
            if (this.updateTimeIfNotOutdated(neighbourIdStr, timestamp))
                this.store[neighbourIdStr].neighboursIds.push(peerIdStr);
    }
    /** @param {string} peerIdStr @param {string} neighbourIdStr */
    unsetNeighbours(peerIdStr, neighbourIdStr, timestamp) {
        const indexA = this.store[peerIdStr]?.neighboursIds.indexOf(neighbourIdStr);
        if (indexA && indexA >= 0 && this.updateTimeIfNotOutdated(peerIdStr, timestamp))
            this.store[peerIdStr].neighboursIds.splice(indexA, 1);

        const indexB = this.store[neighbourIdStr]?.neighboursIds.indexOf(peerIdStr);
        if (indexB && indexB >= 0 && this.updateTimeIfNotOutdated(neighbourIdStr, timestamp))
            this.store[neighbourIdStr].neighboursIds.splice(indexB, 1);
    }
    /** @param {string} peerIdStr @param {string} relayIdStr @param {number} timestamp */
    addRelayedTrough(peerIdStr, relayIdStr, timestamp) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        if (this.store[peerIdStr].relayedTroughsIds.includes(relayIdStr)) return;
        if (!this.updateTimeIfNotOutdated(peerIdStr, timestamp)) return;

        this.store[peerIdStr].relayedTroughsIds.push(relayIdStr);
    }
    /** @param {string} peerIdStr @param {string} relayIdStr @param {number} timestamp */
    removeRelayedTrough(peerIdStr, relayIdStr, timestamp) {
        if (!this.store[peerIdStr]) return;
        
        const index = this.store[peerIdStr].relayedTroughsIds.indexOf(relayIdStr);
        if (index === -1) return;
        if (!this.updateTimeIfNotOutdated(peerIdStr, timestamp)) return;

        this.store[peerIdStr].relayedTroughsIds.splice(index, 1);
    }
    /** @param {string} peerIdStr @param {string} addr @param {number} timestamp */
    setPeerDirectAddr(peerIdStr, addr, timestamp) {
        const addrStr = addr.split('/p2p')[0];
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        if (!this.updateTimeIfNotOutdated(peerIdStr, timestamp)) return;

        this.store[peerIdStr].directAddr = addrStr;
    }
    /** @param {string} peerIdStr */
    unsetPeerDirectAddr(peerIdStr, timestamp) {
        if (!this.store[peerIdStr]) return;
        if (!this.updateTimeIfNotOutdated(peerIdStr, timestamp)) return;

        this.store[peerIdStr].directAddr = undefined;
    }
    /** @param {string} peerIdStr @param {number} [timestamp] */
    updateTimeIfNotOutdated(peerIdStr, timestamp) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        const lastUpdateTime = this.store[peerIdStr]?.updateTime || 0;

        if (lastUpdateTime > timestamp) return false;
        this.store[peerIdStr].updateTime = timestamp;
        return true;
    }

    /** @param {number} timestamp */
    #validTimestamp(timestamp) {
        if (typeof timestamp !== 'number') return;
        if (timestamp % 1 !== 0) return;
        if (timestamp < 0) return;

        const now = this.timeSynchronizer?.getCurrentTime() || Date.now();
        if (timestamp > now) return;
        return true;
    }
    /** @param {string} addr */
    #destructureAddr(addr) {
        return {
            peerIdStr: addr.split('/p2p/')[1].split('/')[0], 
            relayedIdStr: addr.split('/p2p-circuit/p2p/')[1] // can be undefined
        }
    }
    /** @param {string} id @param {string} addr @param {number} [timestamp] */
    digestSelfUpdateAddEvent(id, addr, timestamp) {
        if (typeof id !== 'string' || typeof addr !== 'string') return;
        if (!this.#validTimestamp(timestamp)) return;
        if (!addr.endsWith('p2p-circuit')) { this.setPeerDirectAddr(id, addr, timestamp); return; }

        // new address to reach the peer published by the peer itself
        const { peerIdStr, relayedIdStr } = this.#destructureAddr(addr);
        if (!peerIdStr) return;
        this.addRelayedTrough(id, peerIdStr, timestamp);
    }
    /** @param {string} id @param {string} addr @param {number} [timestamp] */
    digestSelfUpdateRemoveEvent(id, addr, timestamp) {
        if (typeof id !== 'string' || typeof addr !== 'string') return;
        if (!this.#validTimestamp(timestamp)) return;

        // address to reach the peer published by the peer itself is no longer valid
        if (!addr.endsWith('p2p-circuit')) { this.unsetPeerDirectAddr(id, timestamp); return; } // should not append

        const { peerIdStr, relayedIdStr } = this.#destructureAddr(addr);
        if (!peerIdStr) return;
        this.removeRelayedTrough(id, peerIdStr, timestamp);
    }
    /** @param {string} id emitter peerIdStr @param {string} addr MultiAddress.toString() @param {number} timestamp */
    digestConnectEvent(id, addr, timestamp) {
        if (typeof id !== 'string' || typeof addr !== 'string') return;
        if (!this.#validTimestamp(timestamp)) return;

        const address = addr.endsWith('p2p-circuit') ? `${addr}/p2p/${id}` : addr;
        if (!address.includes('/p2p/')) return;
        const { peerIdStr, relayedIdStr } = this.#destructureAddr(address);

        if (id !== peerIdStr) this.setNeighbours(peerIdStr, id, timestamp);
        if (!relayedIdStr) this.setPeerDirectAddr(peerIdStr, address, timestamp);
        else if (id === relayedIdStr) this.addRelayedTrough(id, peerIdStr, timestamp);
        else (this.addRelayedTrough(relayedIdStr, peerIdStr, timestamp)); // not very reliable
    }
    /** @param {string} id @param {string} peerIdStr @param {number} timestamp */
    digestDisconnectEvent(id, peerIdStr, timestamp) {
        if (!this.#validTimestamp(timestamp)) return;
        this.unsetNeighbours(peerIdStr, id, timestamp);
        this.removeRelayedTrough(peerIdStr, id, timestamp);
    }

    lastPeerGivenIndex = 0;
    getNextConnectablePeer(directOnly = false) {
        const peersId = Object.keys(this.store);
        if (peersId.length === 0) return;

        let i = (this.lastPeerGivenIndex + 1) % peersId.length;
        for (i; i < peersId.length; i++) {
            const peerIdStr = peersId[i];
            if (this.idStr === peerIdStr) continue; // skip myself

            const peer = this.store[peerIdStr];
            if (directOnly && !peer.directAddr) continue;
            this.lastPeerGivenIndex = i;
            return { peerIdStr, peer };
        }
    }
    /**
     * @param {string} peerIdStr - The peerId of the peer to connect to
     * @param {import("libp2p").Libp2p} [p2pNode] - *optional* The libp2p node to use to build the multiaddrs if connection to the relay exists (useful in case of local network)
     */
    buildMultiAddrs(peerIdStr, p2pNode) {
        const peer = this.store[peerIdStr];
        const existingCon = p2pNode?.getConnections(peerIdFromString(peerIdStr)).filter(con => !con.limits)[0];
        const existingAddr = existingCon?.remoteAddr;
        if (existingAddr) return [existingAddr];
        if (peer.directAddr) return [multiaddr(`${peer.directAddr}/p2p/${peerIdStr}`)];

        let relayedAddrs = [];
        for (const relayIdStr of peer.relayedTroughsIds) {
            const existingDirectCon = p2pNode?.getConnections(peerIdFromString(relayIdStr)).filter(con => !con.limits)[0];
            const existingAddr = existingDirectCon?.remoteAddr.toString().split('/p2p/')[0];
            const relayAddrStr = existingAddr || this.store[relayIdStr]?.directAddr;
            if (!relayAddrStr) continue;

            const relayedAddrStr = `${relayAddrStr}/p2p/${relayIdStr}/p2p-circuit/p2p/${peerIdStr}`;
            relayedAddrs.push(multiaddr(relayedAddrStr));
        }
        return relayedAddrs;
    }

    /** @param {string} peerIdStr @param {'CONNECT' | 'RESERVATION'} type */
    isLocalEventAuthorized(peerIdStr, type) {
        if (!this.store[peerIdStr]) return false;
        const timestamp = this.timeSynchronizer?.getCurrentTime() || Date.now();
        return this.store[peerIdStr].floodCounter.isAuthorized(type, timestamp);
    }
    /** @param {string} peerIdStr @param {'CONNECT' | 'RESERVATION'} type */
    localEvent(peerIdStr, type) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        const timestamp = this.timeSynchronizer?.getCurrentTime() || Date.now();
        if (!this.store[peerIdStr].floodCounter.isAuthorized(type, timestamp)) return false;

        return this.store[peerIdStr].floodCounter.new(type, timestamp);
    }
}