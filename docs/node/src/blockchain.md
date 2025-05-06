# blockchain.mjs

This module manages the local blockchain instance for the node. It encapsulates all core operations: block storage, cache management, integration with the snapshot system, and tracking of the current chain height. It uses utilities for data conversion, logging, and block manipulation. The main `Blockchain` class provides methods to load, validate, and add blocks, as well as to maintain consistency with snapshots.

## Main Features
- Chain loading and synchronization
- Block addition and validation
- Cache and storage management
- Integration with the snapshot system
- Detailed logging

## Dependencies
- storage-manager.mjs
- block-classes.mjs
- blockchain-cache.mjs
- mini-logger.mjs
- breather.mjs
- converters.mjs
