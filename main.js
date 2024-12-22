const path = require('path');
const { app, BrowserWindow, Menu, globalShortcut } = require('electron');
const { P2PChatHandler } = require('./apps/chat/back-scripts/chat-handler.js');
const setShortcuts = require('./shortcuts.js');
const { MiniLogger } = require('./miniLogger/mini-logger.js');

Menu.setApplicationMenu(null);
const mainLogger = new MiniLogger('main');

//(async () => { import('./node/run/dashboard.mjs'); })(); // can be async
// create a worker for the dashboard
const { Worker } = require('worker_threads');
const worker = new Worker('./node/run/dashboard.mjs');
worker.on('error', (err) => { mainLogger.log(err), (m) => { console.error(m); }; });
worker.on('exit', (code) => { mainLogger.log(`Worker stopped with exit code ${code}`), (m) => { console.log(m); }; });

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

    loggerWindow.on('close', (e) => { e.preventDefault(); loggerWindow.hide(); });
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

    await mainWindow.loadFile('index/index.html');

    /*let loaded;
    mainWindow.webContents.on('did-finish-load', () => { loaded = true; });
    while(!loaded) { await new Promise(resolve => setTimeout(resolve, 100)); }*/

	/*mainWindow.webContents.on('will-navigate', async (event) => { // EXPERIMENTAL and useless
		await chatHandler.cleanup();
		globalShortcut.unregisterAll();
	});*/

    return mainWindow;
}

app.on('ready', async () => {
    const loggerWindow = createLoggerSettingWindow();
    loggerWindow.hide();

    const mainWindow = await createMainWindow();
    const handlersKeys = [];
    const chatHandler = new P2PChatHandler(mainWindow);
    handlersKeys.push(Object.keys(chatHandler.setupHandlers()));

    const duplicates = checkArrayOfArraysDuplicate(handlersKeys);
    if (duplicates) { mainLogger.log(`Duplicate IPC handlers detected: ${duplicates}`, (m) => { console.warn(m); }); }

    setShortcuts(loggerWindow, handlersKeys, isDev);
    if (isDev) mainWindow.webContents.toggleDevTools(); // dev tools on start
    //BrowserWindow.getFocusedWindow().webContents.toggleDevTools(); // dev tools on start

    // BrowserWindow.getFocusedWindow()
    //(async () => { import('./node/run/dashboard.mjs'); })(); // -> trying as worker
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });