// @ts-check
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { NodeManager, Updater } from './launcher-core.mjs';
import { startBoardService } from '../board-service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'launcher-config.json');
const CONTRAST_EXE = path.join(__dirname, 'contrast.exe');
const RESOURCES_DIR = path.join(__dirname, '..');
const NEUTRALINO_EXE = path.join(__dirname, 'neutralino-win_x64.exe');
const GITHUB_API = 'https://api.github.com/repos/Seigneur-Machiavel/contrast/releases';
const pkg = JSON.parse(fs.readFileSync(path.join(RESOURCES_DIR, 'package.json'), 'utf8'));
const version = pkg.version; // ex: '0.6.12'
let tryUpdateInterval = null;

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
/** @param {NodeManager} node */
const stopNodeAndExit = async (node) => {
	await node.stop();
	process.exit(0);
}
async function main() {
	const cfg = loadConfig();
	const node = new NodeManager(CONTRAST_EXE);
	const updater = new Updater(GITHUB_API, version, cfg.ignorePreRelease);

	// Auto-update check before starting
	if (cfg.autoUpdate)
		try { await updater.run(RESOURCES_DIR, node); }
		catch (/** @type {any} */ e) { console.log('[update] check failed:', e.message); }

	// Start board service in same process with the hostPubkeyStr passed as an argument for the board to auto-connect to the node on startup.
	startBoardService(node.pubKeyHex);

	// Spawn Neutralino window
	const neutralinoProcess = !fs.existsSync(NEUTRALINO_EXE) ? null
		:spawn(NEUTRALINO_EXE, [], { cwd: __dirname, stdio: 'ignore', detached: false });

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
