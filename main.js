const path = require('path');
const { app, BrowserWindow, Menu, globalShortcut } = require('electron');
const { P2PChatHandler } = require('./apps/chat/back-scripts/chat-handler.js');
const setShortcuts = require('./shortcuts.js');
const { MiniLogger } = require('./miniLogger/mini-logger.js');

Menu.setApplicationMenu(null);
const mainLogger = new MiniLogger('main');

const isDev = true;
let dashboardWorker;
(async () => {
    const { NodeAppWorker } = await import('./node/workers/workers-classes.mjs');
    const nodeApp = isDev ? 'stresstest' : 'dashboard';
    dashboardWorker = new NodeAppWorker(nodeApp, 27260, 27271, 27270);

    while(isDev) {
        // -- test restart after 120s to 300s --
        const restartTime = Math.floor(Math.random() * 180000) + 120000;
        mainLogger.log(`--- Restarting node worker in ${(restartTime / 1000).toFixed(2)}s ---`, (m) => { console.log(m); });
        await new Promise(resolve => setTimeout(resolve, restartTime));
        dashboardWorker.stop(); // but auto restarts
    }
})();

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
function createNodeDashboardWindow() {
    const nodeDashboardWindow = new BrowserWindow({
        width: 1366,
        height: 768,
        icon: 'img/icon_128.png',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    nodeDashboardWindow.on('close', (e) => { e.preventDefault(); nodeDashboardWindow.hide(); });
    nodeDashboardWindow.loadURL('http://localhost:27271');
    return nodeDashboardWindow;
}
async function createMainWindow() {
    /** @type {BrowserWindow} */
    const mainWindow = new BrowserWindow({
        width: 1366,
        height: 768,
        icon: 'img/icon_128.png',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            // preload: path.join(__dirname, 'preload.js') not with nodeIntegration: true
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
    const windows = {};

    windows.logger = createLoggerSettingWindow();
    windows.logger.hide();

    windows.nodeDashboard = createNodeDashboardWindow();
    windows.nodeDashboard.hide();

    const mainWindow = await createMainWindow();
    const handlersKeys = [];
    const chatHandler = new P2PChatHandler(mainWindow);
    handlersKeys.push(Object.keys(chatHandler.setupHandlers()));

    const duplicates = checkArrayOfArraysDuplicate(handlersKeys);
    if (duplicates) { mainLogger.log(`Duplicate IPC handlers detected: ${duplicates}`, (m) => { console.warn(m); }); }

    setShortcuts(windows, handlersKeys, isDev);
    if (isDev) mainWindow.webContents.toggleDevTools(); // dev tools on start
    //BrowserWindow.getFocusedWindow().webContents.toggleDevTools(); // dev tools on start

    // BrowserWindow.getFocusedWindow()
    //(async () => { import('./node/run/dashboard.mjs'); })(); // -> trying as worker
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });