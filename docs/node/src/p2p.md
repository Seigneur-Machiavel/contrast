# p2p.mjs

This module implements the node's peer-to-peer (P2P) network. It leverages libp2p and various protocols for peer discovery, communication, connection management, synchronization, and network security. The main `P2PNetwork` class extends EventEmitter and orchestrates connections, address management, topic subscriptions, and network event handling.

## Main Features
- Peer discovery and management
- Connection handling (bootstrap, relay, gossipsub, etc.)
- Secure communication (Noise, DCUTR)
- Time synchronization
- Network logging

## Dependencies
- libp2p and related modules
- p2p-peers-manager.mjs
- p2p-utils.mjs
- mini-logger.mjs
- converters.mjs
