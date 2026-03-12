// @ts-check
import fs from 'fs';
import path from 'path';
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

		this.#process = spawn(this.#exePath, ['--mode=run-client', '-cs', this.seed], { stdio: ['ignore', 'pipe', 'pipe'] });
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
	#configPath;
	#ignorePreRelease;

	/** @param {string} githubApi @param {string} configPath @param {boolean} ignorePreRelease */
	constructor(githubApi, configPath, ignorePreRelease) { this.#api = githubApi; this.#configPath = configPath; this.#ignorePreRelease = ignorePreRelease; }

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

	/** @param {string} resourcesDir @param {NodeManager} node @param {boolean} [force] @returns {Promise<boolean>} */
	async run(resourcesDir, node, force = false) {
		console.log('[update] checking for updates...');
		const releases = JSON.parse((await this.#get(this.#api)).toString());
		const release = releases[0];
		if (this.#ignorePreRelease && release.prerelease) { console.log('[update] pre-release ignored'); return false; }

		// Download manifest only (~2KB)
		const manifestAsset = release.assets.find((/** @type {any} */ a) => a.name === 'manifest.json');
		if (!manifestAsset) { console.log('[update] no manifest.json in latest release'); return false; }
		const manifest = JSON.parse((await this.#get(manifestAsset.browser_download_url)).toString());

		// Compare local version
		let localVersion = '';
		try { localVersion = JSON.parse(fs.readFileSync(this.#configPath, 'utf8')).installedVersion ?? ''; }
		catch { /* no config yet */ }
		if (!force && localVersion === manifest.version) { console.log(`[update] already on ${manifest.version}`); return false; }

		// Download resources.zip
		const zipAsset = release.assets.find((/** @type {any} */ a) => a.name === 'resources.zip');
		if (!zipAsset) { console.log('[update] no resources.zip in latest release'); return false; }
		console.log(`[update] downloading resources.zip ${manifest.version}...`);
		const zipData = await this.#get(zipAsset.browser_download_url);

		// Verify checksum
		const actual = crypto.createHash('sha256').update(zipData).digest('hex');
		if (actual !== manifest.resourcesChecksum) { console.log('[update] checksum mismatch — aborting'); return false; }
		console.log('[update] checksum verified ✓');

		// Stop node, extract zip
		if (node.isRunning) await node.stop();
		const tmpZip = path.join(resourcesDir, '..', 'resources.tmp.zip');
		fs.writeFileSync(tmpZip, zipData);

		const AdmZip = (await import('adm-zip')).default;
		const zip = new AdmZip(tmpZip);
		zip.extractAllTo(resourcesDir, true);
		fs.unlinkSync(tmpZip);

		// Save installed version
		let cfg = {};
		try { cfg = JSON.parse(fs.readFileSync(this.#configPath, 'utf8')); } catch { /* no config yet */ }
		cfg.installedVersion = manifest.version;
		fs.writeFileSync(this.#configPath, JSON.stringify(cfg, null, 2));

		console.log(`[update] updated to ${manifest.version}`);
		node.start();
		return true;
	}
}
