if (false) {
    const MiniLogger = require('../miniLogger/mini-logger.js');
    //const miniLoggerConfig = require('../miniLogger/mini-logger-config.js');
    //const miniLogger = new MiniLogger(miniLoggerConfig);
}
const { BrowserWindow } = require('electron');
const { ipcMain, globalShortcut } = require('electron');

const shortcutsKeys = {
    devTools: { key: "F10", enabled: true, devOnly: true },
    reload: { key: "F5", enabled: true, devOnly: true },
    loggerSettings: { key: "F9", enabled: true, devOnly: false }
};
/** @param {MiniLogger} miniLogger @param {BrowserWindow} bw @param {BrowserWindow} loggerWindow */
function setShortcuts(miniLogger, loggerWindow, handlersToRemove = [], dev = true) {
    if (!dev) { for (let key in shortcutsKeys) shortcutsKeys[key].enabled = !shortcutsKeys[key].devOnly; }

    if (shortcutsKeys.devTools.enabled) globalShortcut.register(shortcutsKeys.devTools.key, () => {
        miniLogger.log('shortcuts', `DevTools shortcut pressed (${shortcutsKeys.devTools.key})`);
        if (!BrowserWindow.getFocusedWindow()) return;
        BrowserWindow.getFocusedWindow().webContents.toggleDevTools();
    });
    if (shortcutsKeys.reload.enabled) globalShortcut.register(shortcutsKeys.reload.key, () => {
        miniLogger.log('shortcuts', `Reload shortcut pressed (${shortcutsKeys.reload.key})`);
        if (!BrowserWindow.getFocusedWindow()) return;

        // Should be better if the handlers are removed by the initiator app
        for (let handlerKeys of handlersToRemove) {
            for (const key of handlerKeys) ipcMain.removeHandler(key);
        }
        BrowserWindow.getFocusedWindow().reload();
    });
    if (shortcutsKeys.loggerSettings.enabled) globalShortcut.register(shortcutsKeys.loggerSettings.key, () => {
        miniLogger.log('shortcuts', `Logger settings shortcut pressed (${shortcutsKeys.loggerSettings.key})`);
        const loggerWindowVisible = loggerWindow.isVisible();
        if (!loggerWindowVisible) { loggerWindow.show(); loggerWindow.reload(); } else { loggerWindow.hide(); }
    });

    miniLogger.log('shortcuts', 'Shortcuts set');
};

module.exports = setShortcuts;