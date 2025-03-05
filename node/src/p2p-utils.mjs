

/**
 * @typedef {import('@multiformats/multiaddr').Multiaddr} Multiaddr
 */

export class PROTOCOLS {
    static RELAY_SHARE = '/relay-share/1.0.0';
    static SDP_EXCHANGE = '/webrtc-sdp/1.0.0';
    static SYNC = '/blockchain-sync/1.0.0';
}

export class STREAM_OPTIONS {
    static NEW_RELAYED_STREAM = { runOnLimitedConnection: true, signal: AbortSignal.timeout(3_000) };
}

export class FILTERS {
    /** @param {Multiaddr[]} ma @param {'ONLY_PUBLIC' | 'ONLY_LOCAL' | 'ALL'} filter - default: 'ONLY_PUBLIC' */
    static multiAddrs(ma, filter = 'ONLY_PUBLIC') {
        if (Array.isArray(ma) === false) return [];
        if (typeof filter !== 'string') return [];

        return ma.filter(addr => {
            const ip = addr.toString();
            if (ip.includes('/127')) return filter !== 'ONLY_PUBLIC';
            if (ip.includes('/192.168')) return filter !== 'ONLY_PUBLIC';
            if (ip.includes('/10.')) return filter !== 'ONLY_PUBLIC';
            if (ip.match(/\/172\.(1[6-9]|2[0-9]|3[0-1])\./)) return filter !== 'ONLY_PUBLIC';
            return filter !== 'ONLY_LOCAL';
        });
    }
}