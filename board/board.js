// IMPORTS
/** @type {typeof import('hive-p2p')} */
const HiveP2P = await import('../hive-p2p.min.js');
import { NetworkVisualizer } from './visualizer/visualizer.js';
import { Connector } from './utils/connector.js';
import { Translator } from './utils/translator.js';
import { AppsManager } from './utils/apps-manager.js';
import { Explorer } from './explorer/explorer.js';
import { Assistant } from './assistant/assistant.js';
import { Dashboard } from './dashboard/dashboard.js';
import { BoardInternalWallet } from './wallet/biw.js';
import { FrontStorage } from '../utils/front-storage.mjs';
import { HIVE_P2P_CONFIG } from '../utils/hive-p2p-config.mjs';
//import { InfoManager } from './info-manager.js';

// INIT P2P NODE AND CORE COMPONENTS
const host = window.location.hostname;
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);
if (host !== 'lehhaaegmiabahiailaddaihneihbaam') HiveP2P.CLOCK.proxyUrl = '/api/time';
const bootstraps = ['ws://localhost:27260'];
const hiveNode = await HiveP2P.createNode({ bootstraps });

const hasPassword = false; // TODO
const boardStorage = new FrontStorage('board');
const language = await boardStorage.load('language');

// ON LANGAGE SET CALLBACK => TRIGGER BY "OPENING" SECTION AT THE END OF THIS FILE
const translator = new Translator(async (lang) => {
	boardStorage.save('language', lang);
	if (!language) assistant.requestNewPassword(); // FIRST TIME SETUP
	else if (hasPassword) assistant.requestPasswordToExtract();
	else {
		await assistant.welcome();
		setTimeout(() => assistant.idleMenu('toto'), 4500);
	}
});

// INIT OTHER MANAGERS AND COMPONENTS
const connector = new Connector(hiveNode);
const explorer = new Explorer(connector);
const dashboard = new Dashboard(connector);
const biw = new BoardInternalWallet(connector, boardStorage);
const assistant = new Assistant(biw, translator);

if (await boardStorage.load('darkModeState')) document.body.classList.add('dark-mode');
else document.body.classList.remove('dark-mode');

const visualizer = new NetworkVisualizer(connector, HiveP2P.CryptoCodex);
const boardVersionElement = document.getElementById('board-version');
const windowsWrapElement = document.getElementById('board-windows-wrap');
const settingsMenuElement = document.getElementById('board-settings-menu');
const bottomButtonsBarElement = document.getElementById('board-apps-buttons-bar');
const appsManager = new AppsManager(windowsWrapElement, bottomButtonsBarElement);
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

// CENTRALIZED ANIMATION LOOP
const update = () => {
	visualizer.networkRenderer.animate();
	visualizer.updatePeerInfo();
	explorer.bc.updateTimeAgo();
	//nodeCard.update();
	//subNodeInfoTracker.update();
	requestAnimationFrame(update);
};
requestAnimationFrame(update);

// CENTRALIZED EVENT HANDLING
async function clickTitleBarButtonsHandler(e) { // DEPRECATED
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
	//clickTitleBarButtonsHandler(e);
	appsManager.clickHandler(e);
	visualizer.clickHandler(e);
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
}, { passive: true });
document.addEventListener('mouseup', (e) => {
	appsManager.mouseupHandler(e);
	biw.mouseUpHandler(e);
	visualizer.networkRenderer.handleMouseUp(e);
});
document.addEventListener('mousemove', (e) => {
	appsManager.mousemoveHandler(e);
	visualizer.networkRenderer.handleMouseMove(e);
}, { passive: true });
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
	const { width, height } = windowsWrapElement.getBoundingClientRect();
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
	const totalPeers = connector.p2pNode.peerStore.neighborsList.length;
	const connectedBootstraps = connector.p2pNode.peerStore.publicNeighborsList.length;
	const connexionResume = document.getElementById('board-connexion-resume');
	const connexionStatusText = document.getElementById('board-connexion-status-text');
	if (!connexionResume || !connexionStatusText) return;

	if (totalPeers < 1 ) connexionResume.classList = 'connecting';
	else if (totalPeers < 2) connexionResume.classList = 'bad';
	else if (totalPeers < 4) connexionResume.classList = 'good';
	else connexionResume.classList = 'perfect';

	if (totalPeers < 1 ) connexionStatusText.textContent = 'Connecting network...';
	else if (totalPeers < 2) connexionStatusText.textContent = `${totalPeers} peer [${connectedBootstraps}bstrap]`;
	else connexionStatusText.textContent = `${totalPeers} peers [${connectedBootstraps}bstrap]`;
};
connector.on('peer_connect', onPeerCountChange);
connector.on('peer_disconnect', onPeerCountChange);

// OPENING => HANDLE PASSWORD AND LANGUAGE SELECTION
await new Promise(resolve => setTimeout(resolve, 1000));
if (!language || hasPassword) appsManager.buttonsBar.buttons[0].click(); // OPEN ASSISTANT FOR FIRST TIME SETUP
if (!language) assistant.requestLanguageSelection();
else translator.setLanguage(language);