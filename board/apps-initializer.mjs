import { createElement } from './board-helpers.mjs';

export class ButtonsBar {
	/** @type {HTMLElement} */					element;
	/** @type {HTMLElement[]} */ 				buttons = [];
	/** @type {Object<string, HTMLElement>} */	buttonsByAppNames = {};

	constructor(element) { this.element = element; }
	
	addButton(appName, app, disabled = true) {
		const button = createElement('button', ['app-button'], this.element);
		button.dataset.appName = appName;
		
		const img = createElement('img', [], button);
		img.src = app.iconSrc;
		img.style.width = app.iconWidth;
		
		const tooltip = createElement('div', ['tooltip'], button);
		tooltip.textContent = app.tooltip;
		
		this.buttons.push(button);
		this.buttonsByAppNames[appName] = button;
		if (disabled) button.classList.add('disabled');
	}
	getButtonOrigin(buttonKey) {
		const result = { x: 0, y: 0 };
		const button = this.buttonsByAppNames[buttonKey];
		if (!button) return result;
		
		const rect = button.getBoundingClientRect();
		result.x = rect.x + rect.width / 2;
		result.y = rect.y + rect.height / 2;
		return result;
	}
}
export class SubWindow {
	/** @type {HTMLElement} */				element;
	/** @type {HTMLElement} */  			titleBar;
	/** @type {HTMLElement | null} */		expandButton;
	/** @type {HTMLElement} */				foldButton;
	/** @type {HTMLElement} */				contentElement;
	/** @type {HTMLIFrameElement | null} */	iframe;

	appName; title; origin;
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

	/** @param {string} appName @param {string} title @param {string} [url_or_file] */
	constructor(appName, title, url_or_file = '') {
		this.appName = appName;
		this.title = title;
		this.url_or_file = url_or_file;
		this.origin = url_or_file.includes('.html') ? null : url_or_file;
	}

	get isFullScreen() {
		return this.element.classList.contains('fullscreen');
	}

	render(parentElement = document.body, fromX= 0, fromY= 0) {
		const windowClasses = this.autoSized ? ['window', 'fitContent'] : ['window', 'resizable'];
		const { titleBar, expandButton, foldButton } = this.newTitleBar(this.title, this.canFullScreen, this.url_or_file.includes("://"));
		this.titleBar = 	titleBar;
		this.foldButton = 	foldButton;
		this.expandButton = expandButton || null;
		this.element = createElement('div', windowClasses, parentElement);
		this.element.dataset.appName = this.appName;
		this.element.appendChild(titleBar);
		this.contentElement = createElement('div', ['content'], this.element);
		if (!this.contentElement) { console.error('Content cannot be build for:', this.url_or_file); return; }

		// Inner HTML or iframe injection
		if (this.url_or_file.includes('.html'))
			fetch(this.url_or_file).then(res => res.text()).then(html => this.contentElement.innerHTML = html);
		else {
			const iframe = document.createElement('iframe');
			iframe.src = this.url_or_file;
			iframe.id = this.appName + '-iframe';
			iframe.style.width = '100%';
			iframe.style.height = '100%';
			iframe.style.border = 'none';
			this.iframe = iframe;
			this.contentElement.appendChild(iframe);
		}

		if (this.autoSized) this.contentElement.style.position = 'relative';
		else {
			const resizeButton = createElement('div', ['resize-button'], this.element);
			resizeButton.dataset.appName = this.appName;
			resizeButton.innerText = '||';
		}

		this.element.style.minWidth = this.minSize.width ? `${this.minSize.width}px` : 'auto';
		this.element.style.minHeight = this.minSize.height ? `${this.minSize.height}px` : 'auto';

		const { width, height } = parentElement.getBoundingClientRect();
		this.element.style.maxWidth = `${width}px`;
		this.element.style.maxHeight = `${height}px`;
		if (this.initSize.width) this.element.style.width = this.initSize.width + 'px';
		if (this.initSize.height) this.element.style.height = this.initSize.height + 'px';
		
		// Set initial position
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
	/** @param {string} title @param {boolean} expandable Default: true @param {boolean} isUrl Default: false */
	newTitleBar(title, expandable = true, isUrl = false) {
		const titleBar = createElement('div', ['title-bar']);
		createElement('div', ['background'], titleBar);

		const titleElement = createElement('div', ['title-text'], titleBar);
		titleElement.innerHTML = title; // innerHTML to apply title decorations

		const buttonsWrap = createElement('div', ['buttons-wrap'], titleBar);
		if (isUrl) {
			const refreshButton = createElement('img', ['refresh-button'], buttonsWrap);
			refreshButton.dataset.appName = this.appName;
			refreshButton.dataset.action = 'refresh';
			refreshButton.src = 'assets/refresh_64.png';
		}

		const foldButton = createElement('img', ['fold-button'], buttonsWrap);
		foldButton.dataset.appName = this.appName;
		foldButton.dataset.action = 'fold';
		foldButton.src = 'assets/fold_64.png';

		if (!expandable) return { titleBar, expandButton: null, foldButton };
		
		const expandButton = createElement('img', ['expand-button'], buttonsWrap);
		expandButton.dataset.appName = this.appName;
		expandButton.dataset.action = 'expand';
		expandButton.src = 'assets/expand_64.png';

		return { titleBar, expandButton, foldButton };
	}
	refreshIframeSrc() {
		if (this.iframe) this.iframe.src = this.iframe.src;
	}
	setDarkModeAccordingToBoard() {
		if (!this.origin) return;

		const darkModeState = document.body.classList.contains('dark-mode');
		if (this.iframe) this.iframe.contentWindow.postMessage({ type: 'darkMode', value: darkModeState }, this.origin);
	}
	toggleFold(originX, originY, duration = 400) {
		this.folded = !this.folded;
		//if (this.folded) this.element.classList.remove('onBoard');
		if (!this.folded) this.element.classList.add('onBoard');

		// COMBINED ANIMATION
		if (this.animation) this.animation.pause();

		const toPosition = { left: originX - this.element.offsetWidth / 2, top: originY - this.element.offsetHeight };
		if (!this.folded) {
			toPosition.left = this.isFullScreen ? 0 : this.position.left;
			toPosition.top = this.isFullScreen ? 0 : this.position.top;
		};

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
		if (!this.canFullScreen || this.isFullScreen) return;

		this.element.classList.add('fullscreen');
		this.expandButton.dataset.action = 'detach';
		this.expandButton.src = 'assets/detach_window_64.png';
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
		if (!this.canFullScreen || !this.isFullScreen) return;

		this.element.classList.remove('fullscreen');
		this.expandButton.dataset.action = 'expand';
		this.expandButton.src = 'assets/expand_64.png';
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