import HiveP2P from "hive-p2p";

/**
 * @typedef {Object} NodeOptions
 * @property {import('hive-p2p').CryptoCodex} cryptoCodex - A hiveP2P CryptoCodex instance (works as Identity).
 * @property {number} [verbose] - Verbosity level for logging.
 * @property {boolean} [autoStart] - Whether to automatically start the node upon creation. (default: true)
 * @property {string} [domain] - The domain name for the node (Public only).
 * @property {number} [port] - The port number for the node to listen on (Public only).
 * @property {string[]} [bootstraps] - An array of bootstrap node addresses. */

/** @param {NodeOptions} [options] */
export async function createContrastNode(options = {}) {
	if (!options.cryptoCodex) throw new Error('Node requires a CryptoCodex instance in options.cryptoCodex');
	
	const verb = options.verbose !== undefined ? options.verbose : options.cryptoCodex.verbose;
	const asPublic = options.domain !== undefined && options.port !== undefined;
	if (options.autoStart === undefined) options.autoStart = true; // set default autoStart to true
	
	const p2pNode = asPublic ? await HiveP2P.createPublicNode(options) : await HiveP2P.createNode(options);
	return new ContrastNode(p2pNode, verb);
}

export class ContrastNode {
	p2pNode;
	verb;

	/** Node instance should be created with "createContrastNode" method, not using "new" constructor.
	 * @param {import('hive-p2p').Node} p2pNode - Hive P2P node instance. */
	constructor(p2pNode, verb = 2) {
		this.p2pNode = p2pNode;
		this.verb = verb;
	}

	// GETTERS
	get time() { return this.p2pNode.time; }
	get neighborsCount() { return this.p2pNode.peerStore.neighborsList.length; }

	// API
	async start() {
		if (this.verb >= 1) console.log(`Starting HiveP2P node...`);
		if (!this.p2pNode.started) await this.p2pNode.start();

		if (this.verb >= 1) console.log(`Starting Contrast node...`);
		console.log(`${this.p2pNode.time} - ${Date.now()}`);
	}
	async stop() {
		if (this.verb >= 1) console.log(`Stopping Contrast node...`);
	}
	async restart() {
		if (this.verb >= 1) console.log(`Restarting Contrast node...`);
		await this.stop();
		await this.start();
	}
	setWallet() { // associat a wallet with this node (for miner and validator functions)
		// To be implemented
	}

	// INTERNALS
}