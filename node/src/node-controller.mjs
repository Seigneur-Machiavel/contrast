import { WebSocketServer } from 'ws';

/** 
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate */

export class NodeController {
	/** @type {import('ws').WebSocket | null} */	wsConnection = null;
	/** @type {NodeJS.Timeout | null} */			authTimeout = null;
	textEncoder = new TextEncoder();
	textDecoder = new TextDecoder();
	unsafeMode = false;
	pingInterval;
	sharedSecret;
	myKeypair;
	wsServer;
	node;

	/** @param {ContrastNode} node @param {number} [port] */
	constructor(node, port = 27261) {
		this.node = node;
		this.wsServer = new WebSocketServer({ port });
		this.wsServer.on('connection', this.#handleConnection);
		this.myKeypair = this.node.p2p.cryptoCodex.generateEphemeralX25519Keypair();
		console.log(`[NodeController] started on port ${port}`);
		console.log(`[NodeController] unsafeMode is ${this.unsafeMode ? 'ENABLED' : 'DISABLED'}`);
		console.log('[NodeController] waiting for client connection...');
		console.log(`[NodeController] Public key: ${Buffer.from(this.myKeypair.myPub).toString('hex')}`);
		this.pingInterval = setInterval(() => {
			if (!this.wsConnection || !this.sharedSecret) return;
			this.sendEncryptedMessage('currentHeight', this.node.blockchain.currentHeight);
			//this.sendEncryptedMessage('ping', Date.now());
		}, 1_000);
	}

	/** @param {import('ws').WebSocket} ws */
	#handleConnection = (ws) => {
		if (this.wsConnection) return ws.close(1013, 'Only one connection allowed at a time');
		this.wsConnection = ws;
		ws.on('message', (message) => this.#handleMessage(message));
		ws.on('close', () => this.#handleClose());
		this.authTimeout = setTimeout(() => this.#handleClose('authentication timeout'), 1_000);
	}
	/** @param {string | Buffer | ArrayBuffer | Buffer[] } message */
	#handleMessage = (message) => {
		try {
			if (!this.sharedSecret) {
				if (message.length !== 32) return; // expecting 32-byte public key
				this.#handleKeyExchange(new Uint8Array(message));
				return;
			}

			const parsedMessage = this.#parseEncryptedMessage(new Uint8Array(message.data));
			const { type, data } = parsedMessage;
			if (!type) throw new Error('Message type is missing');
			this.handleDecryptedMessage(type, data);
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
		if (this.unsafeMode) this.wsConnection.send(this.myKeypair.myPub); // share the pubkey back in unsafe mode
		if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = null; }
		console.log('[NodeController] Key exchange completed - secure channel established');
	}
	/** @param {Uint8Array} encryptedData */
	#parseEncryptedMessage = (encryptedData) => {
		if (!this.sharedSecret) throw new Error('No shared secret established');
		const decrypted = this.node.p2p.cryptoCodex.decryptData(encryptedData, this.sharedSecret);
		const decodedStr = this.textDecoder.decode(decrypted);
		return JSON.parse(decodedStr);
	}
	/** @param {string} [reason] */
	#handleClose = (reason) => {
		if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = null; }
		if (this.wsConnection) this.wsConnection.close();
		this.wsConnection = null;
		this.sharedSecret = null;
		if (reason) console.log(`[NodeController] WS closed: ${reason}`);
	}

	// PUBLIC METHODS
	enableUnsafeMode() {
		this.unsafeMode = true;
		console.log('[NodeController] unsafeMode is ENABLED');
	}
	disableUnsafeMode() {
		this.unsafeMode = false;
		console.log('[NodeController] unsafeMode is DISABLED');
	}
	/** @param {string} type @param {any} data */
	sendEncryptedMessage = (type, data) => {
		if (!this.sharedSecret || !this.wsConnection) return;
		const str = JSON.stringify({ type, data });
		const encoded = this.textEncoder.encode(str);
		const encrypted = this.node.p2p.cryptoCodex.encryptData(encoded, this.sharedSecret);
		this.wsConnection.send(encrypted);
	}
	/** @param {string} type @param {any} data */
	handleDecryptedMessage(type, data) {
				
	}
}