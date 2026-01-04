if (false) { // For better completion
	const anime = require('animejs');
	const ChatUI = require('../../apps/chat/front-scripts/chat-renderer.js');
}

import { AppsManager } from './apps-manager.mjs';
import { FrontStorage } from '../utils/front-storage.mjs';

const boardStorage = new FrontStorage('board');
const darkModeState = boardStorage.load('darkModeState');
if (darkModeState === true) document.body.classList.add('dark-mode');
if (darkModeState === false) document.body.classList.remove('dark-mode');

//const { ipcRenderer } = require('electron');
//window.ipcRenderer = ipcRenderer;

//const { InfoManager } = require('./info-manager.js');

//const settingsManager = new SettingsManager(settingsMenuElement);
//const infoManager = new InfoManager();
const windowsWrap = document.getElementById('board-windows-wrap');
const bottomButtonsBar = document.getElementById('board-apps-buttons-bar');
const appsManager = new AppsManager(windowsWrap, bottomButtonsBar);
const settingsMenuElement = document.getElementById('board-settings-menu');
appsManager.initApps();
window.appsManager = appsManager;

// Implementation with less event listeners
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
window.addEventListener('click', (e) => {
	//infoManager.clickInfoButtonHandler(e);
	clickTitleBarButtonsHandler(e);
	appsManager.clickAppButtonsHandler(e);
	appsManager.clickWindowHandler(e);
	//settingsManager.clickSettingsButtonHandler(e);
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
window.addEventListener('resize', function(e) { // Trigger on main window resize event only
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