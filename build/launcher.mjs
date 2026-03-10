// @ts-check
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { NodeManager, Updater } from './launcher-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'launcher-config.json');
const CONTRAST_EXE = path.join(__dirname, 'contrast.exe');
const GITHUB_API = 'https://api.github.com/repos/Seigneur-Machiavel/contrast/releases/latest';

// ---- CONFIG ------------------------------------------------------------------------
/** @typedef {{ autoUpdate: boolean, verbose: boolean, validatorAddress: string, minerAddress: string, installedVersion?: string }} LauncherConfig */

/** @type {LauncherConfig} */
const DEFAULT_CONFIG = { autoUpdate: true, verbose: false, validatorAddress: '', minerAddress: '' };

/** @returns {LauncherConfig} */
function loadConfig() {
	if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
	try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
	catch { return { ...DEFAULT_CONFIG }; }
}
/** @param {LauncherConfig} cfg */
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

// ---- AUTO-STARTUP ------------------------------------------------------------------
function enableAutoStart() {
	const cmd = `reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Contrast /t REG_SZ /d "${process.execPath}" /f`;
	try { execSync(cmd); console.log('[autostart] enabled'); }
	catch (/** @type {any} */ e) { console.log('[autostart] failed:', e.message); }
}
function disableAutoStart() {
	try { execSync(`reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Contrast /f`); console.log('[autostart] disabled'); }
	catch (/** @type {any} */ e) { console.log('[autostart] failed:', e.message); }
}

// ---- CLI ---------------------------------------------------------------------------
function printHelp() {
	console.log(`
Contrast Launcher ─────────────────────────────
  start                     Start the node
  stop                      Stop the node
  restart                   Restart the node
  update                    Check and apply update
  show-key                  Show ephemeral seed
  config                    Show current config
  config set <key> <value>
    autoUpdate              true / false
    verbose                 true / false
    validatorAddress        <address>
    minerAddress            <address>
  autostart enable/disable  Windows startup toggle
  help                      Show this menu
────────────────────────────────────────────────
`);
}

// ---- MAIN --------------------------------------------------------------------------
/** @param {NodeManager} node @param {Updater} updater @param {string} input */
async function handleCommand(node, updater, input) {
	const parts = input.trim().split(/\s+/);
	const cmd = parts[0];
	const cfg = loadConfig();

	if (!cmd || cmd === 'help') { printHelp(); return; }

	if (cmd === 'start') {
		if (cfg.autoUpdate)
			try { await updater.run(CONTRAST_EXE, node); }
			catch (/** @type {any} */ e) { console.log('[update] check failed:', e.message); }
		node.start(CONTRAST_EXE, cfg);
		return;
	}

	if (cmd === 'stop') { await node.stop(); return; }
	if (cmd === 'restart') { await node.restart(CONTRAST_EXE, cfg); return; }

	if (cmd === 'update') {
		try { await updater.run(CONTRAST_EXE, node, true); }
		catch (/** @type {any} */ e) { console.log('[update] failed:', e.message); }
		return;
	}

	if (cmd === 'show-key') {
		if (!node.isRunning) { console.log('[launcher] node is not running'); return; }
		console.log(`[launcher] ephemeral seed: ${node.seed}`);
		return;
	}

	if (cmd === 'config') {
		if (parts[1] !== 'set') { console.log('[config]', cfg); return; }
		const [,, key, value] = parts;
		if (!key || !value) { console.log('usage: config set <key> <value>'); return; }
		if (!(key in DEFAULT_CONFIG)) { console.log(`unknown key: ${key}`); return; } // @ts-ignore
		cfg[key] = value === 'true' ? true : value === 'false' ? false : value;
		saveConfig(cfg); // @ts-ignore
		console.log(`[config] ${key} = ${cfg[key]}`);
		return;
	}

	if (cmd === 'autostart') {
		if (parts[1] === 'enable') { enableAutoStart(); return; }
		if (parts[1] === 'disable') { disableAutoStart(); return; }
		console.log('usage: autostart enable | disable');
		return;
	}

	console.log(`unknown command: ${cmd} — type 'help'`);
}

async function main() {
	printHelp();
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
	const node = new NodeManager(() => rl.prompt(true));
	const updater = new Updater(GITHUB_API);

	rl.prompt();
	rl.on('line', async (line) => {
		await handleCommand(node, updater, line);
		rl.prompt();
	});
	rl.on('close', async () => {
		await node.stop();
		process.exit(0);
	});
}

main().catch(e => console.error('[launcher] fatal:', e));
