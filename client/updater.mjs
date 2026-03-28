// @ts-check
import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';

/**
 * @typedef {import('./node-manager.mjs').NodeManager} NodeManager
 */

// ---- UPDATER -----------------------------------------------------------------------
export class Updater {
	#api;
	#localVersion;
	#ignorePreRelease;

	/** @param {string} githubApi @param {string} localVersion @param {boolean} ignorePreRelease */
	constructor(githubApi, localVersion, ignorePreRelease) { this.#api = githubApi; this.#localVersion = localVersion; this.#ignorePreRelease = ignorePreRelease; }

	/** @param {string} resourcesDir @param {NodeManager} [node] @param {boolean} [force] */
	async run(resourcesDir, node, force = false) {
		const updateInfo = await this.#checkForUpdates(force);
		if (typeof updateInfo === 'string') {
			console.info(updateInfo);
			return;
		}

		// Stop node, extract zip
		if (node?.isRunning) await node.stop();

		const { manifest, zipData } = updateInfo;
		const tmpZip = path.join(resourcesDir, '..', 'resources.tmp.zip');
		fs.writeFileSync(tmpZip, zipData);

		const AdmZip = (await import('adm-zip')).default;
		const zip = new AdmZip(tmpZip);
		zip.extractAllTo(resourcesDir, true);
		fs.unlinkSync(tmpZip);

		this.#localVersion = manifest.version;
		console.info(`[update] updated to ${manifest.version}`);
		if (node) node.start();
		return true;
	}
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
	async #checkForUpdates(force = false) {
		console.log('[update] checking for updates...');
		const releases = JSON.parse((await this.#get(this.#api)).toString());
		const release = !this.#ignorePreRelease ? releases[0]
			: releases.find((/** @type {any} */ r) => !r.prerelease);
		if (!release) return '[update-success] no suitable release found';

		// Download manifest only (~2KB)
		const manifestAsset = release.assets.find((/** @type {any} */ a) => a.name === 'manifest.json');
		if (!manifestAsset) return '[update-failure] no manifest.json in latest release';
		const manifest = JSON.parse((await this.#get(manifestAsset.browser_download_url)).toString());

		// Compare local version
		if (!force && this.#localVersion === manifest.version)
			return `[update-success] already on version ${manifest.version}`;

		// Download resources.zip
		const zipAsset = release.assets.find((/** @type {any} */ a) => a.name === 'resources.zip');
		if (!zipAsset) return '[update-failure] no resources.zip in latest release';
		console.log(`[update] downloading resources.zip ${manifest.version}...`);
		const zipData = await this.#get(zipAsset.browser_download_url);

		// Verify checksum
		const actual = crypto.createHash('sha256').update(zipData).digest('hex');
		if (actual !== manifest.resourcesChecksum)
			return `[update-failure] checksum mismatch (expected ${manifest.resourcesChecksum}, got ${actual}) — aborted`;
		
		console.log('[update] checksum verified ✓');
		return { manifest, zipData };
	}
}