export class NetworkRendererElements {
	UI;
	nodeTooltip;
	devInfo;
	modeSwitchBtn;
	fpsCountElement;
	nodeCountElement;
	connectingCountElement;
	neighborCountElement;
	publicNeighborCountElement;
	connectionsCountElement;
	linesCountElement;

	constructor(
		UI = document.getElementById('vzr-UI'),
		nodeTooltip = document.getElementById('node-tooltip'),
		devInfo = document.getElementById('vzr-dev-info'),
		modeSwitchBtn = document.getElementById('vzr-modeSwitchBtn'),
		fpsCountElement = document.getElementById('vzr-fpsCount'),
		nodeCountElement = document.getElementById('vzr-nodeCount'),
		connectingCountElement = document.getElementById('vzr-connectingCount'),
		neighborCountElement = document.getElementById('vzr-neighborCount'),
		publicNeighborCountElement = document.getElementById('vzr-publicNeighborCount'),
		connectionsCountElement = document.getElementById('vzr-connectionsCount'),
		linesCountElement = document.getElementById('vzr-linesCount'),
	) {
		this.UI = UI;
		this.nodeTooltip = nodeTooltip;
		this.devInfo = devInfo;
		this.modeSwitchBtn = modeSwitchBtn;
		this.fpsCountElement = fpsCountElement;
		this.nodeCountElement = nodeCountElement;
		this.connectingCountElement = connectingCountElement;
		this.neighborCountElement = neighborCountElement;
		this.publicNeighborCountElement = publicNeighborCountElement;
		this.connectionsCountElement = connectionsCountElement;
		this.linesCountElement = linesCountElement;
	}

	elementTextContents = {}; // Store current text content values for each element to avoid unnecessary DOM updates
	/** @param {string} elementId @param {string | number} value */
	setElementTextContentAndStoreValue(elementId, value) {
		if (!this[elementId]) return;
		if (this.elementTextContents[elementId] === value) return; // No update needed if value is the same as current
		this[elementId].textContent = value;
		this.elementTextContents[elementId] = value;
	}
}

export class NetworkRendererOptions {
	mode;
	antialias;
	precision;
	nodeRadius;
	nodeBorderRadius;
	attraction;
	repulsion;
	damping;
	centerForce;
	maxVelocity;
	repulsionOpts;
	attractionOpts;

	/**
	 * @param {'2d' | '3d'} mode 
	 * @param {number} nodeRadius @param {number} nodeBorderRadius @param {number} attraction @param {number} repulsion
	 * @param {number} damping @param {number} centerForce @param {number} maxVelocity
	 * 
	 * @param {Object} repulsionOpts
	 * @param {number} repulsionOpts.maxDistance
	 *
	 * @param {Object} attractionOpts
	 * @param {number} attractionOpts.minDistance
	 * */
	constructor(
		mode = '3d',
		antialias = true, // Enable or disable antialiasing
		precision = "highp", // "lowp"
		nodeRadius = 18, //12,
		nodeBorderRadius = 5, //3,
		attraction = .000001, // .0001
		repulsion = 5_000, // 50000
		damping = .005, // .5
		centerForce = .05, // .0005
		maxVelocity = 3, // .2
		repulsionOpts = {
			maxDistance: 400,
		},
		attractionOpts = {
			minDistance: 100, // 50
		}
	) {
		this.mode = mode;
		this.antialias = antialias;
		this.precision = precision;
		this.nodeRadius = nodeRadius;
		this.nodeBorderRadius = nodeBorderRadius;
		this.attraction = attraction;
		this.repulsion = repulsion;
		this.damping = damping;
		this.centerForce = centerForce;
		this.maxVelocity = maxVelocity;
		this.repulsionOpts = repulsionOpts;
		this.attractionOpts = attractionOpts;
	}
}