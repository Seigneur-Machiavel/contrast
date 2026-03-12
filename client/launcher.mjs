// @ts-check
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { NodeManager, Updater } from './launcher-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'launcher-config.json');
const CONTRAST_EXE = path.join(__dirname, 'contrast.exe');
const RESOURCES_DIR = path.join(__dirname, '..');
const NEUTRALINO_EXE = path.join(__dirname, 'neutralino-win_x64.exe');
const GITHUB_API = 'https://api.github.com/repos/Seigneur-Machiavel/contrast/releases';

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

// ---- AUTO-STARTUP ------------------------------------------------------------------
function enableAutoStart() {
	const cmd = `reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Contrast /t REG_SZ /d "${process.execPath}" /f`;
	try { execSync(cmd); console.log('[autostart] enabled'); }
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
	const updater = new Updater(GITHUB_API, CONFIG_PATH, cfg.ignorePreRelease);

	// Auto-update check before starting
	if (true) //cfg.autoUpdate)
		try { await updater.run(RESOURCES_DIR, node); }
		catch (/** @type {any} */ e) { console.log('[update] check failed:', e.message); }

	// Start board service in same process
	await import('../board-service.mjs');

	// Spawn Neutralino window
	if (!fs.existsSync(NEUTRALINO_EXE)) console.log('[launcher] neutralino not found, skipping window');
	else {
		const neutralinoProcess = spawn(NEUTRALINO_EXE, [], { cwd: __dirname, stdio: 'ignore', detached: false });
		neutralinoProcess.on('exit', () => stopNodeAndExit(node));
	}
		

	// Start node subprocess with auto-restart
	node.start();

	// Graceful shutdown on process exit
	process.on('SIGTERM', async () => await stopNodeAndExit(node));
	process.on('SIGINT', async () => await stopNodeAndExit(node));
}

main().catch(e => console.error('[launcher] fatal:', e));
