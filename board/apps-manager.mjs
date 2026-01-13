import { AppConfig, appsConfig, buildAppsConfig } from './apps-config.js';
import { ButtonsBar, SubWindow } from './apps-initializer.mjs';

export class AppsManager {
	/** @type {Object<string, SubWindow>} */	windows = {};
	/** @type {SubWindow} */					draggingWindow = null;
	/** @type {SubWindow} */					resizingWindow = null;

	state = 'locked';
	appsConfig = buildAppsConfig(appsConfig);
	windowsWrap;
	buttonsBar;
	tempFrontAppName = null;
	transitionsDuration = 400;
	appsByZindex 

	/** @param {HTMLElement} windowsWrap, @param {HTMLElement} buttonsBarElement */
	constructor(windowsWrap, buttonsBarElement) {
		this.windowsWrap = windowsWrap;
		this.buttonsBar = new ButtonsBar(buttonsBarElement);
		for (const app in this.appsConfig) {
			this.buttonsBar.addButton(app, this.appsConfig[app], this.appsConfig[app].disableOnLock);
			if (this.appsConfig[app].preload) this.loadApp(app);
		}
	}

	updateCssAnimationsDuration() {
		document.documentElement.style.setProperty('--windows-animation-duration', this.transitionsDuration + 'ms');
	}
	/** @param {string} appName, @param {boolean} [startHidden] Default: false */
	loadApp(appName, startHidden = false) {
		if (!this.appsConfig[appName]) return;

		const origin = this.buttonsBar.getButtonOrigin(appName);
		const { title, url_or_file } = this.appsConfig[appName];
		this.windows[appName] = new SubWindow(appName, title, url_or_file);

		const {
			minWidth, minHeight, maxWidth, maxHeight, initWidth, initHeight,
			initTop, initLeft, canFullScreen, autoSized
		} = this.appsConfig[appName];

		this.windows[appName].autoSized = autoSized;
		this.windows[appName].canFullScreen = canFullScreen;
		this.windows[appName].minSize.width = minWidth;
		this.windows[appName].minSize.height = minHeight;
		this.windows[appName].initSize.width = initWidth;
		this.windows[appName].initSize.height = initHeight;
		this.windows[appName].position.top = initTop || 0;
		this.windows[appName].position.left = initLeft || 0;

		this.windows[appName].render(this.windowsWrap, origin.x, origin.y);
		if (this.appsConfig[appName].setGlobal) window[appName] = this.windows[appName];

		const { fullScreen, setFront } = this.appsConfig[appName];
		if (fullScreen || setFront) {
			setTimeout(() => {
				if (fullScreen) this.windows[appName].setFullScreen(this.#boardSize, 0);
				if (!setFront || startHidden) return;
				this.windows[appName].toggleFold(origin.x, origin.y, 600);
				this.setFrontWindow(appName);
			}, 400);
		}
	}
	/** load app window and create button if not already created
	 * @param {string} appName - name of the app to load
	 * @param {boolean} [startHidden] - if true, the app will be loaded but not shown (folded) -default: false */
	toggleAppWindow(appName, startHidden = false) {
		if (!this.appsConfig[appName]) return;
		if (!this.windows[appName]) this.loadApp(appName, startHidden);
		if (startHidden) return;
		
		const isFront = this.windows[appName].element.classList.contains('front');
		const unfoldButNotFront = isFront === false && this.windows[appName].folded === false;
		let appToFocus = appName;
		
		if (!unfoldButNotFront) {  // -> don't toggle after setting front
			const origin = this.buttonsBar.getButtonOrigin(appName);
			const folded = this.windows[appName].toggleFold(origin.x, origin.y, this.transitionsDuration);
			const firstUnfolded = Object.values(this.windows).find(w => w.folded === false);
			if (folded && firstUnfolded) appToFocus = firstUnfolded.appName;
		}

		console.log('appToFocus', appToFocus);
		const delay = appToFocus === appName ? 0 : this.transitionsDuration;
		setTimeout(() => { this.setFrontWindow(appToFocus); }, delay);
	}
	/** @param {string} appName */
	setFrontWindow(appName) {
		if (!this.windows[appName]) return;
		if (!this.windows[appName].element) return;
		if (this.windows[appName].element.classList.contains('front')) return;

		for (const app in this.windows) {
			this.windows[app].element.classList.remove('front');
			this.buttonsBar.buttonsByAppNames[app].classList.remove('front');
		}

		this.windows[appName].element.classList.add('front');
		this.buttonsBar.buttonsByAppNames[appName].classList.add('front');
	}
	lock() {
		this.state = 'locked';
		for (const app in this.appsConfig)
			if (this.appsConfig[app].disableOnLock === false) continue;
			else this.buttonsBar.buttonsByAppNames[app].classList.add('disabled');
	}
	unlock() {
		this.state = 'unlocked';
		for (const app in this.appsConfig)
			this.buttonsBar.buttonsByAppNames[app].classList.remove('disabled');
	}

	// HANDLERS
	clickHandler(e) {
		this.#clickAppButtonsHandler(e);
		this.#clickWindowHandler(e);
	}
	#clickAppButtonsHandler(e) {
		const button = e.target.closest('.app-button');
		if (!button) return;

		const appName = button.dataset.appName;
		const app = this.windows[appName];
		if (!app) {
			if (!this.appsConfig[appName]) { console.error('App not found:', appName); return; }
			this.loadApp(appName);
		}

		this.toggleAppWindow(appName);
	}
	overAppButtonsHandler(e) {
		const button = e.target.closest('.app-button');
		if (!button && this.tempFrontAppName) {
			for (const win in this.windows) this.windows[win].element.classList.remove('temp-front');
			this.tempFrontAppName = null;
		}
		if (!button) return;

		const app = this.windows[button.dataset.appName];
		if (!app) return;

		for (const win in this.windows) {
			if (win === app.appName) { app.element.classList.add('temp-front');
			} else { this.windows[win].element.classList.remove('temp-front'); }
		}
		this.tempFrontAppName = app.appName;
	}
	#clickWindowHandler(e) {
		switch(e.target.dataset.action) {
			case 'refresh':
				this.windows[e.target.dataset.appName].refreshIframeSrc();
				this.windows[e.target.dataset.appName].setDarkModeAccordingToBoard();
				return;
			case 'fold':
				this.toggleAppWindow(e.target.dataset.appName);
				return;
			case 'expand':
				this.windows[e.target.dataset.appName].setFullScreen(this.#boardSize, this.transitionsDuration);
				return;
			case 'detach':
				this.windows[e.target.dataset.appName].unsetFullScreen(this.transitionsDuration);
				return;
		}

		// if click in a window (anywhere), bring it to front
		// trough parents of the clicked element until find the window
		const { appName } = this.#getElementParentWindow(e.target);
		if (appName) this.setFrontWindow(appName);
	}
	dlbClickTitleBarHandler(e) {
		if (!e.target.classList.contains('title-bar')) return;

		const { subWindow } = this.#getElementParentWindow(e.target);
		if (subWindow.isFullScreen) subWindow.unsetFullScreen(this.transitionsDuration);
		else subWindow.setFullScreen(this.#boardSize, this.transitionsDuration);
	}
	grabWindowHandler(e) {
		const { appName, subWindow } = this.#getElementParentWindow(e.target);
		if (!appName || !subWindow || subWindow.isFullScreen) return;

		this.setFrontWindow(appName);
		if (e.target.classList.contains('title-bar')) {
			e.preventDefault();
			this.draggingWindow = subWindow;
			subWindow.dragStart.x = e.clientX - subWindow.element.offsetLeft;
			subWindow.dragStart.y = e.clientY - subWindow.element.offsetTop;
			subWindow.element.classList.add('dragging');
		}

		if (e.target.classList.contains('resize-button')) {
			e.preventDefault();
			this.resizingWindow = subWindow;
			subWindow.resizeStart.x = e.clientX;
			subWindow.resizeStart.y = e.clientY;
			subWindow.resizeStart.width = subWindow.element.offsetWidth;
			subWindow.resizeStart.height = subWindow.element.offsetHeight;
			subWindow.element.classList.add('resizing');
		}
	}
	moveWindowHandler(e) {
		if (!this.draggingWindow) return;
		
		e.preventDefault();
		const maxLeft = this.windowsWrap.offsetWidth - 50;
		const minTop = this.windowsWrap.offsetHeight - 32;
		const left = Math.max(0, e.clientX - this.draggingWindow.dragStart.x);
		const top = Math.max(0, e.clientY - this.draggingWindow.dragStart.y);
		this.draggingWindow.element.style.left = Math.min(left, maxLeft) + 'px';
		this.draggingWindow.element.style.top = Math.min(top, minTop) + 'px';
	}
	moveResizeHandler(e) {
		if (!this.resizingWindow) return;

		e.preventDefault();
		const minWidth = this.resizingWindow.minSize.width || 100;
		const minHeight = this.resizingWindow.minSize.height || 100;
		const { width, height } = this.windowsWrap.getBoundingClientRect();
		const cursorHorizontalDiff = e.clientX - this.resizingWindow.resizeStart.x;
		const cursorVerticalDiff = e.clientY - this.resizingWindow.resizeStart.y;
		const newWidth = Math.min(width, Math.max(minWidth, this.resizingWindow.resizeStart.width + cursorHorizontalDiff));
		const newHeight = Math.min(height, Math.max(minHeight, this.resizingWindow.resizeStart.height + cursorVerticalDiff));
		// +12 px to improve tracking
		this.resizingWindow.element.style.width = newWidth + 12 + 'px';
		this.resizingWindow.element.style.height = newHeight + 12 + 'px';
		this.resizingWindow.resizeStart.x = e.clientX;
		this.resizingWindow.resizeStart.y = e.clientY;
		this.resizingWindow.resizeStart.width = newWidth;
		this.resizingWindow.resizeStart.height = newHeight;
	}
	releaseWindowHandler(e) {
		if (this.resizingWindow) {
			this.resizingWindow.element.classList.remove('resizing');
			this.resizingWindow = null;
			return;
		}
		
		if (this.draggingWindow) {
			this.draggingWindow.position.left = e.clientX - this.draggingWindow.dragStart.x;
			this.draggingWindow.position.top = e.clientY - this.draggingWindow.dragStart.y;
			this.draggingWindow.element.classList.remove('dragging');
			this.draggingWindow = null;
		}
	}

	// INTERNAL METHODS
	get #boardSize() {
		return { width: this.windowsWrap.offsetWidth, height: this.windowsWrap.offsetHeight };
	}
	/** @param {HTMLElement} element */
	#getElementParentWindow(element) {
		// GO UP THROUGH PARENTS UNTIL FIND THE WINDOW (or abort on document.body)
		let target = element;
		while(target && target !== document.body) {
			if (target.classList.contains('window')) break;
			target = target.parentElement;
		}

		/** @type {string | null} */
		const appName = target.dataset.appName || null;
		const subWindow = appName ? this.windows[appName] : null;
		return { appName, subWindow };
	}
}