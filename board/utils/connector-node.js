import { serializer } from '../../utils/serializer.mjs';

/**
 * @typedef {Object} WS_SETTINGS
 * @property {string} PROTOCOL - The protocol to use for the WebSocket connection (e.g., "ws:" or "wss:").
 * @property {string} DOMAIN - The domain to connect to (e.g., "127.0.0.1").
 * @property {number} PORT - The port number to connect to (e.g., 27261).
 * 
 * @typedef {import('../utils/connector-p2p.js').Connector} Connector */

export class ConnectorNode {
	textEncoder = new TextEncoder();
	textDecoder = new TextDecoder();
	/** @type {WebSocket} */ ws;
	wsInitInterval;
	connectorP2P;
	WS_SETTINGS;

	/** @type {Record<string, Function>} onMessageCallbacks */
	onMessageCallbacks = {};
	isWsAccessible = false;
	isConnected = false;
	hostPubkeyStr;
	sharedSecret;
	myKeypair;

	/** @param {Connector} connectorP2P @param {WS_SETTINGS} WS_SETTINGS @param {string | null} [hostPubkeyStr] */
	constructor(connectorP2P, WS_SETTINGS, hostPubkeyStr = null) {
		this.connectorP2P = connectorP2P;
		this.WS_SETTINGS = WS_SETTINGS;
		this.hostPubkeyStr = hostPubkeyStr;
		this.myKeypair = this.connectorP2P.p2pNode.cryptoCodex.generateEphemeralX25519Keypair();
		this.#init();
	}
	
	// INTERNAL METHODS
	async #init() { // if not already set, try to load pubkey from storage if exists.
		if (!this.hostPubkeyStr) this.hostPubkeyStr = await this.#pubkeyFromStorage();
		this.wsInitInterval = setInterval(() => this.#initWebSocketIfNot(), 1000);
	}
	async #pubkeyFromStorage() {
		if (!chrome.storage) return null;
		try {
			const r = await chrome.storage.local.get('nodePubkey');
			if (!r?.nodePubkey || r.nodePubkey.length !== 64) return null; // expecting 32-byte public key in hex
			return r.nodePubkey;
		} catch (error) { console.error('Error getting public key from storage:', error); return null; }
	}
	#initWebSocketIfNot() {
		if (this.ws) return; // WebSocket will throw an error if the server is not up yet.
		this.ws = new WebSocket(`${this.WS_SETTINGS.PROTOCOL}//${this.WS_SETTINGS.DOMAIN}:${this.WS_SETTINGS.PORT}`);
		this.ws.binaryType = 'arraybuffer';
		this.ws.onmessage = (message) => this.#handleMessage(message);
		this.ws.onopen = () => this.#handleConnection();
		this.ws.onclose = () => this.#handleClose();
	}
	#handleConnection = async () => {
		this.isWsAccessible = true;
		//if (!this.hostPubkeyStr) return this.ws.close(); // Wait for user to input pubkey if not already set, then connection will be re-attempted in the next interval tick. No need to keep the connection open without a pubkey.
		//else this.buildSharedSecretFromPubkey(serializer.converter.hexToBytes(this.hostPubkeyStr), true);
		if (this.hostPubkeyStr) this.buildSharedSecretFromPubkey(serializer.converter.hexToBytes(this.hostPubkeyStr), true);
	}
	/** @param {string} [reason] */
	#handleClose = (reason) => {
		this.ws = null;
		this.sharedSecret = null;
		this.isConnected = false;
		this.myKeypair = this.connectorP2P.p2pNode.cryptoCodex.generateEphemeralX25519Keypair(); // Prepare new keypair for next connection
		if (reason) console.log(`[NodeController] WebSocket connection closed: ${reason}`);
		else console.log('[NodeController] WebSocket connection closed.');
	}
	/** @param {ArrayBuffer} message */
	#handleMessage = (message) => {
		try {
			//console.log('[NodeController] Received message:', message);
			const d = new Uint8Array(message.data);
			if (d.length === 0) throw new Error('WRONG PUBKEY'); // error response from server
			// UNSAFE MODE PUBKEY HANDLER
			if (!this.sharedSecret && d.length === 32) return this.buildSharedSecretFromPubkey(d, true);
			
			const { type, data } = this.#parseEncryptedMessage(d) || {};
			if (!type) return this.#handleClose('Unable to parse encrypted message.');

			if (!this.isConnected) {
				this.isConnected = true;
				console.log('[NodeController] Key exchange completed - secure channel established');
			}

			for (const app in this.onMessageCallbacks) this.onMessageCallbacks[app]?.(type, data);
		} catch (/**@type {any} */ error) { console.error(error.stack); }
	}
	/** @param {Uint8Array} encryptedData */
	#parseEncryptedMessage = (encryptedData) => {
		if (!this.sharedSecret) throw new Error('No shared secret established');
		try {
			const decrypted = this.connectorP2P.p2pNode.cryptoCodex.decryptData(encryptedData, this.sharedSecret);
			const decodedStr = this.textDecoder.decode(decrypted);
			return JSON.parse(decodedStr);
		} catch (error) { return null; }
	}

	// PUBLIC METHODS
	/** @param {Uint8Array} pubkey */
	buildSharedSecretFromPubkey(pubkey, thenSendPubkey = false) {
		const p = pubkey || (this.hostPubkeyStr === null ? null : serializer.converter.hexToBytes(this.hostPubkeyStr));
		if (!p) return;
		try {
			this.sharedSecret = this.connectorP2P.p2pNode.cryptoCodex.computeX25519SharedSecret(this.myKeypair.myPriv, p);
			if (thenSendPubkey) this.ws.send(this.myKeypair.myPub); // Then send client pubkey to server to complete key exchange
		} catch (error) { console.error('Error computing shared secret:', error); }
	}
	/** @param {string} type @param {any} data */
	sendEncryptedMessage = (type, data) => {
		console.log(`[Dashboard] Sending message of type "${type}" with data:`, data);
		if (!this.sharedSecret || !this.isWsAccessible) return;
		const str = JSON.stringify({ type, data });
		const encoded = this.textEncoder.encode(str);
		const encrypted = this.connectorP2P.p2pNode.cryptoCodex.encryptData(encoded, this.sharedSecret);
		this.ws.send(encrypted);
	}
}