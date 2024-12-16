const path = require('path');
const { app, BrowserWindow, Menu, globalShortcut } = require('electron');
const { P2PChatHandler } = require('./apps/chat/back-scripts/chat-handler.js');
const setShortcuts = require('./preferences/shortcuts.js');

const isDev = true;
function checkArrayOfArraysDuplicate(handlersKeys = []) {
    const handlers = handlersKeys.flat();
    const duplicates = handlers.filter((v, i) => handlers.indexOf(v) !== i);
    if (duplicates.length > 0) {
        return duplicates;
    }
    return false;
}

async function createWindow() {
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

    mainWindow.loadFile('index.html');

	const chatHandler = new P2PChatHandler(mainWindow);
    mainWindow.webContents.on('did-finish-load', () => {
		console.log('Main window loaded. -> Setting up chatHandlers && shortcuts');
        const handlersKeys = [];
        handlersKeys.push(Object.keys(chatHandler.setupHandlers()));

        const duplicates = checkArrayOfArraysDuplicate(handlersKeys);
        if (duplicates) { console.error('Duplicate IPC handlers detected:', duplicates); return; }

		setShortcuts(BrowserWindow, handlersKeys, isDev);
	});

	/*mainWindow.webContents.on('will-navigate', async (event) => { // EXPERIMENTAL and useless
		await chatHandler.cleanup();
		globalShortcut.unregisterAll();
	});*/

    Menu.setApplicationMenu(null);
}

app.whenReady().then(createWindow);

app.on('will-quit', () => { globalShortcut.unregisterAll(); });