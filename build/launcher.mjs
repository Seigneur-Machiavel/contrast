// @ts-check
import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ---- PATHS -------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'launcher-config.json');
const CONTRAST_EXE = path.join(__dirname, 'contrast.exe');
const GITHUB_API = 'https://api.github.com/repos/Seigneur-Machiavel/contrast/releases/latest';

// ---- CONFIG ------------------------------------------------------------------------
const DEFAULT_CONFIG = {
	autoUpdate: true,
	verbose: false,
	validatorAddress: '',
	minerAddress: '',
};

function loadConfig() {
	if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
	try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
	catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(cfg) {
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---- SEED --------------------------------------------------------------------------
// Ephemeral seed generated once at launcher start, passed to contrast.exe
// Stays in memory only — never written to disk
const EPHEMERAL_SEED = crypto.randomBytes(32).toString('hex');

// ---- PROCESS MANAGEMENT ------------------------------------------------------------
/** @type {import('child_process').ChildProcess | null} */
let contrastProcess = null;

function isRunning() { return contrastProcess !== null && !contrastProcess.killed; }

function startNode(cfg) {
	if (isRunning()) { console.log('[launcher] contrast.exe is already running'); return; }
	if (!fs.existsSync(CONTRAST_EXE)) { console.log('[launcher] contrast.exe not found — run: launcher update'); return; }

	const args = ['-cs', EPHEMERAL_SEED];
	if (cfg.validatorAddress) args.push('-validatorAddress', cfg.validatorAddress);
	if (cfg.minerAddress) args.push('-minerAddress', cfg.minerAddress);
	if (cfg.verbose) args.push('-verbose', '2');

	contrastProcess = spawn(CONTRAST_EXE, args, { stdio: 'inherit' });
	contrastProcess.on('exit', (code) => {
		contrastProcess = null;
		console.log(`[launcher] contrast.exe exited (code ${code})`);
	});
	console.log(`[launcher] contrast.exe started (pid ${contrastProcess.pid})`);
	console.log(`[launcher] ephemeral seed: ${EPHEMERAL_SEED}`);
}

async function stopNode() {
	if (!isRunning()) { console.log('[launcher] contrast.exe is not running'); return; }
	contrastProcess.kill('SIGTERM');
	console.log('[launcher] stopping contrast.exe — waiting 5s...');
	await new Promise(r => setTimeout(r, 5_000));
	if (isRunning()) { contrastProcess.kill('SIGKILL'); console.log('[launcher] force killed'); }
	contrastProcess = null;
}

// ---- UPDATE ------------------------------------------------------------------------
function httpsGet(url) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers: { 'User-Agent': 'contrast-launcher' } }, (res) => {
			// Follow redirects (GitHub releases redirect to S3)
			if (res.statusCode === 301 || res.statusCode === 302) {
				resolve(httpsGet(res.headers.location));
				return;
			}
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		});
		req.on('error', reject);
	});
}

async function fetchLatestRelease() {
	const raw = await httpsGet(GITHUB_API);
	return JSON.parse(raw.toString());
}

function sha256(filePath) {
	return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function update(force = false) {
	console.log('[launcher] checking for updates...');
	const release = await fetchLatestRelease();
	const version = release.tag_name;

	// Find contrast.exe and checksums assets
	const exeAsset = release.assets.find(a => a.name === 'contrast.exe');
	const sumAsset = release.assets.find(a => a.name === 'checksums.sha256');
	if (!exeAsset) { console.log('[launcher] no contrast.exe found in latest release'); return false; }

	// Check current version tag stored in config
	const cfg = loadConfig();
	if (!force && cfg.installedVersion === version) {
		console.log(`[launcher] already on latest version ${version}`);
		return false;
	}

	console.log(`[launcher] downloading contrast.exe ${version}...`);
	const exeData = await httpsGet(exeAsset.browser_download_url);
	const tmpPath = CONTRAST_EXE + '.tmp';
	fs.writeFileSync(tmpPath, exeData);

	// Verify sha256 if checksums file is present
	if (sumAsset) {
		const sumsRaw = await httpsGet(sumAsset.browser_download_url);
		const lines = sumsRaw.toString().split('\n');
		const expected = lines.find(l => l.includes('contrast.exe'))?.split(/\s+/)[0];
		if (expected) {
			const actual = sha256(tmpPath);
			if (actual !== expected) {
				fs.unlinkSync(tmpPath);
				console.log('[launcher] checksum mismatch — aborting update');
				return false;
			}
			console.log('[launcher] checksum verified ✓');
		}
	}

	// Replace exe (node must be stopped first)
	if (isRunning()) await stopNode();
	if (fs.existsSync(CONTRAST_EXE)) fs.unlinkSync(CONTRAST_EXE);
	fs.renameSync(tmpPath, CONTRAST_EXE);

	cfg.installedVersion = version;
	saveConfig(cfg);
	console.log(`[launcher] updated to ${version}`);
	return true;
}

// ---- AUTO-STARTUP (Windows registry) ----------------------------------------------
function enableAutoStart() {
	const exePath = process.execPath; // path to launcher.exe itself
	const cmd = `reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Contrast /t REG_SZ /d "${exePath} start" /f`;
	try { execSync(cmd); console.log('[launcher] auto-start enabled'); }
	catch (e) { console.log('[launcher] failed to set auto-start:', e.message); }
}
function disableAutoStart() {
	const cmd = `reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Contrast /f`;
	try { execSync(cmd); console.log('[launcher] auto-start disabled'); }
	catch (e) { console.log('[launcher] failed to remove auto-start:', e.message); }
}

// ---- CLI ---------------------------------------------------------------------------
function printHelp() {
	console.log(`
Contrast Launcher
─────────────────────────────────────────────
  start               Start the contrast node
  stop                Stop the contrast node
  restart             Restart the contrast node
  update              Check and apply update
  show-key            Show ephemeral seed (copy to dashboard)
  config              Show current config
  config set <key> <value>
    autoUpdate        true / false
    verbose           true / false
    validatorAddress  <address>
    minerAddress      <address>
  autostart enable    Register launcher in Windows startup
  autostart disable   Remove launcher from Windows startup
─────────────────────────────────────────────
`);
}

async function main() {
	const args = process.argv.slice(2);
	const cmd = args[0];
	const cfg = loadConfig();

	if (!cmd || cmd === 'help') return printHelp();

	if (cmd === 'start') {
		if (cfg.autoUpdate) {
			try { await update(); } catch (e) { console.log('[launcher] update check failed:', e.message); }
		}
		startNode(cfg);
		return;
	}

	if (cmd === 'stop') { await stopNode(); return; }

	if (cmd === 'restart') {
		await stopNode();
		await new Promise(r => setTimeout(r, 1_000));
		startNode(cfg);
		return;
	}

	if (cmd === 'update') {
		try { await update(true); }
		catch (e) { console.log('[launcher] update failed:', e.message); }
		return;
	}

	if (cmd === 'show-key') {
		if (!isRunning()) { console.log('[launcher] node is not running — seed not active'); return; }
		console.log(`[launcher] ephemeral seed: ${EPHEMERAL_SEED}`);
		return;
	}

	if (cmd === 'config') {
		if (args[1] === 'set') {
			const [,, key, value] = args;
			if (!key || !value) { console.log('usage: config set <key> <value>'); return; }
			if (!(key in DEFAULT_CONFIG)) { console.log(`unknown key: ${key}`); return; }
			// Parse booleans
			cfg[key] = value === 'true' ? true : value === 'false' ? false : value;
			saveConfig(cfg);
			console.log(`[launcher] ${key} = ${cfg[key]}`);
			return;
		}
		console.log('[launcher] current config:', cfg);
		return;
	}

	if (cmd === 'autostart') {
		if (args[1] === 'enable') { enableAutoStart(); return; }
		if (args[1] === 'disable') { disableAutoStart(); return; }
		console.log('usage: autostart enable | disable');
		return;
	}

	console.log(`unknown command: ${cmd}`);
	printHelp();
}

main().catch(e => console.error('[launcher] fatal:', e));
