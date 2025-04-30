const { ipcRenderer } = require('electron');

class AppSettings {
    /** @type {boolean} Launch at while starting OS */
    autoLaunch;
}

class SettingsManager {
    /** @type {HTMLElement} */
    settingsMenu;
    constructor(settingsMenuElement) {
        this.settingsMenu = settingsMenuElement;
    }
    /** @param {AppSettings} appSettings */
    fillSettingsMenu(appSettings) {
        document.getElementById('launch-at-startup-checkbox').checked = appSettings.autoLaunch;
    }
    clickSettingsButtonHandler(e) {
        if (e.target.id === 'launch-at-startup-checkbox') ipcRenderer.send('set-auto-launch', e.target.checked);
        
        if (e.target.id === 'settings-menu-close-btn') this.settingsMenu.classList.remove('visible');
        if (e.target.id === 'board-settings-button') {
            if (!this.settingsMenu.classList.contains('visible')) this.settingsMenu.classList.add('visible');
            else this.settingsMenu.classList.remove('visible');
        }
    }
}

module.exports = { AppSettings, SettingsManager };