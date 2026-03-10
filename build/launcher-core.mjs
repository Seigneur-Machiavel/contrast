// @ts-check
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { spawn } from 'child_process';

/** @typedef {{ autoUpdate: boolean, verbose: boolean, validatorAddress: string, minerAddress: string, installedVersion?: string }} LauncherConfig */

// ---- NODE MANAGER ------------------------------------------------------------------
export class NodeManager {
	// Ephemeral seed generated once at launcher start — never written to disk
	seed = crypto.randomBytes(32).toString('hex');
	/** @type {import('child_process').ChildProcess | null} */
	#process = null;
	#onLog;

	get isRunning() { return this.#process !== null && !this.#process.killed; }

	/** @param {function | null} [onLog] */
	constructor(onLog = null) { this.#onLog = onLog; }

	/** @param {string} contrastExePath @param {LauncherConfig} cfg */
	start(contrastExePath, cfg) {
		if (this.isRunning) { console.log('[node] already running'); return; }
		if (!fs.existsSync(contrastExePath)) { console.log('[node] contrast.exe not found — run: update'); return; }

		const args = ['-cs', this.seed];
		if (cfg.validatorAddress) args.push('-validatorAddress', cfg.validatorAddress);
		if (cfg.minerAddress) args.push('-minerAddress', cfg.minerAddress);
		if (cfg.verbose) args.push('-verbose', '2');

		this.#process = spawn(contrastExePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		this.#process.stdout?.on('data', d => {
			process.stdout.write('\r' + d);
			if (this.#onLog) this.#onLog();
		});
		this.#process.stderr?.on('data', d => {
			process.stderr.write(d);
			if (this.#onLog) this.#onLog();
		});
		this.#process.on('exit', (code) => {
			this.#process = null;
			console.log(`\n[node] exited (code ${code})`);
		});
		console.log(`[node] started (pid ${this.#process.pid})`);
		console.log(`[node] ephemeral seed: ${this.seed}`);
	}

	async stop() {
		if (!this.isRunning) { console.log('[node] not running'); return; }
		this.#process?.kill('SIGTERM');
		console.log('[node] stopping — waiting 2s...');
		await new Promise(r => setTimeout(r, 2_000));
		if (this.isRunning) { this.#process?.kill('SIGKILL'); console.log('[node] force killed'); }
		this.#process = null;
	}

	/** @param {string} contrastExePath @param {LauncherConfig} cfg */
	async restart(contrastExePath, cfg) {
		await this.stop();
		await new Promise(r => setTimeout(r, 1_000));
		this.start(contrastExePath, cfg);
	}
}

// ---- UPDATER -----------------------------------------------------------------------
export class Updater {
	#api;
	/** @param {string} githubApi */
	constructor(githubApi) { this.#api = githubApi; }

	/** @param {string} url @returns {Promise<Buffer>} */
	async #get(url) {
		return new Promise((resolve, reject) => {
			https.get(url, { headers: { 'User-Agent': 'contrast-launcher' } }, (res) => {
				if (res.statusCode === 301 || res.statusCode === 302)
					return resolve(this.#get(/** @type {string} */ (res.headers.location)));
				const chunks = /** @type {Buffer[]} */ ([]);
				res.on('data', c => chunks.push(c));
				res.on('end', () => resolve(Buffer.concat(chunks)));
				res.on('error', reject);
			}).on('error', reject);
		});
	}

	/** @param {string} filePath @returns {string} */
	#sha256(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }

	/** @param {string} contrastExePath @param {NodeManager} node @param {boolean} [force] @returns {Promise<boolean>} */
	async run(contrastExePath, node, force = false) {
		console.log('[update] checking for updates...');
		const release = JSON.parse((await this.#get(this.#api)).toString());
		const version = release.tag_name;
		const exeAsset = release.assets.find((/** @type {any} */ a) => a.name === 'contrast.exe');
		const sumAsset = release.assets.find((/** @type {any} */ a) => a.name === 'checksums.sha256');
		if (!exeAsset) { console.log('[update] no contrast.exe in latest release'); return false; }

		// Load config fresh to check installed version
		let installedVersion = '';
		try { installedVersion = JSON.parse(fs.readFileSync(contrastExePath + '/../launcher-config.json', 'utf8')).installedVersion ?? ''; }
		catch { /* no config yet */ }

		if (!force && installedVersion === version) { console.log(`[update] already on ${version}`); return false; }

		console.log(`[update] downloading contrast.exe ${version}...`);
		const tmpPath = contrastExePath + '.tmp';
		fs.writeFileSync(tmpPath, await this.#get(exeAsset.browser_download_url));

		if (sumAsset) {
			const lines = (await this.#get(sumAsset.browser_download_url)).toString().split('\n');
			const expected = lines.find(l => l.includes('contrast.exe'))?.split(/\s+/)[0];
			if (expected && this.#sha256(tmpPath) !== expected) {
				fs.unlinkSync(tmpPath);
				console.log('[update] checksum mismatch — aborting');
				return false;
			}
			console.log('[update] checksum verified ✓');
		}

		if (node.isRunning) await node.stop();
		if (fs.existsSync(contrastExePath)) fs.unlinkSync(contrastExePath);
		fs.renameSync(tmpPath, contrastExePath);
		console.log(`[update] updated to ${version}`);
		return true;
	}
}
