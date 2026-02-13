

export class TransactionDiagram {
	params = {
		nodeGap: 60,
		nodeRadius: 15,
		verticalOffset: 80,
		railY: 200,
		labelAngle: -70,
		marginLeft: 80,
		marginRight: 80,
		dataBoxWidth: 80,
		dataBoxHeight: 60,
		sectionSpacing: 150,
		expertMode: false
	}

	#svg
	#layers = { rail: null, connections: null, nodes: null, labels: null }
	#nodes = { inputs: [], data: null, outputs: [] }
	#callbacks = { onAddOutput: null, onNodeClick: null }

	constructor(container, callbacks = {}) {
		this.#callbacks = callbacks;

		this.#svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this.#svg.setAttribute('height', '350');
		container.appendChild(this.#svg);

		this.#layers.rail = this.#createGroup('rail');
		this.#layers.connections = this.#createGroup('connections');
		this.#layers.nodes = this.#createGroup('nodes');
		this.#layers.labels = this.#createGroup('labels');
	}

	#createGroup(id) {
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		g.id = id;
		this.#svg.appendChild(g);
		return g;
	}
	#calculateWeight(type) {
		if (type === 'input') return 148
		if (type === 'output') return 34
		return 0
	}
	#calculateTotalWidth() {
		const { nodeGap, marginLeft, marginRight, sectionSpacing, dataBoxWidth } = this.params

		const inputsWidth = Math.max(0, this.#nodes.inputs.length - 1) * nodeGap
		const dataWidth = this.#nodes.data ? dataBoxWidth : 0
		const outputsWidth = Math.max(0, this.#nodes.outputs.length) * nodeGap // +1 for add button

		let totalWidth = marginLeft + marginRight

		if (this.#nodes.inputs.length) totalWidth += inputsWidth + sectionSpacing
		if (this.#nodes.data) totalWidth += dataWidth + sectionSpacing
		totalWidth += outputsWidth

		return Math.max(600, totalWidth)
	}
	#getRailEndX() {
		const { nodeGap, marginLeft, sectionSpacing, dataBoxWidth } = this.params
		let endX = marginLeft

		if (this.#nodes.inputs.length)
			endX += Math.max(0, this.#nodes.inputs.length - 1) * nodeGap + sectionSpacing

		if (this.#nodes.data)
			endX += dataBoxWidth + sectionSpacing

		endX += Math.max(0, this.#nodes.outputs.length) * nodeGap

		return endX
	}
	#drawRail() {
		const { railY, marginLeft } = this.params
		const endX = this.#getRailEndX()

		const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
		line.setAttribute('x1', marginLeft)
		line.setAttribute('y1', railY)
		line.setAttribute('x2', endX)
		line.setAttribute('y2', railY)
		line.classList.add('rail')
		this.#layers.rail.appendChild(line)

		if (this.#nodes.data) this.#draw2ArrowsOnRail()
		else this.#drawArrowOnHalfRail()
	}
	#drawArrowOnHalfRail() {
		const { railY, marginLeft } = this.params
		const endX = this.#getRailEndX()
		const halfX = marginLeft + (endX - marginLeft) / 2

		const squareSize = 10
		const square = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
		square.setAttribute('x', halfX - squareSize)
		square.setAttribute('y', railY - squareSize / 2)
		square.setAttribute('width', squareSize)
		square.setAttribute('height', squareSize)
		square.setAttribute('fill', '#fff')
		this.#layers.rail.appendChild(square)

		const arrowSize = 8
		const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
		arrow.setAttribute('d', `M ${halfX - arrowSize} ${railY - arrowSize} L ${halfX} ${railY} L ${halfX - arrowSize} ${railY + arrowSize}`)
		arrow.setAttribute('stroke', '#000')
		arrow.setAttribute('stroke-width', '2')
		arrow.setAttribute('fill', 'none')
		arrow.setAttribute('stroke-linecap', 'round')
		this.#layers.rail.appendChild(arrow)
	}
	#draw2ArrowsOnRail() {
		const { railY, marginLeft } = this.params
		const endX = this.#getRailEndX()
		const quartX = marginLeft + (endX - marginLeft) / 4
		const threeQuartX = marginLeft + 3 * (endX - marginLeft) / 4

		const squareSize = 10
		const arrowSize = 8

		for (const x of [quartX, threeQuartX]) {
			const square = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
			square.setAttribute('x', x - squareSize)
			square.setAttribute('y', railY - squareSize / 2)
			square.setAttribute('width', squareSize)
			square.setAttribute('height', squareSize)
			square.setAttribute('fill', '#fff')
			this.#layers.rail.appendChild(square)

			const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
			arrow.setAttribute('d', `M ${x - arrowSize} ${railY - arrowSize} L ${x} ${railY} L ${x - arrowSize} ${railY + arrowSize}`)
			arrow.setAttribute('stroke', '#000')
			arrow.setAttribute('stroke-width', '2')
			arrow.setAttribute('fill', 'none')
			arrow.setAttribute('stroke-linecap', 'round')
			this.#layers.rail.appendChild(arrow)
		}
	}
	#drawTotalLabel() {
		const totalIn = this.#nodes.inputs.reduce((sum, input) => sum + parseFloat(input.balance), 0)
		if (totalIn === 0 || !this.#nodes.inputs.length) return

		const { nodeGap, marginLeft, railY } = this.params
		const lastInputIndex = this.#nodes.inputs.length - 1
		const lastInputX = marginLeft + (lastInputIndex * nodeGap)
		const labelY = railY + 30

		const labelText = `${totalIn.toFixed(2)}c`
		const bbox = this.#getTextBBox(labelText, 11)
		const padding = 6

		const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
		bgRect.classList.add('total-bg')
		bgRect.setAttribute('x', lastInputX - bbox.width / 2 - padding)
		bgRect.setAttribute('y', labelY - bbox.height / 2 - padding + 2)
		bgRect.setAttribute('width', bbox.width + padding * 2)
		bgRect.setAttribute('height', bbox.height + padding * 2)
		bgRect.setAttribute('rx', 3)
		this.#layers.labels.appendChild(bgRect)

		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
		label.textContent = labelText
		label.classList.add('total-label')
		label.setAttribute('x', lastInputX)
		label.setAttribute('y', labelY + 4)
		label.setAttribute('text-anchor', 'middle')
		this.#layers.labels.appendChild(label)
	}
	#drawWeightLabels() {
		if (!this.params.expertMode) return

		const { railY } = this.params
		const endX = this.#getRailEndX()
		const labelY = railY + 30

		let totalWeight = 10
		for (const input of this.#nodes.inputs) totalWeight += input.weight
		for (const output of this.#nodes.outputs) totalWeight += output.weight
		if (this.#nodes.data) totalWeight += this.#nodes.data.weight

		const labelText = `Total: ${totalWeight}b`
		const bbox = this.#getTextBBox(labelText, 9)
		const padding = 4

		const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
		bgRect.classList.add('amount-bg')
		bgRect.setAttribute('x', endX - bbox.width - padding * 2)
		bgRect.setAttribute('y', labelY - bbox.height / 2 - padding + 2)
		bgRect.setAttribute('width', bbox.width + padding * 2)
		bgRect.setAttribute('height', bbox.height + padding * 2)
		this.#layers.labels.appendChild(bgRect)

		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
		label.textContent = labelText
		label.classList.add('weight-label')
		label.setAttribute('x', endX - padding)
		label.setAttribute('y', labelY + 3)
		label.setAttribute('text-anchor', 'end')
		this.#layers.labels.appendChild(label)
	}
	#drawNodes() {
		const { marginLeft, railY, verticalOffset, nodeGap, sectionSpacing, dataBoxWidth } = this.params
		let currentX = marginLeft

		// Inputs
		if (this.#nodes.inputs.length) {
			for (let i = 0; i < this.#nodes.inputs.length; i++) {
				const input = this.#nodes.inputs[i]
				const x = currentX + (i * nodeGap)
				const y = railY - verticalOffset
				this.#drawCircleNode(x, y, input, false, i)
			}
			currentX += Math.max(0, this.#nodes.inputs.length - 1) * nodeGap + sectionSpacing
		}

		// Data
		if (this.#nodes.data) {
			this.#drawDataNode(currentX + dataBoxWidth / 2, railY - verticalOffset)
			currentX += dataBoxWidth + sectionSpacing
		}

		// Outputs
		if (this.#nodes.outputs.length) {
			for (let i = 0; i < this.#nodes.outputs.length; i++) {
				const output = this.#nodes.outputs[i]
				const x = currentX + (i * nodeGap)
				const y = railY - verticalOffset
				this.#drawCircleNode(x, y, output, true, i)
			}
			currentX += this.#nodes.outputs.length * nodeGap
		}

		// Add output button
		this.#drawAddOutputButton(currentX, railY - verticalOffset)
	}
	#drawCircleNode(x, y, data, isOutput, index) {
		const { nodeRadius, labelAngle, expertMode } = this.params

		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
		g.style.cursor = 'pointer'
		g.addEventListener('click', () => {
			if (this.#callbacks.onNodeClick) {
				this.#callbacks.onNodeClick({ data, isOutput, index })
			}
		})

		const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
		circle.classList.add('node-circle')
		circle.setAttribute('cx', x)
		circle.setAttribute('cy', y)
		circle.setAttribute('r', nodeRadius)
		circle.setAttribute('fill', isOutput ? '#000' : '#fff')
		circle.setAttribute('stroke', '#000')
		circle.setAttribute('stroke-width', '2')

		g.appendChild(circle)
		this.#layers.nodes.appendChild(g)

		const addressLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text')
		addressLabel.textContent = data.name || data.address
		addressLabel.classList.add('address-label')
		addressLabel.setAttribute('x', x)
		addressLabel.setAttribute('y', y - nodeRadius - 8)
		addressLabel.setAttribute('text-anchor', 'start')
		addressLabel.setAttribute('fill', '#000')
		addressLabel.setAttribute('transform', `rotate(${labelAngle}, ${x}, ${y - nodeRadius - 8})`)
		this.#layers.labels.appendChild(addressLabel)

		const amount = data.balance || data.amount
		const amountText = `${amount}c`
		const bbox = this.#getTextBBox(amountText, 12)

		const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
		bgRect.classList.add('amount-bg')
		bgRect.setAttribute('x', x - bbox.width / 2 - 4)
		bgRect.setAttribute('y', y + nodeRadius + 8)
		bgRect.setAttribute('width', bbox.width + 8)
		bgRect.setAttribute('height', bbox.height + 4)
		this.#layers.labels.appendChild(bgRect)

		const amountLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text')
		amountLabel.textContent = amountText
		amountLabel.classList.add('amount-label')
		amountLabel.setAttribute('x', x)
		amountLabel.setAttribute('y', y + nodeRadius + 20)
		amountLabel.setAttribute('text-anchor', 'middle')
		amountLabel.setAttribute('fill', '#000')
		this.#layers.labels.appendChild(amountLabel)

		if (expertMode && data.weight) {
			const weightLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text')
			weightLabel.textContent = `${data.weight}b`
			weightLabel.classList.add('weight-label')
			weightLabel.setAttribute('x', x)
			weightLabel.setAttribute('y', y + nodeRadius + 32)
			weightLabel.setAttribute('text-anchor', 'middle')
			this.#layers.labels.appendChild(weightLabel)
		}
	}
	#drawAddOutputButton(x, y) {
		const { nodeRadius } = this.params

		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
		g.classList.add('add-output-circle')
		g.style.cursor = 'pointer'
		g.addEventListener('click', () => {
			if (this.#callbacks.onAddOutput) {
				this.#callbacks.onAddOutput()
			}
		})

		const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
		circle.setAttribute('cx', x)
		circle.setAttribute('cy', y)
		circle.setAttribute('r', nodeRadius)
		circle.setAttribute('fill', '#fff')
		circle.setAttribute('stroke', '#000')
		circle.setAttribute('stroke-width', '2')
		circle.setAttribute('stroke-dasharray', '4,4')

		const plus = document.createElementNS('http://www.w3.org/2000/svg', 'text')
		plus.textContent = '+'
		plus.classList.add('add-label')
		plus.setAttribute('x', x)
		plus.setAttribute('y', y + 8)
		plus.setAttribute('text-anchor', 'middle')
		plus.setAttribute('fill', '#666')

		g.appendChild(circle)
		g.appendChild(plus)
		this.#layers.nodes.appendChild(g)
	}
	#drawDataNode(x, y) {
		const { dataBoxWidth, dataBoxHeight, expertMode } = this.params

		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
		rect.setAttribute('x', x - dataBoxWidth / 2)
		rect.setAttribute('y', y - dataBoxHeight / 2)
		rect.setAttribute('width', dataBoxWidth)
		rect.setAttribute('height', dataBoxHeight)
		rect.setAttribute('fill', '#fff')
		rect.setAttribute('stroke', '#000')
		rect.setAttribute('stroke-width', '2')
		rect.setAttribute('rx', '4')
		this.#layers.nodes.appendChild(rect)

		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
		label.textContent = 'Data'
		label.classList.add('data-label')
		label.setAttribute('x', x)
		label.setAttribute('y', y + 4)
		label.setAttribute('text-anchor', 'middle')
		label.setAttribute('fill', '#000')
		this.#layers.labels.appendChild(label)

		if (expertMode && this.#nodes.data?.weight) {
			const weightLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text')
			weightLabel.textContent = `${this.#nodes.data.weight}b`
			weightLabel.classList.add('weight-label')
			weightLabel.setAttribute('x', x)
			weightLabel.setAttribute('y', y + dataBoxHeight / 2 + 12)
			weightLabel.setAttribute('text-anchor', 'middle')
			this.#layers.labels.appendChild(weightLabel)
		}
	}
	#drawConnections() {
		const { marginLeft, railY, verticalOffset, nodeGap, sectionSpacing, dataBoxWidth, nodeRadius } = this.params
		let currentX = marginLeft

		if (this.#nodes.inputs.length) {
			for (let i = 0; i < this.#nodes.inputs.length; i++) {
				const x = currentX + (i * nodeGap)
				const y = railY - verticalOffset
				this.#drawVerticalConnection(x, y + nodeRadius, railY)
			}
			currentX += Math.max(0, this.#nodes.inputs.length - 1) * nodeGap + sectionSpacing
		}

		if (this.#nodes.data) {
			const x = currentX + dataBoxWidth / 2
			const y = railY - verticalOffset
			const dataHeight = this.params.dataBoxHeight
			this.#drawVerticalConnection(x, y + dataHeight / 2, railY)
			currentX += dataBoxWidth + sectionSpacing
		}

		if (this.#nodes.outputs.length) {
			for (let i = 0; i < this.#nodes.outputs.length; i++) {
				const x = currentX + (i * nodeGap)
				const y = railY - verticalOffset
				this.#drawVerticalConnection(x, railY, y + nodeRadius)
			}
		}
	}
	#drawVerticalConnection(x, y1, y2) {
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
		path.setAttribute('d', `M ${x} ${y1} L ${x} ${y2}`)
		path.classList.add('connection')
		this.#layers.connections.appendChild(path)
	}
	#getTextBBox(text, fontSize) {
		const tempText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
		tempText.textContent = text
		tempText.style.fontSize = `${fontSize}px`
		tempText.style.fontFamily = '-apple-system, monospace'
		this.#svg.appendChild(tempText)
		const bbox = tempText.getBBox()
		this.#svg.removeChild(tempText)
		return bbox
	}
	#updateSummary() {
		const totalIn = this.#nodes.inputs.reduce((sum, input) => sum + parseFloat(input.balance), 0)
		const totalOut = this.#nodes.outputs.reduce((sum, output) => sum + parseFloat(output.amount), 0)

		let totalWeight = 10
		for (const input of this.#nodes.inputs) totalWeight += input.weight
		for (const output of this.#nodes.outputs) totalWeight += output.weight
		if (this.#nodes.data) totalWeight += this.#nodes.data.weight

		const fee = (totalWeight / 1000 * 0.001)
		const change = totalIn - totalOut - fee

		document.getElementById('totalIn').textContent = `${totalIn.toFixed(2)}c`
		document.getElementById('totalOut').textContent = `${totalOut.toFixed(2)}c`
		document.getElementById('fee').textContent = `~${fee.toFixed(6)}c`
		document.getElementById('change').textContent = `${Math.max(0, change).toFixed(2)}c`
	}

	setExpertMode(enabled) {
		this.params.expertMode = enabled
		this.redraw()
	}
	addInput(address, name, balance) {
		this.#nodes.inputs.push({ address, name, balance, weight: this.#calculateWeight('input') })
		this.redraw()
		this.#updateSummary()
	}
	addOutput(address, name, amount) {
		this.#nodes.outputs.push({ address, name, amount, weight: this.#calculateWeight('output') })
		this.redraw()
		this.#updateSummary()
	}
	removeOutput(index) {
		if (index >= 0 && index < this.#nodes.outputs.length) {
			this.#nodes.outputs.splice(index, 1)
			this.redraw()
			this.#updateSummary()
		}
	}
	toggleDataField() {
		this.#nodes.data = this.#nodes.data ? null : { enabled: true, weight: 128 }
		this.redraw()
	}
	clear() {
		this.#nodes.inputs = []
		this.#nodes.outputs = []
		this.#nodes.data = null
		this.redraw()
		this.#updateSummary()
	}
	redraw() {
		this.#layers.rail.innerHTML = ''
		this.#layers.connections.innerHTML = ''
		this.#layers.nodes.innerHTML = ''
		this.#layers.labels.innerHTML = ''

		const width = this.#calculateTotalWidth()
		this.#svg.setAttribute('width', width)

		this.#drawRail()
		this.#drawNodes()
		this.#drawConnections()
		this.#drawTotalLabel()
		this.#drawWeightLabels()
	}
	exportSnapshot() {
		const svgData = new XMLSerializer().serializeToString(this.#svg)
		const canvas = document.createElement('canvas')
		const ctx = canvas.getContext('2d')
		const img = new Image()

		img.onload = () => {
			canvas.width = this.#svg.width.baseVal.value
			canvas.height = this.#svg.height.baseVal.value
			ctx.fillStyle = '#fff'
			ctx.fillRect(0, 0, canvas.width, canvas.height)
			ctx.drawImage(img, 0, 0)

			const link = document.createElement('a')
			link.download = 'transaction-snapshot.png'
			link.href = canvas.toDataURL('image/png')
			link.click()
		}

		img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
	}
}