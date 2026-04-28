// CORE COMPONENTS
/** @type {typeof import('hive-p2p')} */
const HiveP2P = await import('../hive-p2p.min.js');
import { NetworkVisualizer } from './visualizer/visualizer.js';
import { ConnectorP2P } from './utils/connector-p2p.js';
import { ConnectorNode } from './utils/connector-node.js';
import { Translator } from './utils/translator.js';
import { FrontStorage } from '../utils/front-storage.mjs';
import { HIVE_P2P_CONFIG } from '../config/hive-p2p-config.mjs';

// APPS
import { AppsManager } from './utils/apps-manager.js';
import { Explorer } from './explorer/explorer.js';
import { Assistant } from './assistant/assistant.js';
import { Dashboard } from './dashboard/dashboard.js';
import { BoardInternalWallet } from './wallet/biw.js';
//import { InfoManager } from './info-manager.js';

// INIT P2P NODE AND CORE COMPONENTS
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);
const isExtension = window.location.protocol.endsWith('-extension:');
if (!isExtension) HiveP2P.CLOCK.proxyUrl = '/api/time'; // Use proxy for web version, direct connection for extension (not possible to use proxy in extension background page context)

const version = '0.6.12'; // Overwrite by board-service.mjs on the fly, based on "contrast/package.json" version field. Used for display in the UI and for update checks.
const bootstraps = ['ws://localhost:27260'];
const hostPubkeyStr = null; // Pass from launcher args to board-service.
const hiveNode = await HiveP2P.createNode({ bootstraps, autoStart: false });
hiveNode.start();

const WS_SETTINGS = { PROTOCOL: "ws:", DOMAIN: "127.0.0.1", PORT: 27261 }; // Overwrite by board-service.mjs on the fly, based on launcher args if provided, otherwise default to these values. Used for ConnectorNode to connect to board-service's WebSocket server.
const hasPassword = false; // TODO
const boardStorage = new FrontStorage('board');
const language = await boardStorage.load('language');

// ON LANGAGE SET CALLBACK => TRIGGER BY "OPENING" SECTION AT THE END OF THIS FILE
const translator = new Translator(async (lang) => {
	boardStorage.save('language', lang);
	assistant.commandInterpreter.updateCommandsCorrespondences();

	await assistant.welcome(language ? false : true); // Only display setup message if language is not set (first time setup)
	assistant.start(); // GO DIRECTLY.
});

// INIT OTHER MANAGERS AND COMPONENTS
const connectorP2P = new ConnectorP2P(hiveNode);
const connectorNode = new ConnectorNode(connectorP2P, WS_SETTINGS, hostPubkeyStr);
const explorer = new Explorer(connectorP2P);
const dashboard = new Dashboard(connectorP2P, connectorNode);
const biw = new BoardInternalWallet(connectorP2P, boardStorage);

if (await boardStorage.load('darkModeState')) document.body.classList.add('dark-mode');
else document.body.classList.remove('dark-mode');

const boardVersionElement = document.getElementById('board-version');
if (boardVersionElement) boardVersionElement.textContent = `v${version}`;

const visualizer = new NetworkVisualizer(connectorP2P, HiveP2P.CryptoCodex);
const windowsWrapElement = document.getElementById('board-windows-wrap');
const settingsMenuElement = document.getElementById('board-settings-menu');
const bottomButtonsBarElement = document.getElementById('board-apps-buttons-bar');
const appsManager = new AppsManager(windowsWrapElement, bottomButtonsBarElement);
const assistant = new Assistant(biw, connectorNode, appsManager, isExtension, translator);
if (true) { // WINDOW EXPOSURE FOR DEBUGGING
	window.networkVisualizer = visualizer; // Expose for debugging
	window.appsManager = appsManager;
	window.hiveNode = hiveNode;
	window.connectorP2P = connectorP2P;
	window.connectorNode = connectorNode;
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
document.addEventListener('click', (e) => {
	//clickTitleBarButtonsHandler(e);
	appsManager.clickHandler(e);
	visualizer.clickHandler(e);
	dashboard.clickHandler(e);
	explorer.clickHandler(e);
	biw.clickHandler(e);
	//infoManager.clickInfoButtonHandler(e);
	//settingsManager.clickSettingsButtonHandler(e);
});
document.addEventListener('keyup', (e) => { explorer.keyUpHandler(e); });
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
document.addEventListener('input', (e) => { biw.inputHandler(e), dashboard.inputHandler(e) });
document.addEventListener('keydown', (e) => {
	biw.keyDownHandler(e);
	visualizer.onKeyDown(e);
});
document.addEventListener('paste', (e) => { biw.pasteHandler(e), dashboard.pasteHandler(e) });
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
		appsManager.windows[app].element.style.maxWidth = width - 4 + 'px';
		appsManager.windows[app].element.style.maxHeight = height - 6 + 'px';
	}
});

// CONNECTOR EVENTS
const onPeerCountChange = () => {
	const totalPeers = connectorP2P.p2pNode.peerStore.neighborsList.length;
	const connectedBootstraps = connectorP2P.p2pNode.peerStore.publicNeighborsList.length;
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
connectorP2P.on('peer_connect', onPeerCountChange);
connectorP2P.on('peer_disconnect', onPeerCountChange);

// OPENING => HANDLE PASSWORD AND LANGUAGE SELECTION
appsManager.buttonsBar.buttons[0].click(); // OPEN ASSISTANT FOR FIRST TIME SETUP

while (!assistant.isReady) await new Promise(resolve => setTimeout(resolve, 20));
if (!language) assistant.interactor.requestLanguageSelection();
else translator.setLanguage(language);