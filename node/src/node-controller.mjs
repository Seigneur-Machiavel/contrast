// ts-check
import { WebSocketServer } from 'ws';
import { solving } from '../../utils/conditionals.mjs';

/** 
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate */

export class NodeController {
	/** @type {import('ws').WebSocket | null} */	wsConnection = null;
	/** @type {NodeJS.Timeout | null} */			authTimeout = null;
	textEncoder = new TextEncoder();
	textDecoder = new TextDecoder();
	unsafeServePubKey;
	pingInterval;
	sharedSecret;
	myKeypair;
	wsServer;
	node;

	/** @param {ContrastNode} node @param {number} [port] @param {string} [serverChachaSeedHex] - A 32bytes hex-encoded seed for key generation (if not set, client-server pubkeys will be exchanged) */
	constructor(node, port = 27261, serverChachaSeedHex, unsafeServePubKey = false) {
		this.node = node;
		this.unsafeServePubKey = unsafeServePubKey;
		this.wsServer = new WebSocketServer({ port });
		this.wsServer.on('connection', this.#handleConnection);
		this.myKeypair = this.node.p2p.cryptoCodex.generateEphemeralX25519Keypair(serverChachaSeedHex);
		console.log(`[NodeController] started on port ${port}`);
		console.log(`[NodeController] unsafeServePubKey is ${this.unsafeServePubKey ? 'ENABLED' : 'DISABLED'}`);
		console.log('[NodeController] waiting for client connection...');
		//console.log(`[NodeController] Public key: ${this.node.p2p.cryptoCodex.converter.bytesToHex(this.myKeypair.myPub)}`);
		//console.log(`[NodeController] Private key: ${this.node.p2p.cryptoCodex.converter.bytesToHex(this.myKeypair.myPriv)}`);
		this.pingInterval = setInterval(async () => {
			if (!this.wsConnection || !this.sharedSecret) return;
			this.sendEncryptedMessage('currentHeight', this.node.blockchain.currentHeight);
			this.sendEncryptedMessage('validationHeight', this.node.solver.bestCandidateIndex);
			this.sendEncryptedMessage('networkPower', this.node.solver.networkPower);
			this.sendEncryptedMessage('solverPower', this.node.solver.hashRateStats.effective);
			this.sendEncryptedMessage('solverLegitimacy', this.node.solver.bestCandidateLegitimacy);
			this.sendEncryptedMessage('dailyRewardEstimation', this.node.solver.estimatedDailyReward);
			this.sendEncryptedMessage('solverThreadCount', this.node.solver.nbOfWorkers);

			this.sendEncryptedMessage('publicAddress', this.node.account?.address);
			this.sendEncryptedMessage('solverRewardAddress', this.node.rewardsInfo.sAddress);
			this.sendEncryptedMessage('validatorRewardAddress', this.node.rewardsInfo.vAddress);
			//this.sendEncryptedMessage('clientVersion', this.node.); // TODO
			this.sendEncryptedMessage('txInMempool', this.node.memPool.organizer.byAnchor.size);
			this.sendEncryptedMessage('neighborsCount', this.node.p2p.peerStore.neighborsList.length);
			//this.sendEncryptedMessage('ping', Date.now());
			if (this.node.rewardsInfo.sAddress) {
				const ledger = await this.node.blockchain.ledgersStorage.getAddressLedger(this.node.rewardsInfo.sAddress);
				this.sendEncryptedMessage('solverBalance', ledger ? ledger.balance : 0);
			}
			if (this.node.rewardsInfo.vAddress) {
				const ledger = await this.node.blockchain.ledgersStorage.getAddressLedger(this.node.rewardsInfo.vAddress);
				this.sendEncryptedMessage('validatorBalance', ledger ? ledger.balance : 0);
			}
		}, 1_000);
	}

	/** @param {import('ws').WebSocket} ws */
	#handleConnection = (ws) => {
		if (this.wsConnection) return ws.close(1013, 'Only one connection allowed at a time');
		this.wsConnection = ws;
		ws.on('message', (message) => this.#handleMessage(message));
		ws.on('close', () => this.#handleClose());
		if (this.unsafeServePubKey) this.wsConnection.send(this.myKeypair.myPub); // share the server pubkey
		//this.authTimeout = setTimeout(() => this.#handleClose('authentication timeout'), 1_000);
	}
	/** @param {string | Buffer | ArrayBuffer | Buffer[] } message */
	#handleMessage = (message) => {
		try {
			if (!this.sharedSecret) {
				if (message.length !== 32) return; // expecting 32-byte public key
				this.#handleKeyExchange(new Uint8Array(message));
				this.sendEncryptedMessage('nodePeerId', this.node.p2p.id);
				return;
			}

			const { type, data } = this.#parseEncryptedMessage(new Uint8Array(message));
			if (!type) throw new Error('Message type is missing');
			this.#handleDecryptedMessage(type, data);
		} catch (/**@type {any} */ error) {
			console.error(error.message);
			if (!this.sharedSecret) return;
			this.wsConnection.send(new Uint8Array([0])); // send error response
			this.#handleClose('decryption error');
		}
	}
	/** @param {Uint8Array} data */
	#handleKeyExchange = (data) => {
		const codex = this.node.p2p.cryptoCodex;
		const sharedSecret = codex.computeX25519SharedSecret(this.myKeypair.myPriv, data);
		this.sharedSecret = sharedSecret;
		//if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = null; }
		console.log('[NodeController] Key exchange completed - secure channel established');
	}
	/** @param {Uint8Array} encryptedData */
	#parseEncryptedMessage = (encryptedData) => {
		if (!this.sharedSecret) throw new Error('No shared secret established');
		const decrypted = this.node.p2p.cryptoCodex.decryptData(encryptedData, this.sharedSecret);
		const decodedStr = this.textDecoder.decode(decrypted);
		return JSON.parse(decodedStr);
	}
	/** @param {string} type @param {any} data */
	#handleDecryptedMessage(type, data) {
		switch (type) {
			case 'decreaseThreads': return this.node.solver.decreaseThreads();
			case 'increaseThreads': return this.node.solver.increaseThreads();
			default: console.log(`[NodeController] Received unknown message of type "${type}":`, data);
		}
	}
	/** @param {string} [reason] */
	#handleClose = (reason) => {
		//if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = null; }
		if (this.wsConnection) this.wsConnection.close();
		this.wsConnection = null;
		this.sharedSecret = null;
		if (reason) console.log(`[NodeController] WS closed: ${reason}`);
	}

	// PUBLIC METHODS
	enableUnsafeServePubKey() {
		this.unsafeServePubKey = true;
		console.log('[NodeController] unsafeServePubKey is ENABLED');
	}
	disableUnsafeServePubKey() {
		this.unsafeServePubKey = false;
		console.log('[NodeController] unsafeServePubKey is DISABLED');
	}
	/** @param {string} type @param {any} data */
	sendEncryptedMessage = (type, data) => {
		if (!this.sharedSecret || !this.wsConnection) return;
		const str = JSON.stringify({ type, data });
		const encoded = this.textEncoder.encode(str);
		const encrypted = this.node.p2p.cryptoCodex.encryptData(encoded, this.sharedSecret);
		this.wsConnection.send(encrypted);
	}
}