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
		this.pingInterval = setInterval(this.shareNodeInfo, 1_000);
	}
	
	#lastShareTimestamp = 0;
	shareNodeInfo = async (delay = 1000) => {
		if (!this.sharedSecret || !this.wsConnection) return;
		if (Date.now() - this.#lastShareTimestamp < delay) return; // rate limit
		this.#lastShareTimestamp = Date.now();
		const info = {
			currentHeight: this.node.blockchain.currentHeight,
			validationHeight: this.node.solver.bestCandidateIndex,
			networkPower: this.node.solver.networkPower,
			solverPower: this.node.solver.hashRateStats.effective,
			solverLegitimacy: this.node.solver.bestCandidateLegitimacy,
			dailyRewardEstimation: this.node.solver.estimatedDailyReward,
			solverThreadCount: this.node.solver.nbOfWorkers,

			publicAddress: this.node.account?.address,
			solverRewardAddress: this.node.rewardsInfo.sAddress,
			solverBalance: this.node.rewardsInfo.sBalance,
			validatorRewardAddress: this.node.rewardsInfo.vAddress,
			validatorBalance: this.node.rewardsInfo.vBalance,
			
			//hiveVersion: this.node.p2p.,
			txInMempool: this.node.memPool.organizer.byAnchor.size,
			neighborsCount: this.node.p2p.peerStore.neighborsList.length,
			nodePeerId: this.node.p2p.id,
			listenAddress: this.node.p2p.publicUrl,
		};

		this.sendEncryptedMessage('nodeInfo', info);
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
			case 'setAddress': return this.node.handleAddressUpdate(data.type, data.address, data.pubKeysHex);

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