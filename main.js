if (false) { const { NodeAppWorker } = require('./node/workers/workers-classes.mjs'); } // For better completion

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, globalShortcut, dialog, ipcMain } = require('electron');
Menu.setApplicationMenu(null); // remove the window top menu
const isDev = !app.isPackaged;

/**
 * @typedef {import('./utils/storage-manager.mjs').Storage} Storage
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
(async () => {
    const { Storage } = await import('./utils/storage-manager.mjs');
    mainStorage = Storage;
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
const nodeApp = isDev ? 'stresstest' : 'dashboard';
let isQuiting = false;
let updateCheckResult;
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
let dashboardWorker;

async function randomRestartTest() { // DEV FUNCTION
    await new Promise(resolve => setTimeout(resolve, 5000)); // wait for the dashboard to start
    while(isDev) { // -- test restart after 120s to 600s --
        const restartTime = Math.floor(Math.random() * 480000) + 120000;
        mainLogger.log(`--- Restarting node worker in ${(restartTime / 1000).toFixed(2)}s ---`, (m) => { console.log(m); });
        await new Promise(resolve => setTimeout(resolve, restartTime));
        dashboardWorker.restart();
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
autoUpdater.on('update-available', (e) => console.log(`A new update is available: v${e.version}`));
autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) => {
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
autoUpdaterCheckLoop = async () => {
    let downloadingVersion;
    while (!downloadingVersion && downloadingVersion !== version) {
        //autoUpdater.forceDevUpdateConfig = true; autoUpdater.currentVersion = '0.2.1'; // Dev update test
        updateCheckResult = await autoUpdater.checkForUpdatesAndNotify();
        downloadingVersion = updateCheckResult?.updateInfo?.version;

        const delay = Math.floor(Math.random() * 60_000) + 240_000; // rnd delay beetwen 4 and 5 minutes
        await new Promise(resolve => setTimeout(resolve, delay)); // avoid all peers updating at the same time
    }
    console.log(`Update check loop stopped, downloading version: ${downloadingVersion}`);
};

// IPC EVENTS
ipcMain.on('minimize-btn-click', () => windows.boardWindow.minimize());
ipcMain.on('maximize-btn-click', () => windows.boardWindow.isMaximized() ? windows.boardWindow.unmaximize() : windows.boardWindow.maximize());
ipcMain.on('close-btn-click', () => windows.boardWindow.close());
ipcMain.on('set-password', async (event, password) => {
    console.log('setting password...');
    const { channel, data } = await dashboardWorker.setPasswordAndWaitResult(password);
    event.reply(channel, data);
    
    // randomRestartTest(); // -- test restart each 120s to 600s --
    windows.logger = await createWindow(windowsOptions.logger);
    setShortcuts(windows, isDev);
});
ipcMain.on('generate-private-key-and-start-node', () => dashboardWorker.generatePrivateKeyAndStartNode());
ipcMain.on('set-private-key-and-start-node', (event, privateKey) => dashboardWorker.setPrivateKeyAndStartNode(privateKey));
ipcMain.on('extract-private-key', async (event, password) => {
    const extractedHex = await dashboardWorker.extractPrivateKeyAndWaitResult(password === '' ? 'fingerPrint' : password);
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
ipcMain.on('generate-new-address', async (event, prefix) => {
    const newAddress = await dashboardWorker.generateNewAddressAndWaitResult(prefix);
    event.reply('new-address-generated', newAddress);
});

// APP EVENTS
app.on('before-quit', () => {
    isQuiting = true;
    globalShortcut.unregisterAll();
    if (dashboardWorker) dashboardWorker.stop();
});
app.on('will-quit', async () => await new Promise(resolve => setTimeout(resolve, 10000))); // let time for the node to stop properly
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); }); // quit when all windows are closed
app.on('ready', async () => {
    if (!isDev) autoUpdaterCheckLoop();
    await loadUserPreferences();

    windows.boardWindow = await createWindow(windowsOptions.boardWindow);
    if (isDev) windows.boardWindow.webContents.toggleDevTools(); // dev tools on start

    windows.boardWindow.on('move', () => saveUserPreferencesAfterTimeout());
    windows.boardWindow.on('resize', () => saveUserPreferencesAfterTimeout());
    windows.boardWindow.on('enter-full-screen', () => saveUserPreferencesAfterTimeout());
    windows.boardWindow.on('leave-full-screen', () => saveUserPreferencesAfterTimeout());

    const { NodeAppWorker } = await import('./node/workers/workers-classes.mjs');
    dashboardWorker = new NodeAppWorker(nodeApp, 27260, 27271, 27270, windows.boardWindow);

    /*let checkForUpdates = !isDev;
    while(checkForUpdates) { // check for updates every 5 minutes
        await new Promise(resolve => setTimeout(resolve, 300000));
        const updateCheckResult = await autoUpdater.checkForUpdatesAndNotify();
        updateCheckResult.
    }*/
});