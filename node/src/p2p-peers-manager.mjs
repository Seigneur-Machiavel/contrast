import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';

/**
 * @typedef {import("@multiformats/multiaddr").Multiaddr} Multiaddr
 */

/**
 * Informations about a peer can be furnished by the peer himself or by other peers
 * Theses informations cannot be considered as reliable
 */
class Peer {
    lastSeen = 0; // timestamp
    /** @type {string | undefined} Not includes "/p2p/..." */
    directAddr;
    /** @type {string[]} The peers that are directly connected to this peer */
    neighboursIds = [];
    /** @type {string[]} The peers that can be use as relay to connect to this peer (can be empty) */
    relayedTroughsIds = [];
}

export class PeersManager {
    /** @type {Object<string, Peer>} */
    store = {}; // by peerIdStr

    /** @type {string | undefined} */
    idStr; // my peerIdStr

    constructor() {}

    // re simplify , only two case
    /** @param {string} peerIdStr @param {string} neighbourIdStr */
    setNeighbours(peerIdStr, neighbourIdStr) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        if (!this.store[peerIdStr].neighboursIds.includes(neighbourIdStr))
            this.store[peerIdStr].neighboursIds.push(neighbourIdStr);
        
        if (!this.store[neighbourIdStr]) this.store[neighbourIdStr] = new Peer();
        if (!this.store[neighbourIdStr].neighboursIds.includes(peerIdStr))
            this.store[neighbourIdStr].neighboursIds.push(peerIdStr);
    }
    /** @param {string} peerIdStr @param {string} relayIdStr */
    addRelayedTrough(peerIdStr, relayIdStr) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        if (this.store[peerIdStr].relayedTroughsIds.includes(relayIdStr)) return;
        this.store[peerIdStr].relayedTroughsIds.push(relayIdStr);
    }
    /** @param {string} peerIdStr @param {string} neighbourIdStr */
    unsetNeighbours(peerIdStr, neighbourIdStr) {
        if (this.store[peerIdStr]) {
            const index = this.store[peerIdStr].neighboursIds.indexOf(neighbourIdStr);
            if (index >= 0) this.store[peerIdStr].neighboursIds.splice(index, 1);
        }

        if (this.store[neighbourIdStr]) {
            const index = this.store[neighbourIdStr].neighboursIds.indexOf(peerIdStr);
            if (index >= 0) this.store[neighbourIdStr].neighboursIds.splice(index, 1);
        }
    }
    /** @param {string} peerIdStr @param {string} relayIdStr */
    removeRelayedTrough(peerIdStr, relayIdStr) {
        if (!this.store[peerIdStr]) return;
        const index = this.store[peerIdStr].relayedTroughsIds.indexOf(relayIdStr);
        if (index >= 0) this.store[peerIdStr].relayedTroughsIds.splice(index, 1);
    }
    /** @param {string} peerIdStr @param {string} addr */
    setPeerDirectAddr(peerIdStr, addr) {
        const addrStr = addr.split('/p2p')[0];
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        this.store[peerIdStr].directAddr = addrStr;
    }
    /** @param {string} peerIdStr */
    updateLastSeen(peerIdStr) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        this.store[peerIdStr].lastSeen = Date.now();
    }
    /** @param {string} addr */
    #destructureAddr(addr) {
        return {
            peerIdStr: addr.split('/p2p/')[1].split('/')[0], 
            relayedIdStr: addr.split('/p2p-circuit/p2p/')[1] // can be undefined
        }
    }
    /** @param {string} id @param {string} addr */
    digestSelfUpdateAddEvent(id, addr) {
        if (typeof id !== 'string' || typeof addr !== 'string') return;
        // new address to reach the peer published by the peer itself
        this.updateLastSeen(id);
        if (!addr.endsWith('p2p-circuit')) { this.setPeerDirectAddr(id, addr); return; }

        const { peerIdStr, relayedIdStr } = this.#destructureAddr(addr);
        if (!peerIdStr) return;
        this.addRelayedTrough(id, peerIdStr);
    }
    /** @param {string} id @param {string} addr */
    digestSelfUpdateRemoveEvent(id, addr) {
        if (typeof id !== 'string' || typeof addr !== 'string') return;
        // address to reach the peer published by the peer itself is no longer valid
        if (!addr.endsWith('p2p-circuit')) { this.setPeerDirectAddr(id, undefined); return; } // should not append

        const { peerIdStr, relayedIdStr } = this.#destructureAddr(addr);
        if (!peerIdStr) return;
        this.removeRelayedTrough(id, peerIdStr);
    }
    /** @param {string} id emitter peerIdStr @param {string} addr MultiAddress.toString() */
    digestConnectEvent(id, addr) {
        if (typeof id !== 'string' || typeof addr !== 'string') return;
        // '/dns4/contrast.observer/tcp/27260/p2p/12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX'
        this.updateLastSeen(id);
        const address = addr.endsWith('p2p-circuit') ? `${addr}/p2p/${id}` : addr;
        if (!address.includes('/p2p/')) return;
        const { peerIdStr, relayedIdStr } = this.#destructureAddr(address);

        if (id !== peerIdStr) this.setNeighbours(peerIdStr, id);
        if (!relayedIdStr) this.setPeerDirectAddr(peerIdStr, address);
        else if (id === relayedIdStr) this.addRelayedTrough(id, peerIdStr);
        else (this.addRelayedTrough(relayedIdStr, peerIdStr)); // not very reliable
    }
    /** @param {string} id @param {string} peerIdStr */
    digestDisconnectEvent(id, peerIdStr) {
        this.unsetNeighbours(peerIdStr, id);
        this.removeRelayedTrough(peerIdStr, id);
    }

    lastPeerGivenIndex = 0;
    getNextConnectablePeer(directOnly = false) {
        const peersId = Object.keys(this.store);
        if (peersId.length === 0) return;

        let i = (this.lastPeerGivenIndex + 1) % peersId.length;
        for (i; i < peersId.length; i++) {
            const peerIdStr = peersId[i];
            const peer = this.store[peerIdStr];
            if (directOnly && !peer.directAddr) continue;
            this.lastPeerGivenIndex = i;
            return { peerIdStr, peer };
        }
    }
    buildMultiAddrs(peerIdStr) {
        const peer = this.store[peerIdStr];
        if (peer.directAddr) return [multiaddr(`${peer.directAddr}/p2p/${peerIdStr}`)];

        let relayedAddrs = [];
        for (const relayIdStr of peer.relayedTroughsIds) {
            if (!this.store[relayIdStr].directAddr) continue;
            relayedAddrs.push(multiaddr(`${this.store[relayIdStr].directAddr}/p2p-circuit/p2p/${peerIdStr}`));
        }
        return relayedAddrs;
    }
}