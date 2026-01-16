import { WebSocketServer } from 'ws';

/** @typedef {import("./node.mjs").ContrastNode} ContrastNode */

export class NodeController {
	/** @type {import('ws').WebSocket | null} */
	wsConnection = null;
	textEncoder = new TextEncoder();
	textDecoder = new TextDecoder();
	clientPublicKey;
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
	}

	/** @param {import('ws').WebSocket} ws */
	#handleConnection = (ws) => {
		if (this.wsConnection) return ws.close(1013, 'Only one connection allowed at a time');
		this.wsConnection = ws;
		ws.on('message', (message) => this.#handleMessage(message));
		ws.on('close', () => this.#handleClose());
	}

	/** @param {string | Buffer | ArrayBuffer | Buffer[] } message */
	#handleMessage = (message) => {
		try {
			console.log('[NodeController] Received message:', message.data);
			// give it to the function as Uint8Array
			if (!this.sharedSecret) {
				this.#handleKeyExchange(new Uint8Array(message));
				return;
			}

			const parsedMessage = this.#parseEncryptedMessage(new Uint8Array(message.data));
			const { type, data } = parsedMessage;
			if (!type) throw new Error('Message type is missing');
			console.log(`[NodeController] Parsed message of type "${type}":`, data);
		} catch (/**@type {any} */ error) { console.error(error.message); }
	}
	/** @param {Uint8Array} data */
	#handleKeyExchange = (data) => {
		const codex = this.node.p2p.cryptoCodex;
		this.clientPublicKey = data;
		this.sharedSecret = codex.computeX25519SharedSecret(this.myKeypair.myPriv, this.clientPublicKey);
		this.wsConnection.send(this.myKeypair.myPub);
		console.log('[NodeController] Key exchange completed - secure channel established');
	}
	/** @param {string} type @param {any} data */
	#sendEncryptedMessage = (type, data) => {
		if (!this.sharedSecret || !this.wsConnection) return;
		const str = JSON.stringify({ type, data });
		const encoded = this.textEncoder.encode(str);
		const encrypted = this.node.p2p.cryptoCodex.encryptData(encoded, this.sharedSecret);
		this.wsConnection.send(encrypted);
	}
	/** @param {Uint8Array} encryptedData */
	#parseEncryptedMessage = (encryptedData) => {
		if (!this.sharedSecret) throw new Error('No shared secret established');
		const decrypted = this.node.p2p.cryptoCodex.decryptData(encryptedData, this.sharedSecret);
		const decodedStr = this.textDecoder.decode(decrypted);
		return JSON.parse(decodedStr);
	}
	#handleClose = () => {
		this.clientPublicKey = null;
		this.wsConnection = null;
		this.sharedSecret = null;
		this.myKeypair = this.node.p2p.cryptoCodex.generateEphemeralX25519Keypair(); // Prepare new keypair for next connection
		console.log('[NodeController] WebSocket connection closed => reset keys');
	}

	// PUBLIC METHODS - CALLBACKS FROM NODE EVENTS
	onStateUpdate = (newState) => {
		this.#sendEncryptedMessage('stateUpdate', newState);
		console.log('[NodeController] Node state updated:', newState);
	}
	onBroadcastNewCandidate = (blockHeader) => {
		console.log('[NodeController] New block candidate broadcasted:', blockHeader);
	}
}