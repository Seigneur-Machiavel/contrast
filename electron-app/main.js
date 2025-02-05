if (false) { const { NodeAppWorker } = require('../node/workers/workers-classes.mjs'); } // For better completion

/**
 * @typedef {Object} WindowOptions
 * @property {boolean} nodeIntegration
 * @property {boolean} contextIsolation
 * @property {string} url_or_file
 * @property {number} width
 * @property {number} height
 * @property {boolean} [startHidden] - default true
 * @property {boolean} [isMainWindow] - default false */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, globalShortcut, dialog, session } = require('electron');
Menu.setApplicationMenu(null); // remove the window top menu

const { autoUpdater } = require('electron-updater');
const setShortcuts = require('./shortcuts.js');
const { MiniLogger } = require('../miniLogger/mini-logger.js');
/*const log = require('electron-log');
log.transports.file.level = 'info';
log.info('--- Test log ---');
autoUpdater.logger = log;*/

// GLOBAL VARIABLES
const windowsOptions = {
    logger: { nodeIntegration: true, contextIsolation: false, url_or_file: '../miniLogger/miniLoggerSetting.html', width: 300, height: 500 },
    nodeDashboard: { nodeIntegration: false, contextIsolation: true, url_or_file: 'http://localhost:27271', width: 1366, height: 768 },
    mainWindow: { nodeIntegration: true, contextIsolation: false, url_or_file: 'index/board.html', width: 1366, height: 768, startHidden: false, isMainWindow: true }
}
const mainLogger = new MiniLogger('main');
const isDev = !app.isPackaged;
let isQuiting = false;
/** @type {BrowserWindow} */
let mainWindow;
/** @type {BrowserWindow[]} */
const windows = {};
/** @type {NodeAppWorker} */
let dashboardWorker;

async function startNode(randomRestartTest = false) {
    const { NodeAppWorker } = await import('../node/workers/workers-classes.mjs');
    const nodeApp = isDev ? 'stresstest' : 'dashboard';
    dashboardWorker = new NodeAppWorker(nodeApp, 27260, 27271, 27270);

    if (!randomRestartTest) return;

    await new Promise(resolve => setTimeout(resolve, 5000)); // wait for the dashboard to start
    while(isDev) { // -- test restart after 120s to 600s --
        const restartTime = Math.floor(Math.random() * 480000) + 120000;
        mainLogger.log(`--- Restarting node worker in ${(restartTime / 1000).toFixed(2)}s ---`, (m) => { console.log(m); });
        await new Promise(resolve => setTimeout(resolve, restartTime));
        dashboardWorker.restart();
    }
}
/** @param {WindowOptions} options */
async function createWindow(options) {
    const { nodeIntegration, contextIsolation, url_or_file, width, height, startHidden = true, isMainWindow = false } = options;

    const window = new BrowserWindow({
        width,
        height,
        icon: 'electron-app/img/icon_256.png',
        webPreferences: {
            nodeIntegration,
            contextIsolation,
            // preload: isMainWindow ? path.join(__dirname, 'preload.js') : undefined //(not with nodeIntegration: true)
        }
    });

    if (isMainWindow) {
        window.on('close', () => { if (!isQuiting) app.quit(); });
        //const walletExtensionPath = path.resolve(__dirname, '../wallet-plugin');
        //console.log(walletExtensionPath);
        //await session.defaultSession.loadExtension(walletExtensionPath);
        const version = isDev ? JSON.parse(fs.readFileSync('package.json')).version : app.getVersion();
        window.webContents.executeJavaScript(`document.getElementById('board-version').innerText = "v${version}";`, true);
    } else {
        window.on('close', (e) => { if (!isQuiting) { e.preventDefault(); window.hide() } });
    }

    const isUrl = url_or_file.startsWith('http');
    if (isUrl) { window.loadURL(url_or_file); } else { window.loadFile(url_or_file); }

    if (startHidden) window.hide();
    return window;
}

autoUpdater.on('update-available', (e) => { console.log(`A new update is available: v${e.version}`); });
app.on('before-quit', () => { isQuiting = true; globalShortcut.unregisterAll(); if (dashboardWorker) { dashboardWorker.stop(); } });
app.on('will-quit', async () => { await new Promise(resolve => setTimeout(resolve, 10000)) }); // let time for the node to stop properly
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); }); // quit when all windows are closed

autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) => {
    const dialogOpts = {
        type: 'info',
        buttons: ['Restart', 'Later'],
        title: 'Updating application',
        message: process.platform === 'win32' ? releaseNotes : releaseName,
        detail: 'A new version has been downloaded. Restart the application to apply the updates now?'
    };

    dialog.showMessageBox(dialogOpts).then((returnValue) => {
        if (isDev) { console.log('downloaded'); return; } // avoid restart/install in dev mode
        if (returnValue.response === 0) autoUpdater.quitAndInstall();
    });
});
app.on('ready', async () => {
    if (!isDev) autoUpdater.checkForUpdatesAndNotify();

    startNode();

    windows.logger = await createWindow(windowsOptions.logger);
    windows.nodeDashboard = await createWindow(windowsOptions.nodeDashboard);
    mainWindow = await createWindow(windowsOptions.mainWindow);

    setShortcuts(windows, isDev);
    if (isDev) mainWindow.webContents.toggleDevTools(); // dev tools on start
});