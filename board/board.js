if (false) { // For better completion
	const anime = require('animejs');
	const ChatUI = require('../../apps/chat/front-scripts/chat-renderer.js');
}

/** @type {typeof import('hive-p2p')} */
const HiveP2P = await import('../hive-p2p.min.js');
import { NetworkVisualizer } from './visualizer/visualizer.mjs';
import { Connector } from './connector.js';
import { Translator } from './translator.js';
import { AppsManager } from './apps-manager.js';
import { Explorer } from './explorer/explorer.js';
import { Assistant } from './assistant/assistant.js';
import { Dashboard } from './dashboard/dashboard.js';
import { BoardInternalWallet } from './wallet/biw.js';
import { FrontStorage } from '../utils/front-storage.mjs';
import { HIVE_P2P_CONFIG } from '../utils/hive-p2p-config.mjs';
//import { InfoManager } from './info-manager.js';

const host = window.location.hostname;
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);
if (host !== 'lehhaaegmiabahiailaddaihneihbaam') HiveP2P.CLOCK.proxyUrl = '/api/time';
const bootstraps = ['ws://localhost:27260'];
const hiveNode = await HiveP2P.createNode({ bootstraps });

const hasPassword = false; // TODO
const boardStorage = new FrontStorage('board');
const language = await boardStorage.load('language');
const translator = new Translator(async (lang) => {
	boardStorage.save('language', lang);
	if (!language) assistant.requestNewPassword(); // FIRST TIME SETUP
	else if (hasPassword) assistant.requestPasswordToExtract();
	else {
		await assistant.welcome();
		setTimeout(() => assistant.idleMenu('toto'), 4500);
	}
});
window.translator = translator; // Expose translator for debugging and global access in apps

const connector = new Connector(hiveNode);
const assistant = new Assistant();
const explorer = new Explorer(connector);
const dashboard = new Dashboard(connector);
const biw = new BoardInternalWallet(connector, boardStorage);

if (await boardStorage.load('darkModeState')) document.body.classList.add('dark-mode');
else document.body.classList.remove('dark-mode');

//const settingsManager = new SettingsManager(settingsMenuElement);
//const infoManager = new InfoManager();
const visualizer = new NetworkVisualizer(connector, HiveP2P.CryptoCodex);
const windowsWrap = document.getElementById('board-windows-wrap');
const bottomButtonsBar = document.getElementById('board-apps-buttons-bar');
const settingsMenuElement = document.getElementById('board-settings-menu');
const appsManager = new AppsManager(windowsWrap, bottomButtonsBar);
if (true) { // WINDOW EXPOSURE FOR DEBUGGING
	window.networkVisualizer = visualizer; // Expose for debugging
	window.appsManager = appsManager;
	window.hiveNode = hiveNode;
	window.connector = connector;
	window.assistant = assistant;
	window.explorer = explorer;
	window.dashboard = dashboard;
	window.biw = biw;
}

const update = () => { // CENTRALIZED ANIMATION LOOP
	visualizer.networkRenderer.animate();
	//nodeCard.update();
	//subNodeInfoTracker.update();
	requestAnimationFrame(update);
};
requestAnimationFrame(update);

// Implementation with less DOM event listeners
async function clickTitleBarButtonsHandler(e) {
	const button = e.target.closest('button');
	if (!button) return;
	try {
		const ipcRenderer = await import('electron').then(module => module.ipcRenderer);
		switch(button.id) {
			case 'minimize-btn': ipcRenderer.send('minimize-btn-click'); break;
			case 'maximize-btn': ipcRenderer.send('maximize-btn-click'); break;
			case 'close-btn': ipcRenderer.send('close-btn-click'); break;
		}
	} catch (error) {}
}
document.addEventListener('click', (e) => {
	clickTitleBarButtonsHandler(e);
	appsManager.clickHandler(e);
	explorer.clickHandler(e);
	biw.clickHandler(e);
	//infoManager.clickInfoButtonHandler(e);
	//settingsManager.clickSettingsButtonHandler(e);
});

document.addEventListener('keyup', (e) => {
	explorer.keyUpHandler(e);
});
document.addEventListener('mouseover', (e) => {
	appsManager.overAppButtonsHandler(e);
	explorer.overHandler(e);
});
document.addEventListener('dblclick', (e) => appsManager.dlbClickHandler(e));
document.addEventListener('mousedown', (e) => {
	appsManager.mouseDownHandler(e);
	biw.mouseDownHandler(e);
});
document.addEventListener('mouseup', (e) => {
	appsManager.mouseupHandler(e);
	biw.mouseUpHandler(e);
	visualizer.networkRenderer.handleMouseUp(e);
});
document.addEventListener('mousemove', (e) => {
	appsManager.mousemoveHandler(e);
	visualizer.networkRenderer.handleMouseMove(e);
});
document.addEventListener('input', (e) => biw.inputHandler(e));
document.addEventListener('keydown', (e) => {
	biw.keyDownHandler(e);
	visualizer.onKeyDown(e);
});
document.addEventListener('paste', (e) => biw.pasteHandler(e));
document.addEventListener('focusin', (e) => biw.focusInHandler(e));
document.addEventListener('focusout', (e) => biw.focusOutHandler(e));
document.addEventListener('change', (event) => {
	switch(event.target.id) {
		case 'dark-mode-toggle':
    		document.body.classList.toggle('dark-mode');
			boardStorage.save('darkModeState', document.body.classList.contains('dark-mode'));
			break;
		case 'biw-actionSelector':
			biw.components.miniform.open(event.target.value.toUpperCase());
			break;
	}
});
window.addEventListener('resize', function(e) { // Trigger on main window resize event only
	visualizer.networkRenderer.handleWindowResize();
	const { width, height } = windowsWrap.getBoundingClientRect();
	for (const app in appsManager.windows) {
		appsManager.windows[app].element.style.maxWidth = width + 'px';
		appsManager.windows[app].element.style.maxHeight = height + 'px';
	}
});
window.addEventListener('message', function(e) { // TODO
	/*function formatedUrl(urlStr = 'http://127.0.0.1:27271/') { // ERASE THIS PLEASE...
		const url = new URL(urlStr);
		return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
	}*/
	//console.log('message received:', e.data);
	//console.log(e);
	if (e.data?.type === 'iframeClick') {
		for (const app in appsManager.windows) {
			if (!appsManager.windows[app].origin) continue;
			if (formatedUrl(appsManager.windows[app].origin) !== formatedUrl(e.origin)) continue;
			appsManager.setFrontWindow(app);
			break;
		}
	}

	if (e.data?.type === 'copy_text') {
		const authorizedCopyTextOrigins = ['https://cybercon.app', 'http://pinkparrot.science:27280', 'http://localhost:27270', 'http://localhost:27271'];
		if (!authorizedCopyTextOrigins.includes(formatedUrl(e.origin))) {
			console.error('Unauthorized origin for copy_text:', e.origin);
			return;
		}

		navigator.clipboard.writeText(e.data.value).then(() => { console.log('Text copied to clipboard!');
		}).catch(err => { console.error('Failed to copy text to clipboard:', err); });
	}

	const isCyberCon = formatedUrl(e.origin) === formatedUrl(appsManager.windows.cybercon?.origin);
	if (isCyberCon && e.data?.type === 'set_auth_info')
		ipcRenderer.send('store-app-data', 'cyberCon', 'auth_info', e.data.value, true);

	if (isCyberCon && e.data?.type === 'reset_game')
		ipcRenderer.send('delete-app-data', 'cyberCon', 'auth_info');
});

// CONNECTOR EVENTS
const onPeerCountChange = () => {
	console.log(`Peer count changed: ${connector.p2pNode.peerStore.neighborsList.length} neighbors`);
	const resumeElement = document.getElementById('connexion-resume');
	if (!resumeElement) return;

	// 0: red, 1: orange, 2-3: yellow, 4+: green
	const totalPeers = connector.p2pNode.peerStore.neighborsList.length;
	const connectedBootstraps = connector.p2pNode.peerStore.publicNeighborsList.length;
	if (totalPeers < 1 ) resumeElement.innerText = 'Connecting network... 🔴';
	else if (totalPeers < 2)resumeElement.innerText = `${totalPeers} peer [${connectedBootstraps}bstrap] 🟠`;
	else if (totalPeers < 4) resumeElement.innerText = `${totalPeers} peers [${connectedBootstraps}bstrap] 🟡`;
	else resumeElement.innerText = `${totalPeers} peers [${connectedBootstraps}bstrap] 🟢`;
};
connector.on('peer_connect', onPeerCountChange);
connector.on('peer_disconnect', onPeerCountChange);

// OPENING
await new Promise(resolve => setTimeout(resolve, 1000));
if (!language || hasPassword) appsManager.buttonsBar.buttons[0].click(); // OPEN ASSISTANT FOR FIRST TIME SETUP
if (!language) assistant.requestLanguageSelection();
else translator.setLanguage(language);