const shortcutsKeys = {
    devTools: { key: "F10", enabled: true, devOnly: true },
    reload: { key: "F5", enabled: true, devOnly: true }
};

function setShortcuts(BrowserWindow, globalShortcut, dev = true) {
    if (!dev) { for (let key in shortcutsKeys) shortcutsKeys[key].enabled = !shortcutsKeys[key].devOnly; }

    if (shortcutsKeys.devTools.enabled) globalShortcut.register(shortcutsKeys.devTools.key, () => {
        if (!BrowserWindow.getFocusedWindow()) return;
        BrowserWindow.getFocusedWindow().webContents.toggleDevTools();
    });
    if (shortcutsKeys.reload.enabled) globalShortcut.register(shortcutsKeys.reload.key, () => {
        if (!BrowserWindow.getFocusedWindow()) return;
        BrowserWindow.getFocusedWindow().reload();
    });
};

module.exports = setShortcuts;