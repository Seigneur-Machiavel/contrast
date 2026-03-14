// @ts-check
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { CryptoCodex } from 'hive-p2p';

/** @typedef {{ autoUpdate: boolean, installedVersion?: string }} LauncherConfig */

// ---- NODE MANAGER ------------------------------------------------------------------
export class NodeManager {
	// Ephemeral seed generated once at launcher start — never written to disk
	seed = crypto.randomBytes(32).toString('hex');
	pubKeyHex; // to access from launcher.mjs
	/** @type {import('child_process').ChildProcess | null} */
	#process = null;
	#exePath;
	#autoRestart;

	get isRunning() { return this.#process !== null && !this.#process.killed; }

	/** @param {string} exePath @param {boolean} [autoRestart] */
	constructor(exePath, autoRestart = true) {
		this.#exePath = exePath;
		this.#autoRestart = autoRestart;
		
		const codex = new CryptoCodex(); // empty codex just to generate the keypair for auto-logging
		const keypair = codex.generateEphemeralX25519Keypair(this.seed);
		if (!keypair?.myPub) return;

		this.pubKeyHex = codex.converter.bytesToHex(keypair.myPub);
		console.log('[NodeManager] generated ephemeral keyPair and assigned pubKeyHex');
		// console.log(`[NodeManager] pubkey ${this.pubKeyHex}`);
		// console.log(`[NodeManager] privKey ${codex.converter.bytesToHex(keypair.myPriv)}`);
	}

	start() {
		if (this.isRunning) { console.log('[node] already running'); return; }
		if (!fs.existsSync(this.#exePath)) { console.log('[node] contrast.exe not found — run update first'); return; }

		this.#process = spawn(this.#exePath, ['--mode=run-client', '-cs', this.seed], { stdio: ['ignore', 'inherit', 'inherit'] });
		this.#process.on('exit', (code) => {
			this.#process = null;
			console.log(`[node] exited (code ${code})`);
			if (!this.#autoRestart) return;
			console.log('[node] restarting in 3s...');
			setTimeout(() => this.start(), 3_000);
		});

		console.log(`[node] started (pid ${this.#process.pid})`);
		// console.log(`[node] ephemeral seed: ${this.seed}`);
	}

	async stop(delay = 5_000) {
		this.#autoRestart = false; // prevent restart on intentional stop
		if (!this.isRunning) { console.log('[node] not running'); return; }
		this.#process?.kill('SIGTERM');
		console.log(`[node] stopping — waiting ${delay / 1000}s...`);
		await new Promise(r => setTimeout(r, delay));
		if (this.isRunning) { this.#process?.kill('SIGKILL'); console.log('[node] force killed'); }
		this.#process = null;
	}

	async restart() {
		await this.stop();
		this.#autoRestart = true;
		await new Promise(r => setTimeout(r, 1_000));
		this.start();
	}
}