const { app, BrowserWindow, Menu, globalShortcut, autoUpdater, dialog } = require('electron');
const setShortcuts = require('./shortcuts.js');
const { MiniLogger } = require('./miniLogger/mini-logger.js');
Menu.setApplicationMenu(null); // remove the window top menu

// GLOBAL VARIABLES
const mainLogger = new MiniLogger('main');
const isDev = true;
const startNode = true;
/** @type {BrowserWindow} */
let mainWindow;
/** @type {BrowserWindow[]} */
const windows = {};
let dashboardWorker;

(async () => { // -- start node worker --
    if (!startNode) return;
    const { NodeAppWorker } = await import('./node/workers/workers-classes.mjs');
    const nodeApp = isDev ? 'stresstest' : 'dashboard';
    dashboardWorker = new NodeAppWorker(nodeApp, 27260, 27271, 27270);

    //TEST
    await new Promise(resolve => setTimeout(resolve, 5000)); // wait for the dashboard to start

    const dialogOpts = {
        type: 'info',
        buttons: ['Redémarrer', 'Plus tard'],
        title: "Mise à jour de l'application",
        message: process.platform === 'win32' ? releaseNotes : releaseName,
        detail: 'Une nouvelle version a été téléchargée. Redémarrez l\'application pour appliquer les mises à jour.'
    };
     
    dialog.showMessageBox(mainWindow, dialogOpts).then((returnValue) => {
        //if (returnValue.response === 0) autoUpdater.quitAndInstall();
        if (returnValue.response === 0) console.log('Redémarrage');
    });

    return;
    while(isDev) { // -- test restart after 120s to 600s --
        const restartTime = Math.floor(Math.random() * 480000) + 120000;
        mainLogger.log(`--- Restarting node worker in ${(restartTime / 1000).toFixed(2)}s ---`, (m) => { console.log(m); });
        await new Promise(resolve => setTimeout(resolve, restartTime));
        dashboardWorker.restart();
    }
})();
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
    windows.logger = createLoggerSettingWindow();
    windows.logger.hide();

    windows.nodeDashboard = createNodeDashboardWindow();
    windows.nodeDashboard.hide();

    mainWindow = await createMainWindow();
    setShortcuts(windows, isDev);
    if (isDev) mainWindow.webContents.toggleDevTools(); // dev tools on start
    //BrowserWindow.getFocusedWindow().webContents.toggleDevTools(); // dev tools on start

    // BrowserWindow.getFocusedWindow()
    //(async () => { import('./node/run/dashboard.mjs'); })(); // -> trying as worker
});

app.on('will-quit', async () => {
    globalShortcut.unregisterAll();
    if (dashboardWorker) dashboardWorker.stop();
    await new Promise(resolve => setTimeout(resolve, 5000));
});