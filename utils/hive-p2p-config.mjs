

export const HIVE_P2P_CONFIG = {
	UNICAST: {
		MARKERS_BYTES: {
			block_request: 127,
			'127': 'block_request',
			block: 126,
			'126': 'block',
		}
	},
	GOSSIP: {
		HOPS: {
			block_candidate: 32,
			block_finalized: 32,
			sync_status: 2,
		},
		MARKERS_BYTES: {
			block_candidate: 255,
			'255': 'block_candidate',
			block_finalized: 254,
			'254': 'block_finalized',
			sync_status: 253,
			'253': 'sync_status',
		},
	}
}