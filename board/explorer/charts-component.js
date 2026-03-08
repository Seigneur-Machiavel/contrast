export class RoundLegitimaciesChartComponent_D3 {
	maxBars = 10;
	minColor = 255;
	decay = 10;
	width = 400;
	height = 300;

	// PRIVATE METHODS
	/** @param {Array<{address: string, pubkeys: Set<string>}>} data */
	render(data = [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}]) {
		const container = document.getElementById('cbe-roundLegitimaciesChart');
		if (!container) throw new Error('RoundLegitimaciesChartComponent: render => Chart container not found');

		container.innerHTML = '';
		if (data.length === 0) return;

		// Take top N, reverse for display (lowest legitimacy at bottom)
		const topEntries = data.slice(0, this.maxBars);
		const entries = topEntries.map((e, i) => ({
			address: e.address || '-------',
			legitimacy: i, // position in array = legitimacy score
			index: i
		}));

		const margin = { top: 20, right: 0, bottom: 0, left: 0 };
		const width = this.width - margin.left - margin.right;
		const height = this.height - margin.top - margin.bottom;

		const svg = d3.select(container)
			.append('svg')
			.attr('width', this.width)
			.attr('height', this.height)
			.append('g')
			.attr('transform', `translate(${margin.left},${margin.top})`);

		const maxLegitimacy = entries.length;
		const total = maxLegitimacy + this.decay;

		const x = d3.scaleLinear()
			.domain([Math.floor(this.decay * .5), total])
			.range([0, width]);
		
		// Use index as unique identifier instead of address
		const y = d3.scaleBand()
			.domain(entries.map((e, i) => i))
			.range([0, height])
			.padding(0.1);

		const barHeight = y.bandwidth();

		// Bars
		svg.selectAll('rect')
			.data(entries)
			.enter()
			.append('rect')
			.attr('x', 0)
			.attr('y', (d, i) => y(i))
			.attr('width', d => x(d.legitimacy + this.decay))
			.attr('height', barHeight)
			.attr('fill', d => {
				const grey = Math.floor((d.legitimacy / (maxLegitimacy* 1.5)) * this.minColor);
				return `rgb(${grey}, ${grey}, ${grey})`;
			})
			.style('cursor', 'pointer')
			.on('click', (event, d) => this.#handleClick(d.address));

		// Labels
		svg.selectAll('text')
			.data(entries)
			.enter()
			.append('text')
			.attr('x', d => x(d.legitimacy + this.decay) - 5)
			.attr('y', (d, i) => y(i) + barHeight / 2)
			.attr('dy', '0.35em')
			.attr('text-anchor', 'end')
			.style('fill', '#ffffff')
			.style('font-size', '10px')
			.style('font-weight', '600')
			.style('font-family', '"IBM Plex Mono", monospace')
			.style('pointer-events', 'none')
			.text(d => `${d.legitimacy} | ${d.address}  `);
	}
	reset() {
		const container = document.getElementById('cbe-roundLegitimaciesChart');
		if (container) container.innerHTML = '';
	}

	#handleClick(address) {
		const event = new CustomEvent('addressClick', { detail: { address } });
		document.dispatchEvent(event);
	}
}
export class BlocksTimesChartComponent_D3 {
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
export class RoundLegitimaciesChartComponent {
    maxBars = 10;
    minColor = 255;
    decay = 10;
    width = 400;
    height = 300;
    #canvas = null;
	#img = null; // lighter to display when built.

    #getCanvas(container) {
        if (this.#canvas) return this.#canvas;
        this.#canvas = document.createElement('canvas');
		this.#canvas.style.display = 'none';
        //this.#canvas.addEventListener('click', e => this.#onClick(e));
        container.appendChild(this.#canvas);

		this.#img = document.createElement('img');
		container.appendChild(this.#img);
        return this.#canvas;
    }

    render(data = []) {
        const container = document.getElementById('cbe-roundLegitimaciesChart');
        if (!container) throw new Error('RoundLegitimaciesChartComponent: container not found');
        if (data.length === 0) return;

        const canvas  = this.#getCanvas(container);
        canvas.width  = this.width;
        canvas.height = this.height;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const margin   = { top: 20 };
        const drawH    = this.height - margin.top;
        const entries  = data.slice(0, this.maxBars).map((e, i) => ({
            address: e.address || '-------',
            legitimacy: i,
        }));

        const maxLegitimacy = entries.length;
        const total         = maxLegitimacy + this.decay;
        const domainMin     = Math.floor(this.decay * 0.5);
        const domainRange   = total - domainMin;

        const scaleX = v => ((v - domainMin) / domainRange) * this.width;
        const barH   = (drawH / entries.length) * 0.9; // ~padding(0.1)
        const gap    = (drawH / entries.length) * 0.1;
        const rowH   = drawH / entries.length;

        ctx.font = '600 12px "IBM Plex Mono", monospace';
		for (let i = 0; i < entries.length; i++) {
			const d = entries[i];
			const barW = scaleX(d.legitimacy + this.decay);
			const y    = margin.top + i * rowH + gap / 2;
			const grey = Math.floor((d.legitimacy / (maxLegitimacy * 1.5)) * this.minColor);
			
			// Bar
			ctx.fillStyle = `rgb(${grey},${grey},${grey})`;
			ctx.fillRect(0, y, barW, barH);

			// Label
			ctx.fillStyle    = '#ffffff';
			ctx.textAlign    = 'right';
			ctx.textBaseline = 'middle';
			ctx.fillText(`${d.legitimacy} | ${d.address}`, barW - 5, y + barH / 2);
        }

		// BUILT, FILL IMG AND SHOW IT INSTEAD OF CANVAS FOR BETTER PERFORMANCE (NO MORE REPAINT ON HOVER)
		const img = this.#img;
		img.width = this.width;
		img.height = this.height;
		img.src = canvas.toDataURL();
    }

    reset() {
        /*const container = document.getElementById('cbe-roundLegitimaciesChart');
        if (container) container.innerHTML = '';*/
    }
}

export class BlocksTimesChartComponent {
	#canvas = null;
	#img = null; // lighter to display when built.
    maxChartLength = 60;
    /** @type {number[]} */ heights = [];
    /** @type {number[]} */ timestamps = [];

    #pruneIfNeeded() {
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
        if (a > 120) return 'rgb(0,0,0)';
        const grey = Math.floor(200 - (a / 120) * 200);
        return `rgb(${grey},${grey},${grey})`;
    }

	#getCanvas(container) {
        if (this.#canvas) return this.#canvas;
        this.#canvas = document.createElement('canvas');
		this.#canvas.style.display = 'none';
        //this.#canvas.addEventListener('click', e => this.#onClick(e));
        container.appendChild(this.#canvas);

		this.#img = document.createElement('img');
		container.appendChild(this.#img);
        return this.#canvas;
    }

    #render() {
        const container = document.getElementById('cbe-blocksTimesChart');
        if (!container) throw new Error('BlocksTimesChartComponent: container not found');

        // Reuse or create canvas
        const canvas = this.#getCanvas(container);
        const gaps = this.#calculateGaps();
        if (gaps.length < 1) return;

        const displayHeights = this.heights.slice(1);
        const margin = { top: 20, right: 10, bottom: 50, left: 40 };

        canvas.width  = container.clientWidth;
        canvas.height = 300;

        const W = canvas.width  - margin.left - margin.right;
        const H = canvas.height - margin.top  - margin.bottom;
        const ctx = canvas.getContext('2d');

        // Scales
        let maxY = Math.max(...gaps) + 10;
        maxY -= maxY % 10;
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const minH = Math.min(...displayHeights);
        const maxH = Math.max(...displayHeights);

        const scaleX = v => margin.left + (maxH === minH ? W / 2 : (v - minH) / (maxH - minH) * W);
        const scaleY = v => margin.top  + H - (v / maxY * H);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = '10px "IBM Plex Mono", monospace';
        ctx.strokeStyle = '#555';
        ctx.fillStyle   = '#aaa';

        // Y axis ticks
        const yTickCount = maxY / 10;
        for (let i = 0; i <= yTickCount; i++) {
            const val = i * 10;
            const y   = scaleY(val);
            ctx.beginPath();
            ctx.moveTo(margin.left - 5, y);
            ctx.lineTo(margin.left, y);
            ctx.stroke();
            ctx.fillText(val, 2, y + 3);
        }
		
		// await new Promise(r => setTimeout(r, 20)); // avoid spamming microtasks

        // X axis ticks (every 5 blocks)
        ctx.save();
        for (let i = 0; i < displayHeights.length; i++) {
            if (i % 5 !== 0) continue;
            const x = scaleX(displayHeights[i]);
            const y = margin.top + H + 25; // extra space for rotated labels
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + 5);
            ctx.stroke();
            // Rotated label
            ctx.save();
            ctx.translate(x, y + 8);
            ctx.rotate(-Math.PI / 4);
            ctx.fillText(`#${displayHeights[i]}`, 0, 0);
            ctx.restore();
        }

        ctx.restore();
		// await new Promise(r => setTimeout(r, 20)); // avoid spamming microtasks

        // Axis lines
        ctx.beginPath();
        ctx.moveTo(margin.left, margin.top);
        ctx.lineTo(margin.left, margin.top + H);
        ctx.lineTo(margin.left + W, margin.top + H);
        ctx.stroke();

        // Average line
        const avgY = scaleY(avgGap);
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgb(227,227,227)';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.moveTo(margin.left, avgY);
        ctx.lineTo(margin.left + W, avgY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Points
        for (let i = 0; i < gaps.length; i++) {
            ctx.beginPath();
            ctx.arc(scaleX(displayHeights[i]), scaleY(gaps[i]), 3.5, 0, Math.PI * 2);
            ctx.fillStyle = this.#getColorForGap(gaps[i]);
            ctx.fill();
        }
		
		// await new Promise(r => setTimeout(r, 20)); // avoid spamming microtasks

        // Average text
        const avgText = document.getElementById('cbe-averageBlocksTimeGap');
        if (avgText) avgText.textContent = ` | average: ${avgGap.toFixed(2)}s`;

		// BUILT, FILL IMG AND SHOW IT INSTEAD OF CANVAS FOR BETTER PERFORMANCE (NO MORE REPAINT ON HOVER)
		const img = this.#img;
		img.width = canvas.width;
		img.height = canvas.height;
		img.src = canvas.toDataURL();
    }

    get lastHeight() { return this.heights.at(-1) ?? null; }

    appendBlockTimeIfCorresponding(height = 0, timestamp = 0, render = true) {
        if (this.lastHeight !== null && height !== this.lastHeight + 1) return;
        this.#pruneIfNeeded();
        this.heights.push(height);
        this.timestamps.push(timestamp);
        if (render) this.#render();
        return true;
    }

    reset() {
        this.heights = [];
        this.timestamps = [];
        /*const container = document.getElementById('cbe-blocksTimesChart');
        if (container) container.innerHTML = '';*/
    }
}