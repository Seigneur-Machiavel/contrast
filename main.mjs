import { app, BrowserWindow, Menu, globalShortcut } from 'electron';
import setShortcuts from './preferences/shortcuts.mjs';

function createWindow() {
	const mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		icon: 'img/icon_128.png',
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false
		}
	});

	mainWindow.loadFile('index.html');
	mainWindow.webContents.on('did-finish-load', setShortcuts);
	Menu.setApplicationMenu(null);
	
}

app.whenReady().then(createWindow);
app.on('will-quit', () => { globalShortcut.unregisterAll(); });