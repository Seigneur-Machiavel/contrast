if (false) { const { NodeAppWorker } = require('./node/workers/workers-classes.mjs'); } // For better completion
process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, globalShortcut, dialog, ipcMain, ipcRenderer } = require('electron');
const { AppSettings } = require('./electron-app/index/settings-manager.js');
Menu.setApplicationMenu(null); // remove the window top menu
const isDev = !app.isPackaged;

/**
 * @typedef {import('electron-updater').UpdateCheckResult} UpdateCheckResult
 * @typedef {import('./utils/storage-manager.mjs').Storage} Storage
 * @typedef {import('./miniLogger/mini-logger-reader.mjs').MiniLoggerReader} MiniLoggerReader
 * 
 * @typedef {Object} WindowOptions
 * @property {boolean} nodeIntegration
 * @property {boolean} contextIsolation
 * @property {string} url_or_file
 * @property {number} width
 * @property {number} height
 * @property {number} [minWidth]
 * @property {number} [minHeight]
 * @property {number} [x]
 * @property {number} [y]
 * @property {boolean} [fullScreen] - default false
 * @property {boolean} [maximized] - default false
 * @property {boolean} [startHidden] - default true
 * @property {boolean} [isMainWindow] - default false */

/** @type {Storage} */
let mainStorage;
/** @type {MiniLoggerReader} */
let miniLoggerReader;
(async () => {
    mainStorage = (await import('./utils/storage-manager.mjs')).Storage;
    miniLoggerReader = (await import('./miniLogger/mini-logger-reader.mjs')).MiniLoggerReader;
})();

const { autoUpdater } = require('electron-updater');
const setShortcuts = require('./electron-app/shortcuts.js');
const { MiniLogger } = require('./miniLogger/mini-logger.js');
const AutoLaunch = require('auto-launch');

/*const log = require('electron-log');
log.transports.file.level = 'info';
log.info('--- Test log ---');
autoUpdater.logger = log;*/

// GLOBAL VARIABLES
let userPreferences = {};
const version = isDev ? JSON.parse(fs.readFileSync('package.json')).version : app.getVersion();
const mainLogger = new MiniLogger('main');
const myAppAutoLauncher = new AutoLaunch({ name: 'Contrast' });
let isQuiting = false;
/** @type {UpdateCheckResult | null} */
let updateCheckResult = null;
let silentUpdate = true;
/** @type {Object<string, BrowserWindow>} */
const windows = {};
const windowsOptions = {
    logger: { 
        nodeIntegration: true, contextIsolation: false, url_or_file: './miniLogger/miniLoggerSetting.html',
        width: 300, height: 500
    },
    boardWindow: {
        nodeIntegration: true, contextIsolation: false, url_or_file: './electron-app/index/board.html',
        width: 1366, height: 800, startHidden: false, isMainWindow: true,
        //preload: path.join(__dirname, 'electron-app', 'index', 'modulesLoader.mjs')
    }
};
async function loadUserPreferences() {
    while (!mainStorage) await new Promise(resolve => setTimeout(resolve, 10)); // wait for storage to be loaded
    const loaded = mainStorage.loadJSON('main-user-preferences', 'darkModeState');
    if (!loaded) return;

    userPreferences = loaded;
    if (userPreferences.boardWindowWidth) windowsOptions.boardWindow.width = userPreferences.boardWindowWidth;
    if (userPreferences.boardWindowHeight) windowsOptions.boardWindow.height = userPreferences.boardWindowHeight;
    if (userPreferences.boardWindowPositionX) windowsOptions.boardWindow.x = userPreferences.boardWindowPositionX;
    if (userPreferences.boardWindowPositionY) windowsOptions.boardWindow.y = userPreferences.boardWindowPositionY;
    if (userPreferences.boardWindowFullScreen) windowsOptions.boardWindow.fullScreen = userPreferences.boardWindowFullScreen;
    if (userPreferences.boardWindowMaximized) windowsOptions.boardWindow.maximized = userPreferences.boardWindowMaximized;

    console.log('User preferences loaded:', userPreferences);
}
let saveUserPreferencesTimeout = null;
function saveUserPreferencesAfterTimeout() {
    if (saveUserPreferencesTimeout) clearTimeout(saveUserPreferencesTimeout);
    saveUserPreferencesTimeout = setTimeout(() => {
        const [parentX, parentY] = windows.boardWindow.getPosition();
        const [width, height] = windows.boardWindow.getSize();
        userPreferences.boardWindowFullScreen = windows.boardWindow.isFullScreen();
        userPreferences.boardWindowMaximized = windows.boardWindow.isMaximized();
        userPreferences.boardWindowPositionX = parentX;
        userPreferences.boardWindowPositionY = parentY;
        userPreferences.boardWindowWidth = width;
        userPreferences.boardWindowHeight = height;

        mainStorage.saveJSON('main-user-preferences', userPreferences);
        console.log('User preferences saved:', userPreferences);
    }, 1000);
}

/** @type {NodeAppWorker} */
let nodeAppWorker;

async function randomRestartTest() { // DEV FUNCTION
    await new Promise(resolve => setTimeout(resolve, 5000)); // wait for the dashboard to start
    while(isDev) { // -- test restart after 120s to 600s --
        const restartTime = Math.floor(Math.random() * 480000) + 120000;
        mainLogger.log(`--- Restarting node worker in ${(restartTime / 1000).toFixed(2)}s ---`, (m) => { console.log(m); });
        await new Promise(resolve => setTimeout(resolve, restartTime));
        nodeAppWorker.restart();
    }
}

/** @param {WindowOptions} options */
async function createWindow(options, parentWindow) {
    const {
        nodeIntegration = false, contextIsolation = true, url_or_file,
        width, height, minWidth, minHeight, x, y, fullScreen, maximized,
        startHidden = true, isMainWindow = false, preload
    } = options;

    const window = new BrowserWindow({
        webSecurity: true,
        additionalArguments: [`--csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';"`],
        show: !startHidden,
        parent: parentWindow,
        width, height, minWidth, minHeight, x, y, fullScreen,
        icon: 'electron-app/img/icon_256.png',
        titleBarStyle: isMainWindow ? 'hidden' : 'default',
        webPreferences: { preload, nodeIntegration, contextIsolation }
    });

    if (maximized) window.maximize();
    if (isMainWindow) window.on('close', () => { if (!isQuiting) app.quit(); });
    else window.on('close', (e) => { if (!isQuiting) { e.preventDefault(); window.hide() } });

    if (url_or_file.startsWith('http')) { window.loadURL(url_or_file); } else { window.loadFile(url_or_file); }

    setTimeout(() => window.webContents.send('app-version', `v${version}`), 2000);

    return window;
}

// AUTO UPDATER EVENTS
autoUpdater.on('update-available', (e) => {
    console.log(`A new update is available: v${e.version}`);
    /// board assitan msg
    //ipcRenderer.send('assistant-message', `A new update is available: v${e.version}`);
})
autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) => {
    //ipcRenderer.send('assistant-message', `Update downloaded and ready to be installed: v${releaseName}`);
    if (silentUpdate && isDev) { console.log('downloaded'); return; } // avoid restart/install in dev mode
    if (silentUpdate) { autoUpdater.quitAndInstall(true, true); return; }

    const dialogOpts = {
        type: 'info',
        buttons: ['Restart', 'Later'],
        title: 'Updating application',
        message: process.platform === 'win32' ? releaseNotes : releaseName,
        detail: 'A new version has been downloaded. Restart the application to apply the updates now?'
    };

    dialog.showMessageBox(dialogOpts).then((returnValue) => {
        if (isDev) { console.log('downloaded'); return; } // avoid restart/install in dev mode
        if (returnValue.response === 0) autoUpdater.quitAndInstall(false, false);
    });
});
const autoUpdaterCheckLoop = async () => {
    while (true) {
        autoUpdater.checkForUpdatesAndNotify(); //! await this one: crash the program!

        // avoid all peers updating at the same time by using a rnd delay
        const delay = Math.floor(Math.random() * 900_000) + 300_000; // 300s to 1200s (5min to 20min)
        console.log(`Next update check in ${(delay / 1000).toFixed(2)}s`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
};

// IPC EVENTS
ipcMain.on('minimize-btn-click', () => windows.boardWindow.minimize());
ipcMain.on('maximize-btn-click', () => windows.boardWindow.isMaximized() ? windows.boardWindow.unmaximize() : windows.boardWindow.maximize());
//ipcMain.on('close-btn-click', () => windows.boardWindow.close());
ipcMain.on('close-btn-click', () => app.quit());
ipcMain.on('set-password', async (event, password) => {
    console.log('setting password...');
    const { channel, data } = await nodeAppWorker.setPasswordAndWaitResult(password);
    event.reply(channel, data);
});
ipcMain.on('node-started', async (event) => {
    if (windows.logger) return;
    windows.logger = await createWindow(windowsOptions.logger);
    setShortcuts(windows, isDev);

    // randomRestartTest(); // -- test restart each 120s to 600s --
});
ipcMain.on('remove-password', async (event, password) => {
    console.log('removing password...');
    const { channel, data } = await nodeAppWorker.removePasswordAndWaitResult(password);
    event.reply(channel, data);
});
ipcMain.on('generate-private-key-and-start-node', () => nodeAppWorker.generatePrivateKeyAndStartNode());
ipcMain.on('set-private-key-and-start-node', (event, privateKey) => {
    nodeAppWorker.setPrivateKeyAndStartNode(privateKey)
});
ipcMain.on('extract-private-key', async (event, password) => {
    const extractedHex = await nodeAppWorker.extractPrivateKeyAndWaitResult(password === '' ? 'fingerPrint' : password);
    if (!extractedHex) return event.reply('assistant-message', 'Password is incorrect, try again!');

    event.reply('assistant-message', 'Your private key will be show in 5s, do not reveal it to anyone!');
    
    //setTimeout(() => event.reply('assistant-message', extractedHex), 5000);
    setTimeout(() => event.reply('assistant-private-key', extractedHex), 5000);
});
ipcMain.on('set-auto-launch', async (event, value) => {
    const isEnabled = await myAppAutoLauncher.isEnabled();
    if (value && !isEnabled) await myAppAutoLauncher.enable();
    if (!value && isEnabled) await myAppAutoLauncher.disable();

    const isNowEnabled = await myAppAutoLauncher.isEnabled();
    console.log(`Auto launch changed: ${isEnabled} -> ${isNowEnabled}`);
    event.reply('assistant-message', `Auto launch is now ${isNowEnabled ? 'enabled' : 'disabled'}`);
});
ipcMain.on('get-app-settings', async (event) => {
    const appSettings = new AppSettings();
    appSettings.autoLaunch = await myAppAutoLauncher.isEnabled();

    event.reply('app-settings', appSettings);
});
ipcMain.on('reset-private-key', async (event) => {
    if (nodeAppWorker) await nodeAppWorker.stop();
    await new Promise(resolve => setTimeout(resolve, 7000)); // wait for the node to stop properly
    mainStorage.deleteFile('passHash.bin');
    mainStorage.deleteFile('nodeSetting.bin');
    if (!app.isPackaged) return;
    app.relaunch();
    app.quit();
});
ipcMain.on('reset-all-data', async (event) => {
    if (nodeAppWorker) await nodeAppWorker.stop();
    await new Promise(resolve => setTimeout(resolve, 7000)); // wait for the node to stop properly
    await import('./clear.mjs');
    if (!app.isPackaged) return;
    app.relaunch();
    app.quit();
});
ipcMain.on('generate-new-address', async (event, prefix) => {
    const newAddress = await nodeAppWorker.generateNewAddressAndWaitResult(prefix);
    event.reply('new-address-generated', newAddress);
});
ipcMain.on('store-app-data', async (event, appName, filename, data, secure = true) => {
    if (!mainStorage) await new Promise(resolve => setTimeout(resolve, 10)); // wait for storage to be loaded
    if (typeof appName !== 'string') return event.reply('error', 'Invalid appName');
    if (typeof filename !== 'string') return event.reply('error', 'Invalid filename');
    if (!data) return event.reply('error', 'Invalid data');
    if (typeof secure !== 'boolean') return event.reply('error', 'Invalid secure type, must be a boolean');

    if (!secure) {
        mainStorage.saveJSON(`${appName}/${filename}`, data);
        event.reply('app-data-stored', appName, filename, data);
        return;
    }
    
    try {
        const cypherTextData = await nodeAppWorker.cypherTextAndWaitResult(data);
        mainStorage.saveJSON(`${appName}/${filename}`, cypherTextData);
        event.reply('app-data-stored', appName, filename, cypherTextData);
    } catch (error) { event.reply('error', 'Error while storing app data:', error); }
});
ipcMain.on('delete-app-data', async (event, appName, filename) => {
    if (!mainStorage) await new Promise(resolve => setTimeout(resolve, 10)); // wait for storage to be loaded
    if (typeof appName !== 'string') return event.reply('error', 'Invalid appName');
    if (typeof filename !== 'string') return event.reply('error', 'Invalid filename');

    mainStorage.deleteFile(`${appName}/${filename}`);
    event.reply('app-data-deleted', appName, filename);
});
ipcMain.on('get-logs-historical', async (event, category = 'all') => {
    const historicals = miniLoggerReader.getAllHistoricals(category);
    const lines = miniLoggerReader.mergeHistoricals(historicals);
    const str = lines.join('\n');
    event.reply('copy-clipboard', str);
    event.reply('assistant-message', `Logs copied to clipboard`);
});

// APP EVENTS
app.on('before-quit', () => {
    try {
        isQuiting = true;
        if (nodeAppWorker) nodeAppWorker.stop();
        globalShortcut.unregisterAll();
    } catch (error) { console.error('Error during app quit:', error); }
});
app.on('will-quit', async () => await new Promise(resolve => setTimeout(resolve, 3000))); // let time for the node to stop properly
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); }); // quit when all windows are closed
app.on('ready', async () => {
    if (!isDev) autoUpdaterCheckLoop();
    //if (!isDev) autoUpdater.checkForUpdatesAndNotify(); //! await this one: crash the program!
    await loadUserPreferences();

    windows.boardWindow = await createWindow(windowsOptions.boardWindow);
    if (isDev) windows.boardWindow.webContents.toggleDevTools(); // dev tools on start

    windows.boardWindow.on('move', () => saveUserPreferencesAfterTimeout());
    windows.boardWindow.on('resize', () => saveUserPreferencesAfterTimeout());
    windows.boardWindow.on('enter-full-screen', () => saveUserPreferencesAfterTimeout());
    windows.boardWindow.on('leave-full-screen', () => saveUserPreferencesAfterTimeout());

    const { NodeAppWorker } = await import('./node/workers/workers-classes.mjs');
    const appName = 'unified'; // dashboard, stresstest, unified
    nodeAppWorker = new NodeAppWorker(appName, 27260, 27271, 27270, windows.boardWindow);
});