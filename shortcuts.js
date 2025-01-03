const { BrowserWindow } = require('electron');
const { ipcMain, globalShortcut } = require('electron');
const { MiniLogger } = require('./miniLogger/mini-logger.js');
const shortcutsLogger = new MiniLogger('shortcuts');

const shortcutsKeys = {
    reload: { key: "F5", enabled: true, devOnly: true },
    nodeDashboard: { key: "F6", enabled: true, devOnly: false },
    toggleLoggerSettingsMenu: { key: "F9", enabled: true, devOnly: false },
    toggleDevTools: { key: "F10", enabled: true, devOnly: true },
};
/** @param {Object<string, BrowserWindow>} windows @param {BrowserWindow} nodeDashboardWindow */
function setShortcuts(windows, handlersToRemove = [], dev = true) {
    if (!dev) { for (let key in shortcutsKeys) shortcutsKeys[key].enabled = !shortcutsKeys[key].devOnly; }

    // TOGGLE DEVTOOLS
    if (shortcutsKeys.toggleDevTools.enabled) globalShortcut.register(shortcutsKeys.toggleDevTools.key, () => {
        shortcutsLogger.log(`DevTools shortcut pressed (${shortcutsKeys.toggleDevTools.key})`, (m) => { console.log(m); });
        if (!BrowserWindow.getFocusedWindow()) return;
        BrowserWindow.getFocusedWindow().webContents.toggleDevTools();
    });
    // TOOGLE NODE DASHBOARD
    if (shortcutsKeys.nodeDashboard.enabled) globalShortcut.register(shortcutsKeys.nodeDashboard.key, () => {
        shortcutsLogger.log(`Node dashboard shortcut pressed (${shortcutsKeys.nodeDashboard.key})`, (m) => { console.log(m); });
        const nodeDashboardWindowVisible = windows.nodeDashboard.isVisible();
        if (!nodeDashboardWindowVisible) { windows.nodeDashboard.show(); windows.nodeDashboard.reload(); } else { windows.nodeDashboard.hide(); }
    });
    // RELOAD
    if (shortcutsKeys.reload.enabled) globalShortcut.register(shortcutsKeys.reload.key, () => {
        shortcutsLogger.log(`Reload shortcut pressed (${shortcutsKeys.reload.key})`, (m) => { console.log(m); });
        if (!BrowserWindow.getFocusedWindow()) return;

        // Should be better if the handlers are removed by the initiator app
        for (let handlerKeys of handlersToRemove) {
            for (const key of handlerKeys) ipcMain.removeHandler(key);
        }
        BrowserWindow.getFocusedWindow().reload();
    });
    // TOGGLE LOGGER SETTINGS MENU
    if (shortcutsKeys.toggleLoggerSettingsMenu.enabled) globalShortcut.register(shortcutsKeys.toggleLoggerSettingsMenu.key, () => {
        shortcutsLogger.log(`Logger settings shortcut pressed (${shortcutsKeys.toggleLoggerSettingsMenu.key})`, (m) => { console.log(m); });
        const loggerWindowVisible = windows.logger.isVisible();
        if (!loggerWindowVisible) { windows.logger.show(); windows.logger.reload(); } else { windows.logger.hide(); }
    });

    shortcutsLogger.log('Shortcuts set', (m) => { console.log(m); });
};

module.exports = setShortcuts;