const { app, BrowserWindow, Menu, globalShortcut, contextBridge, ipcRenderer } = require('electron');
const setShortcuts = require('./preferences/shortcuts.js');

const isDev = true;

function createWindow() {
	const mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		icon: 'img/icon_128.png',
		webPreferences: {
			//nodeIntegration: false, // disabled by default when contextIsolation is enabled
			contextIsolation: true,
			webviewTag: true
		}
	});

	mainWindow.loadFile('index.html');
	mainWindow.webContents.on('did-finish-load', () => { setShortcuts(BrowserWindow, globalShortcut, isDev); });

	Menu.setApplicationMenu(null);
}

app.whenReady().then(createWindow);
app.on('will-quit', () => { globalShortcut.unregisterAll(); });