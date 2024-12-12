const { app, BrowserWindow, Menu, globalShortcut, ipcMain, dialog } = require('electron');
const setShortcuts = require('./preferences/shortcuts.js');
const path = require('path');

const isDev = true;
let mainWindow;

global.mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: 'img/icon_128.png',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    global.mainWindow = mainWindow;

    mainWindow.loadFile('index.html');
    mainWindow.webContents.on('did-finish-load', () => { 
        setShortcuts(BrowserWindow, globalShortcut, isDev); 
    });

    // Import and setup chat handlers
    const { setupHandlers } = require('./apps/chat/back-scripts/main.js');
    setupHandlers();

    Menu.setApplicationMenu(null);

    // Handle window closure
    mainWindow.on('closed', () => {
        mainWindow = null;
        global.mainWindow = null;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('will-quit', () => { 
    globalShortcut.unregisterAll(); 
});