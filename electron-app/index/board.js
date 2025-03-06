if (false) { // For better completion
	const anime = require('animejs');
	const ChatUI = require('../../apps/chat/front-scripts/chat-renderer.js');
	//const { Assistant } = require('../../apps/assistant/board-assistant.mjs');
}

const { FrontStorage } = require('../../utils/front-storage.js');
const boardStorage = new FrontStorage('board');
(() => { // loadUserPreferences
	const darkModeState = boardStorage.load('darkModeState');
	if (darkModeState === true) document.body.classList.add('dark-mode');
	if (darkModeState === false) document.body.classList.remove('dark-mode');
})();

const path = require('path');
window.path = path;
const fs = require('fs');
window.fs = fs;
const url = require('url');
window.url = url;

const { ipcRenderer } = require('electron');
window.ipcRenderer = ipcRenderer;

const { InfoManager } = require('./info-manager.js');
const { AppsManager } = require('./apps-manager.js');
const { Assistant } = require('../../apps/assistant/board-assistant.js');
const { BoardInternalWallet } = require('../../apps/wallet/biw.js');

/** @type {Assistant} */
let assistant;
/** @type {BoardInternalWallet} */
let biw;

//#region IPC listeners
ipcRenderer.on('no-existing-password', (event, ...args) => assistant.requestNewPassword() );
ipcRenderer.on('set-new-password-result', (event, ...args) => { if (!args[0]) assistant.requestNewPassword('Password creation failed, try again'); });
ipcRenderer.on('password-requested', (event, ...args) => { appsManager.lock(); assistant.requestPasswordToUnlock(); });
ipcRenderer.on('set-password-result', (event, ...args) => { if (!args[0]) assistant.requestPasswordToUnlock(true); });
ipcRenderer.on('no-password-required', (event, ...args) => {
	assistant.sendMessage('No password required, initializing node...');
	ipcRenderer.send('set-password', 'fingerPrint');
});
ipcRenderer.on('app-version', (event, ...args) => { document.getElementById('board-version').innerText = args[0]; });
ipcRenderer.on('waiting-for-priv-key', (event, ...args) => {
	assistant.sendMessage('Would you like to create a new private key or restore an existing wallet?');
	assistant.requestChoice({
		'Generate (new user)': () => {
			assistant.sendMessage('Initializing node... (can take a up to a minute)');
			ipcRenderer.send('generate-private-key-and-start-node');
		},
		'Restore wallet': () => assistant.requestPrivateKey()
	});
});
ipcRenderer.on('node-started', (event, ...args) => {
	const privateKey = args[0];
	biw = new BoardInternalWallet(privateKey);
	window.biw = biw;

	assistant.sendMessage('We are connected baby!');
	setTimeout(() => assistant.idleMenu(), 1000);
	setTimeout(() => appsManager.toggleAppWindow('assistant'), 2000);
	setTimeout(() => appsManager.unlock(), 3000);
	setTimeout(() => appsManager.toggleAppWindow('dashboard'), 4000);
	setTimeout(() => appsManager.toggleAppWindow('explorer'), 5000);
	//setTimeout(() => appsManager.toggleAppWindow('wallet'), 4000);
});
ipcRenderer.on('connexion-resume', (event, ...args) => {
	const resumeElement = document.getElementById('connexion-resume');
	if (!resumeElement) return;

	const { totalPeers, connectedBootstraps, totalBootstraps, relayedPeers } = args[0];
	const appendText = relayedPeers > 0 ? ` [${relayedPeers} relayed]` : '';
	if (totalPeers < 1 ) { 
		resumeElement.innerText = 'Connecting network 🔴';
	} else if (totalPeers < 5) {
		resumeElement.innerText = `${totalPeers} peers [${connectedBootstraps}bstrap] 🟠${appendText}`;
	} else if (totalPeers < 10) {
		resumeElement.innerText = `${totalPeers} peers [${connectedBootstraps}bstrap] 🟡${appendText}`;
	} else {
		resumeElement.innerText = `${totalPeers} peers [${connectedBootstraps}bstrap] 🟢${appendText}`;
	}
});
ipcRenderer.on('assistant-message', (event, ...args) => assistant.sendMessage(args[0], 'system'));
ipcRenderer.on('window-to-front', (event, ...args) => appsManager.setFrontWindow(args[0]));
//#endregion

const windowsWrap = document.getElementById('board-windows-wrap');
const bottomButtonsBar = document.getElementById('board-bottom-buttons-bar');
const infoManager = new InfoManager();
const appsManager = new AppsManager(windowsWrap, bottomButtonsBar);
appsManager.initApps();
window.appsManager = appsManager;

// Implementation with less event listeners
function clickTitleBarButtonsHandler(e) {
	const button = e.target.closest('button');
	if (!button) return;

	switch(button.id) {
		case 'minimize-btn': ipcRenderer.send('minimize-btn-click'); break;
		case 'maximize-btn': ipcRenderer.send('maximize-btn-click'); break;
		case 'close-btn': ipcRenderer.send('close-btn-click'); break;
	}
}
window.addEventListener('click', (e) => {
	infoManager.clickInfoButtonHandler(e);
	clickTitleBarButtonsHandler(e);
	appsManager.clickAppButtonsHandler(e);
	appsManager.clickWindowHandler(e);
});
window.addEventListener('mouseover', (e) => { appsManager.hoverAppButtonsHandler(e); });
document.addEventListener('dblclick', (e) => { if (e.target.classList.contains('title-bar')) appsManager.dlbClickTitleBarHandler(e); });
document.addEventListener('mousedown', (e) => { appsManager.grabWindowHandler(e); });
document.addEventListener('mousemove', (e) => { appsManager.moveWindowHandler(e); appsManager.moveResizeHandler(e); });
document.addEventListener('mouseup', (e) => { appsManager.releaseWindowHandler(e); });
document.addEventListener('change', (event) => {
	switch(event.target.id) {
		case 'dark-mode-toggle':
    		document.body.classList.toggle('dark-mode');
			const darkModeState = document.body.classList.contains('dark-mode');
			for (const app in appsManager.windows) {
				const iframe = appsManager.windows[app].contentElement.querySelector('iframe');
				if (!iframe) continue;
				
				iframe.contentWindow.postMessage({ type: 'darkMode', value: darkModeState }, appsManager.windows[app].origin);
				//console.log('darkMode msg sent:', darkModeState);
			}
			
			//if (!window.modulesLoaded) break;
			boardStorage.save('darkModeState', darkModeState);
			break;
	}
});
window.addEventListener('resize', function() {
	for (const app in appsManager.windows) {
		appsManager.windows[app].element.style.maxWidth = Math.min(appsManager.windows[app].element.style.maxWidth, window.innerWidth) + 'px';
		appsManager.windows[app].element.style.maxHeight = Math.min(appsManager.windows[app].element.style.maxHeight, window.innerHeight) + 'px';
	}
});

window.addEventListener('message', function(e) {
	if (e.data.type && e.data.type === 'iframeClick') {
		for (const app in appsManager.windows) {
			if (appsManager.windows[app].origin !== e.origin) { continue; }
			appsManager.setFrontWindow(app);
			break;
		}
	}
});

//await new Promise(resolve => setTimeout(resolve, 400));

//Setup electronAPI listeners
//while(!window.assistant) { await new Promise(resolve => setTimeout(resolve, 20)); }
//assistant = window.assistant; // set exposed assistant to local variable
assistant = new Assistant('board');
window.assistant = assistant;
assistant.init();