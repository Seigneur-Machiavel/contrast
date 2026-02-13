/**
 * @typedef {Object} AppConfig
 * @property {string} [preload] - default false
 * @property {boolean} disableOnLock - default true
 * @property {boolean} [autoSized] - default false
 * @property {number} [minWidth]
 * @property {number} [minHeight]
 * @property {number} [initWidth]
 * @property {number} [initHeight]
 * @property {number} [initTop]
 * @property {number} [initLeft]
 * @property {string} [iconSrc] - default '../../apps/{appName}/img/icon_128.png'
 * @property {string} [iconWidth] - default '50%'
 * @property {string} title
 * @property {string} url_or_file
 * @property {string} [mainClass]
 * @property {boolean} [setGlobal] - Set the app as global (window)
 * @property {boolean} [fullScreen] - default false
 * @property {boolean} canFullScreen - default true
 * @property {boolean} [setFront] - default false
 */

/** @param {string} appName @param {AppConfig} appConfig */
export const AppConfig = (appName, appConfig) => { // TYPE DEFINITION
	return {
		preload: appConfig.preload || false,
		disableOnLock: appConfig.disableOnLock === false ? false : true,
		autoSized: appConfig.autoSized || false,
		minWidth: appConfig.minWidth || undefined,
		minHeight: appConfig.minHeight || undefined,
		initWidth: appConfig.initWidth || undefined,
		initHeight: appConfig.initHeight || undefined,
		initTop: appConfig.initTop || undefined,
		initLeft: appConfig.initLeft || undefined,
		iconSrc: appConfig.iconSrc || `./${appName}/img/icon_128.png`,
		iconWidth: appConfig.iconWidth || '50%',
		title: appConfig.title || 'App_Title',
		tooltip: appConfig.tooltip || appConfig.title || 'App_Title',
		url_or_file: appConfig.url_or_file,
		mainClass: appConfig.mainClass || undefined,
		setGlobal: appConfig.setGlobal || false,
		fullScreen: appConfig.fullScreen || false,
		canFullScreen: appConfig.canFullScreen === false ? false : true,
		setFront: appConfig.setFront || false
	}
}
export const appsConfig = {
	assistant: {
		preload: false,
		setFront: false,
		fullScreen: false,
		disableOnLock: false,
		minWidth: 500,
		minHeight: 300,
		initWidth: 700,
		iconWidth: '60%',
		title: '<span class="title-deco">❖</span>ASSISTANT<span class="title-deco">` ` \\_</span>',
		tooltip: 'Mr Cold Coffee',
		url_or_file: './assistant/assistant.html',
	},
	explorer: {
		preload: true,
		fullScreen: false,
		disableOnLock: false,
		minWidth: 600,
		minHeight: 190,
		initWidth: 800,
		initHeight: 610,
		//initTop: 0,
		//initLeft: 430,
		iconWidth: '69%',
		title: '<span class="title-deco">°`°</span>BLOCKCHAIN EXPLORER<span class="title-deco">- }== -</span>',
		tooltip: 'Blockchain Explorer',
		//content: '<iframe src="http://localhost:27270" style="width: 100%; height: 100%; border: none;"></iframe>'
		//url_or_file: 'http://localhost:27270',
		url_or_file: './explorer/explorer.html',
	},
	wallet: {
		preload: true,
		disableOnLock: false,
		autoSized: true,
		canFullScreen: false,
		initTop: 56,
		initLeft: 100,
		title: '<span class="title-deco">- )( -</span>WALLET<span class="title-deco">___\\</span>',
		tooltip: 'Wallet',
		url_or_file: './wallet/wallet.html',
	},
	dashboard: {
		preload: false,
		disableOnLock: false,
		minWidth: 420,
		minHeight: 300,
		initHeight: 600,
		initTop: 0,
		iconWidth: '69%',
		title: '<span class="title-deco">~~</span>DASHBOARD<span class="title-deco">___\\</span>',
		tooltip: 'Node Dashboard',
		//content: '<iframe src="http://localhost:27271" style="width: 100%; height: 100%; border: none;"></iframe>'
		//url_or_file: 'http://localhost:27271',
		url_or_file: './dashboard/dashboard.html',
	},
	/*chat: {
		preload: false,
		minWidth: 300,
		minHeight: 300,
		title: 'CHAT',
		url_or_file: '../../apps/chat/chat-content.html',
		mainClass: 'ChatUI',
		setGlobal: true
	},*/
	/*vault: {
		preload: true,
		minWidth: 600,
		minHeight: 600,
		iconWidth: '68%',
		title: 'VAULT',
		url_or_file: '../../apps/vault/vault-content.html',
	},*/
	/*cybercon: {
		preload: false,
		minWidth: 400,
		//minHeight: 300 + 32,
		//initWidth: 600,
		//initHeight: 450 + 32,
		initWidth: 800,
		initHeight: 600 + 32,
		canFullScreen: true,
		iconWidth: '30%',
		title: '#_| CYBERCON |_# --- -- --- EXPERIMENTAL',
		tooltip: 'Cybercon (experimental)',
		//url_or_file: 'http://localhost:27280',
		url_or_file: 'http://pinkparrot.science:27280/',
	}*/
};

export function buildAppsConfig(appsConf) {
	/** @type {Object<string, AppConfig>} */
	const result = {};
	for (const appName in appsConf) { result[appName] = AppConfig(appName, appsConf[appName]); }
	return result;
}