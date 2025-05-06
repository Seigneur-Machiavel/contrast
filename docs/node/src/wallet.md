# wallet.mjs

This module manages wallet logic: generation, derivation, storage, and management of accounts and addresses. It supports different address types (W, C, P, U), UTXO management, and integrates with cryptographic primitives (Argon2, asymmetric functions).

## Main Classes
- `Account`: Represents an account with private/public keys, address, balance, and UTXOs.
- `Wallet`: Handles the master seed, account derivation, storage and retrieval, and multi-account management.

## Main Features
- Address generation and derivation
- Secure key management
- Account save/load
- Balance calculation and transaction management

## Dependencies
- conCrypto.mjs
- progress-logger.mjs
- addressUtils.mjs
- storage-manager.mjs
- workers-classes.mjs
