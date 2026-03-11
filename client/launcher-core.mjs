// @ts-check
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { spawn } from 'child_process';

/** @typedef {{ autoUpdate: boolean, installedVersion?: string }} LauncherConfig */

// ---- NODE MANAGER ------------------------------------------------------------------
export class NodeManager {
	// Ephemeral seed generated once at launcher start — never written to disk
	seed = crypto.randomBytes(32).toString('hex');
	/** @type {import('child_process').ChildProcess | null} */
	#process = null;
	#exePath;
	#autoRestart;

	get isRunning() { return this.#process !== null && !this.#process.killed; }

	/** @param {string} exePath @param {boolean} [autoRestart] */
	constructor(exePath, autoRestart = true) {
		this.#exePath = exePath;
		this.#autoRestart = autoRestart;
	}

	start() {
		if (this.isRunning) { console.log('[node] already running'); return; }
		if (!fs.existsSync(this.#exePath)) { console.log('[node] contrast.exe not found — run update first'); return; }

		this.#process = spawn(this.#exePath, ['--mode=node', '-cs', this.seed], { stdio: ['ignore', 'pipe', 'pipe'] });
		this.#process.stdout?.on('data', d => process.stdout.write(d));
		this.#process.stderr?.on('data', d => process.stderr.write(d));
		this.#process.on('exit', (code) => {
			this.#process = null;
			console.log(`[node] exited (code ${code})`);
			if (!this.#autoRestart) return;
			console.log('[node] restarting in 3s...');
			setTimeout(() => this.start(), 3_000);
		});
		console.log(`[node] started (pid ${this.#process.pid})`);
		console.log(`[node] ephemeral seed: ${this.seed}`);
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

// ---- UPDATER -----------------------------------------------------------------------
export class Updater {
	#api;
	#ignorePreRelease;

	/** @param {string} githubApi @param {boolean} ignorePreRelease */
	constructor(githubApi, ignorePreRelease) { this.#api = githubApi; this.#ignorePreRelease = ignorePreRelease; }

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

	/** @param {string} exePath @param {NodeManager} node @param {boolean} [force] @returns {Promise<boolean>} */
	async run(exePath, node, force = false) {
		console.log('[update] checking for updates...');
		const release = JSON.parse((await this.#get(this.#api)).toString());
		if (this.#ignorePreRelease && release.prerelease) { console.log('[update] pre-release ignored'); return false; }

		const version = release.tag_name;
		const exeAsset = release.assets.find((/** @type {any} */ a) => a.name === 'contrast.exe');
		const sumAsset = release.assets.find((/** @type {any} */ a) => a.name === 'checksums.sha256');
		if (!exeAsset) { console.log('[update] no contrast.exe in latest release'); return false; }

		let installedVersion = '';
		try { installedVersion = JSON.parse(fs.readFileSync(exePath + '/../launcher-config.json', 'utf8')).installedVersion ?? ''; }
		catch { /* no config yet */ }

		if (!force && installedVersion === version) { console.log(`[update] already on ${version}`); return false; }

		console.log(`[update] downloading contrast.exe ${version}...`);
		const tmpPath = exePath + '.tmp';
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
		if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
		fs.renameSync(tmpPath, exePath);
		console.log(`[update] updated to ${version}`);
		return true;
	}
}
