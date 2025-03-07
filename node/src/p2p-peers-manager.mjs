import { peerIdFromString } from '@libp2p/peer-id';

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
    addNeighbour(peerIdStr, neighbourIdStr) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        if (this.store[peerIdStr].neighboursIds.includes(neighbourIdStr)) return;
        this.store[peerIdStr].neighboursIds.push(neighbourIdStr);
    }
    /** @param {string} peerIdStr @param {string} relayIdStr */
    addRelayedTrough(peerIdStr, relayIdStr) {
        if (!this.store[peerIdStr]) this.store[peerIdStr] = new Peer();
        if (this.store[peerIdStr].relayedTroughsIds.includes(relayIdStr)) return;
        this.store[peerIdStr].relayedTroughsIds.push(relayIdStr);
    }
    /** @param {string} peerIdStr @param {string} neighbourIdStr */
    removeNeighbour(peerIdStr, neighbourIdStr) {
        if (!this.store[peerIdStr]) return;
        const index = this.store[peerIdStr].neighboursIds.indexOf(neighbourIdStr);
        if (index >= 0) this.store[peerIdStr].neighboursIds.splice(index, 1);
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
    /** @param {string} addr */
    #destructureAddr(addr) {
        return {
            peerIdStr: addr.split('/p2p/')[1].split('/')[0], 
            relayedIdStr: addr.split('/p2p-circuit/p2p/')[1] // can be undefined
        }
    }
    /** @param {string} id emitter peerIdStr @param {string} addr MultiAddress.toString() */
    digestConnectEvent(id, addr) {
        if (typeof id !== 'string' || typeof addr !== 'string') return;

        const address = addr.endsWith('p2p-circuit') ? `${addr}/p2p/${id}` : addr;
        if (!address.includes('/p2p/')) return;
        const { peerIdStr, relayedIdStr } = this.#destructureAddr(address);

        if (!relayedIdStr) this.setPeerDirectAddr(peerIdStr, address);
        else if (id === relayedIdStr) this.addRelayedTrough(id, peerIdStr);
        
        if (id !== peerIdStr) this.addNeighbour(peerIdStr, id);
    }
    /** @param {string} id @param {string} peerIdStr */
    digestDisconnectEvent(id, peerIdStr) {
        this.removeNeighbour(peerIdStr, id);
        this.removeRelayedTrough(peerIdStr, id);
    }
}