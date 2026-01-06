export class ContrastConnector {
	/** @type {Record<string, Function[]>} */
	listeners = {};
	env = this.#detectEnv();

	constructor() {
		if (this.env === 'extension') {
			this.port = chrome.runtime.connect({ name: 'contrast' });
			this.port.onMessage.addListener(msg => this.#handleMessage(msg));
		} else {
			console.log('Starting HiveP2P worker...');
			this.worker = new Worker('hive-worker.mjs', { type: 'module' });
			//this.worker.onmessage = e => this.#handleMessage(e.data);
			this.worker.onmessage = e => console.log('Message from HiveP2P worker:', e.data);
		}
	}

	send(type, data) {
		const msg = { type, data, id: crypto.randomUUID() };
		if (this.env === 'extension') this.port.postMessage(msg);
		else this.worker.postMessage(msg);
	}
	on(type, callback) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(callback);
	}

	// INTERNAL METHODS
	#detectEnv() {
		if (typeof chrome !== 'undefined' && chrome.runtime?.id) return 'extension';
		if (typeof process !== 'undefined' && process.versions?.electron) return 'electron';
		return 'web';
	}
	#handleMessage = (msg) => {
		for (const handler of this.listeners[msg.type] || []) handler(msg.data);
	}
}