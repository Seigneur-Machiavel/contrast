if (false) { const { NodeAppWorker } = require('./node/workers/workers-classes.mjs'); } // For better completion

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
const { app, BrowserWindow, Menu, globalShortcut, dialog, ipcMain } = require('electron');
Menu.setApplicationMenu(null); // remove the window top menu

const { autoUpdater } = require('electron-updater');
const setShortcuts = require('./electron-app/shortcuts.js');
const { MiniLogger } = require('./miniLogger/mini-logger.js');
const AutoLaunch = require('auto-launch');
/*const log = require('electron-log');
log.transports.file.level = 'info';
log.info('--- Test log ---');
autoUpdater.logger = log;*/

// GLOBAL VARIABLES
const windowsOptions = {
    logger: { nodeIntegration: true, contextIsolation: false, url_or_file: './miniLogger/miniLoggerSetting.html', width: 300, height: 500 },
    nodeDashboard: { nodeIntegration: false, contextIsolation: true, url_or_file: 'http://localhost:27271', width: 1366, height: 768 },
    mainWindow: { nodeIntegration: false, contextIsolation: true, url_or_file: './electron-app/index/board.html', width: 1366, height: 800, startHidden: false, isMainWindow: true }
}
const mainLogger = new MiniLogger('main');
const myAppAutoLauncher = new AutoLaunch({ name: 'Contrast' });
const isDev = !app.isPackaged;
const nodeApp = isDev ? 'stresstest' : 'dashboard';
let isQuiting = false;
/** @type {Object<string, BrowserWindow>} */
const windows = {};
/** @type {NodeAppWorker} */
let dashboardWorker;

async function randomRestartTest() {
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
    const {
        nodeIntegration,
        contextIsolation,
        url_or_file,
        width,
        height,
        startHidden = true,
        isMainWindow = false
    } = options;

    const window = new BrowserWindow({
        show: !startHidden,
        width,
        height,
        icon: 'electron-app/img/icon_256.png',
        titleBarStyle: isMainWindow ? 'hidden' : 'default',
        //titleBarStyle: isMainWindow ? 'hiddenInset' : 'default',
        
        /*titleBarOverlay: isMainWindow ? { color: '#000', symbolColor: '#fff' } : undefined,*/
        //titleBarOverlay: isMainWindow && process.platform !== 'darwin' ? true : undefined,
        webPreferences: {
            preload: isMainWindow ? path.join(__dirname, 'electron-app', 'preload.js') : undefined,
            nodeIntegration,
            contextIsolation
        },
        //...(process.platform !== 'darwin' ? { titleBarOverlay: true } : {})
    });

    if (isMainWindow) {
        window.on('close', () => { if (!isQuiting) app.quit(); });
        const version = isDev ? JSON.parse(fs.readFileSync('package.json')).version : app.getVersion();
        window.webContents.executeJavaScript(`document.getElementById('board-version').innerText = "v${version}";`, true);

        // test of loading an extension
        //const walletExtensionPath = path.resolve(__dirname, './wallet-plugin');
        //console.log(walletExtensionPath);
        //await session.defaultSession.loadExtension(walletExtensionPath);
    } else {
        window.on('close', (e) => { if (!isQuiting) { e.preventDefault(); window.hide() } });
    }

    const isUrl = url_or_file.startsWith('http');
    if (isUrl) { window.loadURL(url_or_file); } else { window.loadFile(url_or_file); }

    return window;
}

autoUpdater.on('update-available', (e) => { console.log(`A new update is available: v${e.version}`); });
app.on('before-quit', () => { isQuiting = true; globalShortcut.unregisterAll(); if (dashboardWorker) dashboardWorker.stop(); });
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

    windows.mainWindow = await createWindow(windowsOptions.mainWindow);

    const { NodeAppWorker } = await import('./node/workers/workers-classes.mjs');
    dashboardWorker = new NodeAppWorker(nodeApp, 27260, 27271, 27270, windows.mainWindow);

    if (isDev) windows.mainWindow.webContents.toggleDevTools(); // dev tools on start

    ipcMain.on('set-password', async (event, password) => {
        console.log('setting password...');
        const { channel, data } = await dashboardWorker.setPasswordAndWaitResult(password);
        event.reply(channel, data);
        
        // randomRestartTest(); // -- test restart each 120s to 600s --
        windows.logger = await createWindow(windowsOptions.logger);
        windows.nodeDashboard = await createWindow(windowsOptions.nodeDashboard);
        setShortcuts(windows, isDev);
    });
    ipcMain.on('generate-private-key-and-start-node', () => dashboardWorker.generatePrivateKeyAndStartNode());
    ipcMain.on('set-private-key-and-start-node', (event, privateKey) => dashboardWorker.setPrivateKeyAndStartNode(privateKey));
    ipcMain.on('extract-private-key', async (event, password) => {
        const extracted = await dashboardWorker.extractPrivateKeyAndWaitResult(password);
        event.reply('assistant-message', extracted);
    });
    ipcMain.on('set-auto-launch', async (event, value) => {
        const isEnabled = await myAppAutoLauncher.isEnabled();
        if (value && !isEnabled) await myAppAutoLauncher.enable();
        if (!value && isEnabled) await myAppAutoLauncher.disable();

        const isNowEnabled = await myAppAutoLauncher.isEnabled();
        console.log(`Auto launch changed: ${isEnabled} -> ${isNowEnabled}`);
        event.reply('assistant-message', `Auto launch is now ${isNowEnabled ? 'enabled' : 'disabled'}`);
    });

    ipcMain.on('minimize-btn-click', () => windows.mainWindow.minimize());
    ipcMain.on('maximize-btn-click', () => windows.mainWindow.isMaximized() ? windows.mainWindow.unmaximize() : windows.mainWindow.maximize());
    ipcMain.on('close-btn-click', () => windows.mainWindow.close());
});