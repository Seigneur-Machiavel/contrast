

export const HIVE_P2P_CONFIG = {
	UNICAST: {
		MARKERS_BYTES: {
			block_request: 127,
			'127': 'block_request',
			block: 126,
			'126': 'block',
			address_ledger_request: 125,
			'125': 'address_ledger_request',
			address_ledger: 124,
			'124': 'address_ledger',
			blocks_timestamps_request: 123,
			'123': 'blocks_timestamps_request',
			blocks_timestamps: 122,
			'122': 'blocks_timestamps',
			rounds_legitimacies_request: 121,
			'121': 'rounds_legitimacies_request',
			rounds_legitimacies: 120,
			'120': 'rounds_legitimacies',
			transactions_request: 119,
			'119': 'transactions_request',
			transactions: 118,
			'118': 'transactions',
		}
	},
	GOSSIP: {
		HOPS: {
			block_candidate: 32,
			block_finalized: 32,
			sync_status: 2,
			transaction: 16,
		},
		MARKERS_BYTES: {
			block_candidate: 255,
			'255': 'block_candidate',
			block_finalized: 254,
			'254': 'block_finalized',
			sync_status: 253,
			'253': 'sync_status',
			transaction: 252,
			'252': 'transaction',
		},
	}
}