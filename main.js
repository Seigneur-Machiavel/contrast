const { app, BrowserWindow, Menu, globalShortcut, autoUpdater, dialog } = require('electron');
autoUpdater.logger = require("electron-log");
autoUpdater.logger.transports.file.level = "info";
const setShortcuts = require('./shortcuts.js');
const { MiniLogger } = require('./miniLogger/mini-logger.js');
Menu.setApplicationMenu(null); // remove the window top menu

// GLOBAL VARIABLES
const mainLogger = new MiniLogger('main');
const isDev = !app.isPackaged;
let isQuiting = false;
const startNode = true;
/** @type {BrowserWindow} */
let mainWindow;
/** @type {BrowserWindow[]} */
const windows = {};
let dashboardWorker;
//if (isDev) autoUpdater.setFeedURL( `https://github.com/Seigneur-Machiavel/contrast/releases/download/` );

(async () => { // -- start node worker --
    if (!startNode) return;
    const { NodeAppWorker } = await import('./node/workers/workers-classes.mjs');
    const nodeApp = isDev ? 'stresstest' : 'dashboard';
    dashboardWorker = new NodeAppWorker(nodeApp, 27260, 27271, 27270);

    return; 
    //TEST (successful)
    await new Promise(resolve => setTimeout(resolve, 5000)); // wait for the dashboard to start

    const dialogOpts = {
        type: 'info',
        buttons: ['Redémarrer', 'Plus tard'],
        title: "Mise à jour de l'application",
        //message: process.platform === 'win32' ? releaseNotes : releaseName,
        message: 'toto',
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
/** @param {boolean} nodeIntegration @param {boolean} contextIsolation @param {string} url_or_file */
function createWindow(nodeIntegration, contextIsolation, url_or_file, width = 1366, height = 768, startHidden = true) {
    const window = new BrowserWindow({
        width: width,
        height: height,
        icon: 'img/icon_128.png',
        webPreferences: { nodeIntegration, contextIsolation }
    });

    window.on('close', (e) => { if (isQuiting) return; e.preventDefault(); window.hide(); });
    if (url_or_file.startsWith('http')) {
        window.loadURL(url_or_file);
    } else {
        window.loadFile(url_or_file);
    }

    if (startHidden) window.hide();
    return window;
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
    return mainWindow;
}

autoUpdater.on('update-available', () => {
    console.log('Une mise à jour est disponible.');
});

autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) => {
    const dialogOpts = {
        type: 'info',
        buttons: ['Redémarrer', 'Plus tard'],
        title: 'Mise à jour de l\'application',
        message: process.platform === 'win32' ? releaseNotes : releaseName,
        detail: 'Une nouvelle version a été téléchargée. Redémarrez l\'application pour appliquer les mises à jour.'
    };

    dialog.showMessageBox(dialogOpts).then((returnValue) => {
        return; // TEST
        if (isDev) { console.log('downloaded'); return; } // avoid restart in dev mode
        if (returnValue.response === 0) autoUpdater.quitAndInstall();
    });
});

app.on('ready', async () => {
    // show the app version
    dialog.showMessageBox({ message: `Version: ${app.getVersion()}` });

    if (!isDev) { // autoUpdater
        console.log('feedUrl:', autoUpdater.getFeedURL());
        autoUpdater.checkForUpdates();
    }

    windows.logger = createWindow(true, false, './miniLogger/miniLoggerSetting.html', 300, 500);
    windows.nodeDashboard = createWindow(false, true, 'http://localhost:27271', 1366, 768);

    mainWindow = await createMainWindow();
    // if mainWindow close -> close all windows
    mainWindow.on('close', (e) => { isQuiting = true; app.quit(); });
    setShortcuts(windows, isDev);
    if (isDev) mainWindow.webContents.toggleDevTools(); // dev tools on start
    //BrowserWindow.getFocusedWindow().webContents.toggleDevTools(); // dev tools on start

    // BrowserWindow.getFocusedWindow()
    //(async () => { import('./node/run/dashboard.mjs'); })(); // -> trying as worker
});

app.on('will-quit', async () => {
    globalShortcut.unregisterAll();
    if (dashboardWorker) dashboardWorker.stop();
    await new Promise(resolve => setTimeout(resolve, 10000));
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });