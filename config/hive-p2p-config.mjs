

export const HIVE_P2P_CONFIG = {
	UNICAST: {
		MARKERS_BYTES: {
			// BLOCKCHAIN/TRANSACTIONS
			block_request: 127,
			'127': 'block_request',
			block: 126,
			'126': 'block',
			blocks_headers_request: 125,
			'125': 'blocks_headers_request',
			blocks_headers: 124,
			'124': 'blocks_headers',
			rounds_legitimacies_request: 123,
			'123': 'rounds_legitimacies_request',
			rounds_legitimacies: 122,
			'122': 'rounds_legitimacies',

			// TRANSACTIONS
			transactions_request: 120,
			'120': 'transactions_request',
			transactions: 119,
			'119': 'transactions',

			// LEDGERS/OWNERSHIP
			address_ledger_request: 110,
			'110': 'address_ledger_request',
			address_ledger: 109,
			'109': 'address_ledger',
			wallet_ledgers_request: 108,
			'108': 'wallet_ledgers_request',
			wallet_ledgers: 107,
			'107': 'wallet_ledgers',
			ownership_resquest: 106,
			'106': 'ownership_resquest',
			ownership: 105,
			'105': 'ownership',
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
			transactions: 251,
			'251': 'transactions',
		},
	}
}