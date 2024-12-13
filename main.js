const path = require('path');
const { app, BrowserWindow, Menu, globalShortcut } = require('electron');
const { P2PChatHandler } = require('./apps/chat/back-scripts/chat-handler.js');
const setShortcuts = require('./preferences/shortcuts.js');

const isDev = true;

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: 'img/icon_128.png',
        webPreferences: {
            //nodeIntegration: false, // default disabled if contextIsolation is set to true
            contextIsolation: true,
            //webviewTag: true, // unused actually
            preload: path.join(__dirname, 'preload.js')
        }
    });

	const chatHandler = new P2PChatHandler(mainWindow);
    mainWindow.loadFile('index.html');
    mainWindow.webContents.on('did-finish-load', () => {
		const chatHandlers = chatHandler.setupHandlers();
		setShortcuts(BrowserWindow, [ chatHandlers ], isDev);
	});

    Menu.setApplicationMenu(null);
}

app.whenReady().then(createWindow);

/*app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});*/

/*app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});*/

app.on('will-quit', () => { globalShortcut.unregisterAll(); });