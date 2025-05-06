# memPool.mjs

This module implements the mempool, which temporarily stores unconfirmed transactions before they are included in a block. It handles transaction validation, deduplication, and provides interfaces for miners and nodes to access pending transactions.

## Main Features
- Mempool management
- Transaction validation and deduplication
- Interface for miners and nodes

## Dependencies
- memPool-tx-queue.mjs
- mini-logger.mjs
