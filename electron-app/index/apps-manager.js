const { AppConfig, appsConfig, buildAppsConfig } = require('../../apps/apps-config.js');

/**
 * @param {string} tag
 * @param {string[]} classes
 * @param {string} [innerText]
 * @param {HTMLElement} [parent]
 * @param {string} [innerHTML] */
function newElement(tag, classes, innerText, parent, url_or_file) {
    const element = document.createElement(tag);
    if (innerText) element.innerText = innerText;
    element.classList.add(...classes);

    if (url_or_file && url_or_file.includes('.html')) {
        fetch(url_or_file).then(res => res.text()).then(html => {
            element.innerHTML = html;
        });
    } else if (url_or_file) {
        const iframe = document.createElement('iframe');
		// test with webview
		//const iframe = document.createElement('webview');
        iframe.src = url_or_file;
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        element.appendChild(iframe);
    }

    if (parent) parent.appendChild(element);
    return element;
}

class ButtonsBar {
	constructor(element) {
		/** @type {HTMLElement} */
		this.element = element;
		/** @type {HTMLElement[]} */
		this.buttons = [];
		/** @type {Object<string, HTMLElement>} */
		this.buttonsByAppNames = {};
	}

	addButton(appName, app, disabled = true) {
		const button = newElement('button', ['app-button'], '', this.element);
		if (disabled) button.classList.add('disabled');
		button.dataset.appName = appName;

		const img = newElement('img', [], '', button);
		img.src = app.icon;
		img.style.width = app.iconWidth;

		newElement('div', ['tooltip'], app.tooltip, button);

		this.buttons.push(button);
		this.buttonsByAppNames[appName] = button;
	}
	getButtonOrigin(buttonKey) {
		const result = { x: 0, y: 0 };
		/** @type {HTMLElement} */
		const button = this.buttonsByAppNames[buttonKey];
		if (!button) return result;
		
		const rect = button.getBoundingClientRect();
		result.x = rect.x + rect.width / 2;
		result.y = rect.y + rect.height / 2;
		return result;
	}
}
class SubWindow {
	canFullScreen = true;
	autoSized = false;
	dragStart = { x: 0, y: 0 };
	resizeStart = { x: 0, y: 0, width: 0, height: 0 };
	position = { left: 0, top: 0 };
	minSize = { width: 0, height: 0 };
	initSize = { width: undefined, height: undefined };
	windowSize = { width: 0, height: 0 };
	folded = true;
	animation = null;
	animationsComplexity = 1; // 0: none, 1: simple, 2: complex
	url_or_file;

	constructor(appName, title, url_or_file = '') {
		this.appName = appName;

		/** @type {HTMLElement} */
		this.element;
		this.title = title;
		this.contentElement;
		this.url_or_file = url_or_file;
		this.origin = url_or_file.includes('.html') ? null : url_or_file;
	}

	render(parentElement = document.body, fromX= 0, fromY= 0) {
		const windowClasses = this.autoSized ? ['window', 'fitContent'] : ['window', 'resizable'];
		this.element = newElement('div', windowClasses, '', parentElement);
		this.element.dataset.appName = this.appName;
		this.element.appendChild(this.#newTitleBar(this.title, this.canFullScreen, this.url_or_file.includes("://")));

		this.contentElement = newElement('div', ['content'], '', this.element, this.url_or_file);
		if (!this.contentElement) { console.error('Content cannot be build for:', this.url_or_file); return; }

		if (this.autoSized) {
			this.contentElement.style.position = 'relative';
		} else {
			const resizeBtn = newElement('div', ['resize-button'], '||', this.element);
			resizeBtn.dataset.appName = this.appName;
			//resizeBtn.dataset.action = 'resize';
		}

		// if iframe in content
		const iframe = this.contentElement.querySelector('iframe');
		//|| this.contentElement.querySelector('webview');
		if (iframe) iframe.id = this.appName + '-iframe';

		this.element.style.minWidth = this.minSize.width ? `${this.minSize.width}px` : 'auto';
		this.element.style.minHeight = this.minSize.height ? `${this.minSize.height}px` : 'auto';

		const { width, height } = parentElement.getBoundingClientRect();
		this.element.style.maxWidth = `${width}px`;
		this.element.style.maxHeight = `${height}px`;
		if (this.initSize.width) { this.element.style.width = this.initSize.width + 'px'; }
		if (this.initSize.height) { this.element.style.height = this.initSize.height + 'px'; }
		
		if (fromX && fromY) {
			this.element.style.opacity = 1;
			this.element.style.transform = 'scale(1)';
			this.element.style.top = document.body.offsetHeight + 1000 + 'px';

			anime({
				targets: this.element,
				opacity: 0,
				scale: .1,
				duration: 100,
				delay: 100,
				complete: () => {
					this.element.style.top = (fromX - this.element.offsetWidth / 2) + 'px';
					this.element.style.left = (fromY - this.element.offsetHeight) + 'px';
				}
			});

			// Set dark mode to the iframe according to the board body class
			setTimeout(() => this.setDarkModeAccordingToBoard(), 800);
		}
	}
	refreshIframeSrc() {
		if (!this.contentElement) return;

		const iframe = this.contentElement.querySelector('iframe');
		if (!iframe) return;

		iframe.src = iframe.src;
	}
	setDarkModeAccordingToBoard() {
		if (!this.origin) return;
		const iframe = this.contentElement.querySelector('iframe');
		if (!iframe) return;

		const darkModeState = document.body.classList.contains('dark-mode');
		iframe.contentWindow.postMessage({ type: 'darkMode', value: darkModeState }, this.origin);
	}
	#newTitleBar(title, expandable = true, isUrl = false) {
		const titleBar = newElement('div', ['title-bar'], '');
		newElement('div', ['background'], '', titleBar);
		newElement('span', [], title, titleBar);

		const buttonsWrap = newElement('div', ['buttons-wrap'], '', titleBar);

		if (isUrl) {
			const refreshButton = newElement('img', ['refresh-button'], '', buttonsWrap);
			refreshButton.dataset.appName = this.appName;
			refreshButton.dataset.action = 'refresh';
			refreshButton.src = '../img/refresh_64.png';
		}

		const foldButton = newElement('img', ['fold-button'], '', buttonsWrap);
		foldButton.dataset.appName = this.appName;
		foldButton.dataset.action = 'fold';
		foldButton.src = '../img/fold_64.png';

		if (!expandable) return titleBar;
		
		const expandButton = newElement('img', ['expand-button'], '', buttonsWrap);
		expandButton.dataset.appName = this.appName;
		expandButton.dataset.action = 'expand';
		expandButton.src = '../img/expand_64.png';

		return titleBar;
	}
	toggleFold(originX, originY, duration = 400) {
		this.folded = !this.folded;
		//if (this.folded) this.element.classList.remove('onBoard');
		if (!this.folded) this.element.classList.add('onBoard');

		// COMBINED ANIMATION
		if (this.animation) { this.animation.pause(); }

		const toPosition = { left: originX - this.element.offsetWidth / 2, top: originY - this.element.offsetHeight };
		if (!this.folded) { toPosition.left = this.position.left; toPosition.top = this.position.top };
		if (!this.folded && this.element.classList.contains('fullscreen')) { toPosition.left = 0; toPosition.top = 0; }

		this.animation = anime({
			targets: this.element,
			opacity: this.animationsComplexity < 1 ? null : {
				value: this.folded ? 0 : 1,
				duration: duration * .3,
				delay: this.folded ? duration * .5 : 0,
				easing: 'easeOutQuad'
			},
			scale: { value: this.folded ? .1 : 1, duration: duration, easing: 'easeOutQuad' },
			left: { value: toPosition.left, duration: duration, easing: 'easeOutQuad' },
			top: { value: toPosition.top, duration: duration, easing: 'easeOutQuad' },
			complete: () => {
				if (this.folded) this.element.classList.remove('onBoard');
			}
		});

		return this.folded;
	}
	setFullScreen(boardSize = { width: 0, height: 0 }, duration = 400) {
		if (!this.canFullScreen) return;
		if (this.element.classList.contains('fullscreen')) { return; }
		this.element.classList.add('fullscreen');

		const expandButton = this.element.querySelector('.expand-button');
		if (!expandButton) return;

		expandButton.dataset.action = 'detach';
		expandButton.src = '../img/detach_window_64.png';
		
		this.windowSize.width = this.element.offsetWidth;
		this.windowSize.height = this.element.offsetHeight;
		this.animation = anime({
			targets: this.element,
			width: boardSize.width + 'px',
			height: boardSize.height + 'px',
			top: '0px',
			left: '0px',
			duration,
			easing: 'easeOutQuad',
			complete: () => {
				this.element.style.width = '100%';
				this.element.style.height = '100%';
			}
		});
	}
	unsetFullScreen(duration = 400) {
		if (!this.element.classList.contains('fullscreen')) { return; }
		this.element.classList.remove('fullscreen');

		const expandButton = this.element.querySelector('.expand-button');
		if (!expandButton) return;
		expandButton.dataset.action = 'expand';
		expandButton.src = '../img/expand_64.png';
		
		this.element.style.width = this.element.offsetWidth + 'px';
		this.element.style.height = this.element.offsetHeight + 'px';

		this.animation = anime({
			targets: this.element,
			width: this.windowSize.width + 'px',
			height: this.windowSize.height + 'px',
			top: this.position.top + 'px',
			left: this.position.left + 'px',
			duration,
			easing: 'easeOutQuad'
		});
	}
}

class AppsManager {
	state = 'locked';
	appsConfig = buildAppsConfig(appsConfig);
	windowsWrap;
	buttonsBar;
	/** @type {Object<string, SubWindow>} */
	windows = {};
	/** @type {SubWindow} */
	draggingWindow = null;
	/** @type {SubWindow} */
	resizingWindow = null;
	tempFrontAppName = null;
	transitionsDuration = 400;
	appsByZindex 

	/** @param {HTMLElement} windowsWrap, @param {HTMLElement} buttonsBarElement */
	constructor(windowsWrap, buttonsBarElement) {
		this.windowsWrap = windowsWrap;
		this.buttonsBar = new ButtonsBar(buttonsBarElement);
	}

	updateCssAnimationsDuration() {
		document.documentElement.style.setProperty('--windows-animation-duration', this.transitionsDuration + 'ms');
	}
	initApps() {
		this.buttonsBar.element.innerHTML = '';
		for (const app in this.appsConfig) {
			this.buttonsBar.addButton(app, this.appsConfig[app], this.appsConfig[app].disableOnLock);
			if (this.appsConfig[app].preload) this.loadApp(app);
		}
	}
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
				if (fullScreen) this.windows[appName].setFullScreen(this.calculateBoardSize(), 0);
				if (!setFront || startHidden) return;
				this.windows[appName].toggleFold(origin.x, origin.y, 600);
				this.setFrontWindow(appName);
			}, 400);
		}
	}
	/**
	 * load app window and create button if not already created
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
	calculateBoardSize() {
		return { width: this.windowsWrap.offsetWidth, height: this.windowsWrap.offsetHeight };
	}
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
		for (const app in this.appsConfig) {
			if (this.appsConfig[app].disableOnLock === false) continue;
			this.buttonsBar.buttonsByAppNames[app].classList.add('disabled');
		}
	}
	unlock() {
		this.state = 'unlocked';
		for (const app in this.appsConfig) {
			this.buttonsBar.buttonsByAppNames[app].classList.remove('disabled');
		}
	}
	// HANDLERS
	clickAppButtonsHandler(e) {
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
	hoverAppButtonsHandler(e) {
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
	clickWindowHandler(e) {
		switch(e.target.dataset.action) {
			case 'refresh':
				this.windows[e.target.dataset.appName].refreshIframeSrc();
				this.windows[e.target.dataset.appName].setDarkModeAccordingToBoard();
				return;
			case 'fold': this.toggleAppWindow(e.target.dataset.appName); return;
			case 'expand':
				this.windows[e.target.dataset.appName].setFullScreen(this.calculateBoardSize(), this.transitionsDuration);
				return;
			case 'detach':
				this.windows[e.target.dataset.appName].unsetFullScreen(this.transitionsDuration);
				return;
		}

		// if click in a window (anywhere), bring it to front
		// trough parents of the clicked element until find the window
		let target = e.target;
		while(target && target !== document.body) {
			if (target.classList.contains('window')) { break; }
			target = target.parentElement;
		}

		const subWindow = Object.values(this.windows).find(w => w.element.contains(target));
		if (!subWindow) return;

		const appName = subWindow.element.dataset.appName;
		this.setFrontWindow(appName);
	}
	dlbClickTitleBarHandler(e) {
		if (!e.target.classList.contains('title-bar')) return;

		const subWindow = Object.values(this.windows).find(w => w.element.contains(e.target));
		if (!subWindow) return;

		if (!subWindow.element.classList.contains('fullscreen')) {
			subWindow.setFullScreen(this.calculateBoardSize(), this.transitionsDuration);
		} else {
			subWindow.unsetFullScreen(this.transitionsDuration);
		}
	}
	grabWindowHandler(e) {
		const subWindow = Object.values(this.windows).find(w => w.element.contains(e.target));
		if (!subWindow) return;
		if (subWindow.element.classList.contains('fullscreen')) { return; }

		const appName = subWindow.element.dataset.appName;
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
		const subWindow = this.draggingWindow;
		if (!subWindow) return;
		
		e.preventDefault();
		const maxLeft = this.windowsWrap.offsetWidth - 50;
		const minTop = this.windowsWrap.offsetHeight - 32;
		const left = Math.max(0, e.clientX - subWindow.dragStart.x);
		const top = Math.max(0, e.clientY - subWindow.dragStart.y);
		subWindow.element.style.left = Math.min(left, maxLeft) + 'px';
		subWindow.element.style.top = Math.min(top, minTop) + 'px';
	}
	moveResizeHandler(e) {
		const subWindow = this.resizingWindow;
		if (!subWindow) return;

		e.preventDefault();
		const minWidth = subWindow.minSize.width || 100;
		const minHeight = subWindow.minSize.height || 100;

		const { width, height } = this.windowsWrap.getBoundingClientRect();
		const maxWidth = width;
		const maxHeight = height;

		const cursorHorizontalDiff = e.clientX - subWindow.resizeStart.x;
		const cursorVerticalDiff = e.clientY - subWindow.resizeStart.y;
		
		const newWidth = Math.min(maxWidth, Math.max(minWidth, subWindow.resizeStart.width + cursorHorizontalDiff));
		const newHeight = Math.min(maxHeight, Math.max(minHeight, subWindow.resizeStart.height + cursorVerticalDiff));
		// +12 px to improve tracking
		subWindow.element.style.width = newWidth + 12 + 'px';
		subWindow.element.style.height = newHeight + 12 + 'px';
		
		subWindow.resizeStart.x = e.clientX;
		subWindow.resizeStart.y = e.clientY;
		subWindow.resizeStart.width = newWidth;
		subWindow.resizeStart.height = newHeight;
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
}

module.exports = { AppsManager, AppConfig, appsConfig };