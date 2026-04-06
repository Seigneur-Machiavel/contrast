//import { Transaction_Builder, UTXO } from '../src/transaction.mjs';
//import { convert } from '../../utils/converters.mjs';
import { eHTML_STORE } from '../utils/board-helpers.js';
import { serializer } from '../../utils/serializer.mjs';

/**
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 */

const WS_SETTINGS = {
    PROTOCOL: "ws:",
    DOMAIN: "127.0.0.1",
    PORT: 27261,
    RECONNECT_INTERVAL: 5000,
    GET_NODE_INFO_INTERVAL: 5000,
}

const ACTIONS = {
    SETUP: 'setup',
    HARD_RESET: 'hard_reset',
    UPDATE_GIT: 'update_git',
    REVALIDATE: 'revalidate',
    RESET_WALLET: 'reset_wallet',
    FORCE_RESTART: 'force_restart',
    SET_SOLVER_ADDRESS: 'set_solver_address',
    SET_VALIDATOR_ADDRESS: 'set_validator_address'
};

const eHTML = new eHTML_STORE('cnd-', 'node-pubkey-input');
export class Dashboard {
	/** @type {WebSocket} */ ws;
	wsInitInterval;
	textEncoder = new TextEncoder();
	textDecoder = new TextDecoder();
	isWsAccessible = false;
	isConnected = false;
	hostPubkeyStr;
	eHTML = eHTML;
	sharedSecret;
	myKeypair;
	connector;

	/** @param {import('../connector.js').Connector} connector @param {string | null} [hostPubkeyStr] */
	constructor(connector, hostPubkeyStr) {
		this.connector = connector;
		this.hostPubkeyStr = hostPubkeyStr;
		this.myKeypair = this.connector.p2pNode.cryptoCodex.generateEphemeralX25519Keypair();
		this.#testIfWebSocketIsAccessible();
		this.#initWhileDomReady();
	}

	// HANDLERS
	inputHandler(e) { if (e.target.dataset.action === 'setPubkeyFromInput') this.#setControllerPubkeyFromInput(); }
	pasteHandler(e) { if (e.target.dataset.action === 'setPubkeyFromInput') this.#setControllerPubkeyFromInput(); }

	// INTERNAL METHODS
	#testIfWebSocketIsAccessible() {
		this.ws = new WebSocket(`${WS_SETTINGS.PROTOCOL}//${WS_SETTINGS.DOMAIN}:${WS_SETTINGS.PORT}`);
		this.ws.onopen = () => {
			this.isWsAccessible = true;
			this.ws.close();
			this.ws = null;
			console.log('NodeController WebSocket is accessible.');
		}
	}
	async #initWhileDomReady() {
		if (!eHTML.isReady) console.log('Dashboard awaiting DOM elements...');
		while (!eHTML.isReady) await new Promise(r => setTimeout(r, 200));
		console.log('Dashboard DOM elements ready.');
		
		// if not already set, try to load pubkey from storage if exists.
		if (!this.hostPubkeyStr) this.hostPubkeyStr = await this.#pubkeyFromStorage();
		this.wsInitInterval = setInterval(() => this.#initWebSocketIfNot(), 1000);
	}
	#initWebSocketIfNot() {
		if (this.ws) return;
		// WebSocket will throw an error if the server is not up yet.
		this.ws = new WebSocket(`${WS_SETTINGS.PROTOCOL}//${WS_SETTINGS.DOMAIN}:${WS_SETTINGS.PORT}`);
		this.ws.binaryType = 'arraybuffer';
		this.ws.onmessage = (message) => this.#handleMessage(message);
		this.ws.onopen = () => this.#handleConnection();
		this.ws.onclose = () => this.#handleClose();
	}
	/** @param {import('ws').WebSocket} ws */
	#handleConnection = async (ws) => {
		this.wsConnection = ws;
		this.isWsAccessible = true;
		eHTML.get('establishing-connection-text').classList.add('hidden');
		
		if (!this.hostPubkeyStr) eHTML.get('node-pubkey-input').classList.remove('hidden');
		else this.buildSharedSecretFromPubkey(serializer.converter.hexToBytes(this.hostPubkeyStr), true);
	}
	/** @param {string} [reason] */
	#handleClose = (reason) => {
		this.ws = null;
		this.wsConnection = null;
		this.sharedSecret = null;
		this.isConnected = false;
		this.myKeypair = this.connector.p2pNode.cryptoCodex.generateEphemeralX25519Keypair(); // Prepare new keypair for next connection
		eHTML.get('dashboard-wrapper').classList.add('connecting');
		eHTML.get('establishing-connection-text').classList.remove('hidden');
		eHTML.get('node-pubkey-input').classList.add('hidden');
		
		if (reason) console.log(`[NodeController] WebSocket connection closed: ${reason}`);
		else console.log('[NodeController] WebSocket connection closed.');
	}
	#setControllerPubkeyFromInput() {
		try {
			const input = eHTML.get('node-pubkey-input');
			const pubkeyStr = input.value.trim();
			if (pubkeyStr.length !== 64) return null; // expecting 32-byte public key in hex
			else input.value = '';

			this.hostPubkeyStr = pubkeyStr;
			if (chrome.storage) chrome.storage.local.set({ nodePubkey: pubkeyStr });

			this.buildSharedSecretFromPubkey(serializer.converter.hexToBytes(this.hostPubkeyStr), true);
			console.log('Controller pubkey set from input and saved to storage.');
		} catch (error) { console.error('Error getting public key from input:', error); }
	}
	async #pubkeyFromStorage() {
		if (!chrome.storage) return null;
		try {
			/** @type {string} */
			const r = await chrome.storage.local.get('nodePubkey');
			if (!r?.nodePubkey || r.nodePubkey.length !== 64) return null; // expecting 32-byte public key in hex
			return r.nodePubkey;
		} catch (error) { console.error('Error getting public key from storage:', error); return null; }
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

			if (!this.isConnected) this.#setConnected();
			this.handleDecryptedMessage(type, data);
		} catch (/**@type {any} */ error) { console.error(error.stack); }
	}
	#setConnected() {
		this.isConnected = true;
		//this.sendEncryptedMessage('getNodeHeight');
		eHTML.get('dashboard-wrapper').classList.remove('connecting');
		console.log('[NodeController] Key exchange completed - secure channel established');
	}
	/** @param {Uint8Array} encryptedData */
	#parseEncryptedMessage = (encryptedData) => {
		if (!this.sharedSecret) throw new Error('No shared secret established');
		try {
			const decrypted = this.connector.p2pNode.cryptoCodex.decryptData(encryptedData, this.sharedSecret);
			const decodedStr = this.textDecoder.decode(decrypted);
			return JSON.parse(decodedStr);
		} catch (error) { return null; }
	}
	/** @param {string} data */
	#handleStateUpdate = (data) => {
		eHTML.get('nodeState').textContent = data;
	}

	// PUBLIC METHODS
	/** @param {Uint8Array} pubkey */
	buildSharedSecretFromPubkey(pubkey, thenSendPubkey = false) {
		const p = pubkey || (this.hostPubkeyStr === null ? null : serializer.converter.hexToBytes(this.hostPubkeyStr));
		if (!p) return null;
		try {
			const sharedSecret = this.connector.p2pNode.cryptoCodex.computeX25519SharedSecret(this.myKeypair.myPriv, p);
			this.sharedSecret = sharedSecret;
			if (thenSendPubkey) this.ws.send(this.myKeypair.myPub); // Then send client pubkey to server to complete key exchange
		} catch (error) { console.error('Error computing shared secret:', error); }
	}
	/** @param {string} type @param {any} data */
	sendEncryptedMessage = (type, data) => {
		if (!this.sharedSecret || !this.wsConnection) return;
		const str = JSON.stringify({ type, data });
		const encoded = this.textEncoder.encode(str);
		const encrypted = this.connector.p2pNode.cryptoCodex.encryptData(encoded, this.sharedSecret);
		this.wsConnection.send(encrypted);
	}
	/** @param {string} type @param {any} data */
	handleDecryptedMessage(type, data) {
		if (type === 'currentHeight') return eHTML.get('nodeHeight').textContent = data;
		if (type === 'stateUpdate') return this.#handleStateUpdate(data);
		console.log(`[Dashboard] Received unknown message of type "${type}":`, data);
	}
}
