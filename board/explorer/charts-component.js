
export class BlocksTimesChartComponent {
	maxChartLength = 60;	// in blocks
	/** @type {number[]} */	heights = [];
	/** @type {number[]} */	timestamps = [];

	// PRIVATE METHODS
	#pruneFirstEntriesIfNeeded() {
		while (this.heights.length > this.maxChartLength) {
			this.heights.shift();
			this.timestamps.shift();
		}
	}
	#calculateGaps() {
		const gaps = [];
		for (let i = 1; i < this.timestamps.length; i++) 
			gaps.push((this.timestamps[i] - this.timestamps[i - 1]) / 1000);
		return gaps;
	}
	#getColorForGap(gap) {
		const a = Math.abs(gap - 120);
		if (a < 0 || a > 120) return 'rgb(0, 0, 0)';
		const grey = Math.floor(200 - (a / 120) * 200);
		return `rgb(${grey}, ${grey}, ${grey})`;
	}
	#render() {
		const container = document.getElementById('cbe-blocksTimesChart');
		if (!container) throw new Error('BlocksTimesChartComponent: render => Chart container not found');

		container.innerHTML = '';
		if (this.heights.length < 2) return;

		const gaps = this.#calculateGaps();
		const displayHeights = this.heights.slice(1);
		let maxY = Math.max(...gaps) + 10;
		maxY -= maxY % 10; // round down to nearest 10
		const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

		const margin = { top: 20, right: 10, bottom: 50, left: 40 };
		const width = container.clientWidth - margin.left - margin.right;
		const height = 300 - margin.top - margin.bottom;

		const svg = d3.select(container)
			.append('svg')
			.attr('width', container.clientWidth)
			.attr('height', 300)
			.append('g')
			.attr('transform', `translate(${margin.left},${margin.top})`);

		const x = d3.scaleLinear().domain(d3.extent(displayHeights)).range([0, width]);
		const y = d3.scaleLinear().domain([0, maxY]).range([height, 0]);

		// Axes
		const xTicks = displayHeights.filter((_, i) => i % 5 === 0);
		svg.append('g')
			.attr('transform', `translate(0,${height})`)
			.call(d3.axisBottom(x).tickValues(xTicks).tickFormat(d => `#${d}`))
			.selectAll('text')
			.attr('transform', 'rotate(-45)')
			.style('text-anchor', 'end')
			.style('font-family', '"IBM Plex Mono", monospace')
			.style('font-size', '10px');

		svg.append('g').call(d3.axisLeft(y).ticks(maxY / 10));

		// Average line
		svg.append('line')
			.attr('x1', 0).attr('x2', width)
			.attr('y1', y(avgGap)).attr('y2', y(avgGap))
			.attr('stroke', 'rgb(227, 227, 227)')
			.attr('stroke-width', 2)
			.attr('stroke-dasharray', '5,5');

		// Points
		svg.selectAll('circle')
			.data(gaps)
			.enter()
			.append('circle')
			.attr('cx', (d, i) => x(displayHeights[i]))
			.attr('cy', d => y(d))
			.attr('r', 3.5)
			.attr('fill', d => this.#getColorForGap(d))
			.append('title')
			.text((d, i) => ` #${displayHeights[i]} | ${d.toFixed(2)}s `);

		// Update average text
		const avgText = document.getElementById('cbe-averageBlocksTimeGap');
		if (avgText) avgText.textContent = ` | average: ${avgGap.toFixed(2)}s`;
	}

	// PUBLIC METHODS
	get lastHeight() { return this.heights.length > 0 ? this.heights[this.heights.length - 1] : null; }
	appendBlockTimeIfCorresponding(height = 0, timestamp = 0) {
		if (this.lastHeight !== null && height !== this.lastHeight + 1) return; // not corresponding
		this.#pruneFirstEntriesIfNeeded();
		this.heights.push(height);
		this.timestamps.push(timestamp);
		this.#render();
		return true;	
	}
	reset() {
		this.heights = [];
		this.timestamps = [];
		const container = document.getElementById('cbe-blocksTimesChart');
		if (container) container.innerHTML = '';
	}
}