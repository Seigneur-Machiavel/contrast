const path = require('path');
const { app, BrowserWindow, Menu, globalShortcut } = require('electron');
const { P2PChatHandler } = require('./apps/chat/back-scripts/chat-handler.js');
const setShortcuts = require('./preferences/shortcuts.js');
const { MiniLogger, loadMergedConfig } = require('./miniLogger/mini-logger.js');

Menu.setApplicationMenu(null);
const miniLoggerConfig = loadMergedConfig();
const miniLogger = new MiniLogger(miniLoggerConfig);

const isDev = true;
function checkArrayOfArraysDuplicate(handlersKeys = []) {
    const handlers = handlersKeys.flat();
    const duplicates = handlers.filter((v, i) => handlers.indexOf(v) !== i);
    if (duplicates.length > 0) {
        return duplicates;
    }
    return false;
}
function createLoggerSettingWindow() {
    const loggerWindow = new BrowserWindow({
        width: 300,
        height: 500,
        icon: 'img/icon_128.png',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    loggerWindow.on('close', (e) => {
        e.preventDefault();

        const actualizedMiniLoggerConfig = loadMergedConfig();
        miniLogger.initFromConfig(actualizedMiniLoggerConfig);

        miniLogger.log('global', 'Logger settings swapped');
        loggerWindow.hide();
    });

    loggerWindow.loadFile('./miniLogger/miniLoggerSetting.html');
    return loggerWindow;
}
async function createMainWindow() {
    /** @type {BrowserWindow} */
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

    let loaded;
    mainWindow.webContents.on('did-finish-load', () => { loaded = true; });

	/*mainWindow.webContents.on('will-navigate', async (event) => { // EXPERIMENTAL and useless
		await chatHandler.cleanup();
		globalShortcut.unregisterAll();
	});*/

    while(!loaded) { await new Promise(resolve => setTimeout(resolve, 100)); }
    return mainWindow;
}

app.on('ready', async () => {
    const loggerWindow = createLoggerSettingWindow();
    loggerWindow.hide();

    const mainWindow = await createMainWindow();
    const handlersKeys = [];
    const chatHandler = new P2PChatHandler(mainWindow, miniLogger);
    handlersKeys.push(Object.keys(chatHandler.setupHandlers()));

    const duplicates = checkArrayOfArraysDuplicate(handlersKeys);
    if (duplicates) { miniLogger.error('Duplicate IPC handlers detected:', duplicates); return; }

    setShortcuts(miniLogger, loggerWindow, handlersKeys, isDev);
    BrowserWindow.getFocusedWindow().webContents.toggleDevTools(); // dev tools on start
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });