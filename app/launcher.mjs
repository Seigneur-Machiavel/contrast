// @ts-check
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { Updater } from './updater.mjs';
import { execSync } from 'child_process';

const safeConnexionToken = crypto.randomBytes(32).toString('hex');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'launcher-config.json');
const CONTRAST_EXE = path.join(__dirname, 'contrast.exe');
const RESOURCES_DIR = path.join(__dirname, '..');
const NEUTRALINO_EXE = path.join(__dirname, 'neutralino-win_x64.exe');
const GITHUB_API = 'https://api.github.com/repos/Seigneur-Machiavel/contrast/releases';
const pkg = JSON.parse(fs.readFileSync(path.join(RESOURCES_DIR, 'package.json'), 'utf8'));
const version = pkg.version; // ex: '0.6.12'
let tryUpdateInterval = null;

process.on('uncaughtException', async (err) => {
	console.error('Uncaught Exception:', err);
	setTimeout(() => process.exit(1), 5000); // allow log reading, then force exit.
});

// ---- CONFIG ------------------------------------------------------------------------
/** @typedef {{ autoUpdate: boolean, ignorePreRelease: boolean, installedVersion?: string }} LauncherConfig */
/** @type {LauncherConfig} */
const DEFAULT_CONFIG = { autoUpdate: true, ignorePreRelease: true };

/** @returns {LauncherConfig} */
function loadConfig() {
	if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
	try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
	catch { return { ...DEFAULT_CONFIG }; }
}
function enableAutoStart() {
	const cmd = `reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Contrast /t REG_SZ /d "${process.execPath}" /f`;
	try { execSync(cmd); console.log('[autostart] enabled'); }
	catch (/** @type {any} */ e) { console.log('[autostart] failed:', e.message); }
}
function disableAutoStart() {
	const cmd = `reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Contrast /f`;
	try { execSync(cmd); console.log('[autostart] disabled'); }
	catch (/** @type {any} */ e) { console.log('[autostart] failed:', e.message); }
}

// ---- MAIN --------------------------------------------------------------------------
/** @param {import('./node-manager.mjs').NodeManager} node */
const stopNodeAndExit = async (node) => {
	await node.stop();
	process.exit(0);
}
async function main() {
	const cfg = loadConfig();
	const updater = new Updater(GITHUB_API, version, cfg.ignorePreRelease);

	// Auto-update check before starting
	if (cfg.autoUpdate)
		try { await updater.run(RESOURCES_DIR); }
		catch (/** @type {any} */ e) { console.log('[update] check failed:', e.message); }

	const { NodeManager } = await import('./node-manager.mjs');
	const node = new NodeManager(CONTRAST_EXE);

	const { startBoardService } = await import('../node/board-service.mjs');
	startBoardService(safeConnexionToken, node.pubKeyHex);

	// Spawn Neutralino window with token in query for secure board.js access, if available
	const neutralinoArgs = safeConnexionToken ? [`--url=http://localhost:27262?token=${safeConnexionToken}`] : [];
	const neutralinoProcess = !fs.existsSync(NEUTRALINO_EXE) ? null
		:spawn(NEUTRALINO_EXE, neutralinoArgs, { cwd: __dirname, stdio: 'ignore', detached: false });

	if (!neutralinoProcess) console.log('[launcher] neutralino not found, skipping window');
	else neutralinoProcess.on('exit', () => stopNodeAndExit(node));

	// Start node subprocess with auto-restart
	node.start();

	// Graceful shutdown on process exit
	process.on('SIGTERM', async () => await stopNodeAndExit(node));
	process.on('SIGINT', async () => await stopNodeAndExit(node));

	// autoUpdate interval setup (check every 20 minutes)
	if (cfg.autoUpdate) tryUpdateInterval = setInterval(async () => {
		try { await updater.run(RESOURCES_DIR, node); }
		catch (/** @type {any} */ e) { console.log('[update] check failed:', e.message); }
	}, 20 * 60 * 1000);
}
main().catch(e => console.error('[launcher] fatal:', e));
