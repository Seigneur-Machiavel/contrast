import { BrowserWindow, globalShortcut } from 'electron';


export const shortcutsKeys = {
    devTools: {
        key: "F10",
        enabled: true
    },
    reload: {
        key: "F5",
        enabled: true
    }
}

export default function setShortcuts() {
    if (shortcutsKeys.devTools.enabled) globalShortcut.register(shortcutsKeys.devTools.key, () => {
        BrowserWindow.getFocusedWindow().webContents.toggleDevTools();
    });
    if (shortcutsKeys.reload.enabled) globalShortcut.register(shortcutsKeys.reload.key, () => {
        BrowserWindow.getFocusedWindow().reload();
    });
}