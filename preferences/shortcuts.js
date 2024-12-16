if (false) {
    const { BrowserWindow } = require('electron');
}
const { ipcMain, globalShortcut } = require('electron');

const shortcutsKeys = {
    devTools: { key: "F10", enabled: true, devOnly: true },
    reload: { key: "F5", enabled: true, devOnly: true }
};
/** @param {BrowserWindow} bw */
function setShortcuts(bw, handlersToRemove = [], dev = true) {
    if (!dev) { for (let key in shortcutsKeys) shortcutsKeys[key].enabled = !shortcutsKeys[key].devOnly; }

    if (shortcutsKeys.devTools.enabled) globalShortcut.register(shortcutsKeys.devTools.key, () => {
        if (!bw.getFocusedWindow()) return;
        bw.getFocusedWindow().webContents.toggleDevTools();
    });
    if (shortcutsKeys.reload.enabled) globalShortcut.register(shortcutsKeys.reload.key, () => {
        if (!bw.getFocusedWindow()) return;

        // Should be better if the handlers are removed by the initiator app
        for (let handlerKeys of handlersToRemove) {
            for (const key of handlerKeys) ipcMain.removeHandler(key);
        }
        bw.getFocusedWindow().reload();
    });
};

module.exports = setShortcuts;