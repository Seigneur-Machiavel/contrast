const { app, BrowserWindow, Menu, globalShortcut, contextBridge, ipcRenderer, ipcMain, dialog } = require('electron');
const setShortcuts = require('./preferences/shortcuts.js');
const { setupHandlers } = require('./apps/chat/back-scripts/main.js');

const isDev = true;
let mainWindow;
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		icon: 'img/icon_128.png',
		webPreferences: {
			//nodeIntegration: false, // disabled by default when contextIsolation is enabled
			contextIsolation: false,
			webviewTag: true
		}
	});

	mainWindow.loadFile('index.html');
	mainWindow.webContents.on('did-finish-load', () => { setShortcuts(BrowserWindow, globalShortcut, isDev); });
	//chat.mainWindow = mainWindow;
	setupHandlers(ipcMain);
	//console.log("chat setupHandlers done" + chat.mainWindow);
	Menu.setApplicationMenu(null);
}

app.whenReady().then(createWindow);
app.on('will-quit', () => { globalShortcut.unregisterAll(); });