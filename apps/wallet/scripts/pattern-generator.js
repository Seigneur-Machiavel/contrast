// pattern-generator.js

class PatternGenerator {
    constructor(options = {}) {
        this.SCALE = options.scale || 2;
        this.width = options.width || 48;
        this.height = options.height || 48;
        this.shapes = [];
        this.base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    }

    generateImage(seed = 'toto', shapeCount) {
        const drawingCanvas = document.createElement('canvas');
        drawingCanvas.width = this.width * this.SCALE;
        drawingCanvas.height = this.height * this.SCALE;
        const ctx = drawingCanvas.getContext('2d');
        this.shapes = [];

        const randoms = [];
        for (let i = 1; i < 50; i++) { // don't use the first letter of the seed
            const char = seed[i] || seed[i - seed.length] || '1';
            let num = this.base58.indexOf(char) || 0;
            randoms.push(num / 58);
        }
        //console.log('randoms:', randoms);

        const centerX = drawingCanvas.width / 2;
        const centerY = drawingCanvas.height / 2;
        const maxSize = Math.min(drawingCanvas.width, drawingCanvas.height) * 0.45;

        const circleThreshold = 0.3 + (randoms[0] * 0.4);

        for (let i = shapeCount; i > 0; i--) {
            const mod = i * 4;
            const size = (i / shapeCount) * maxSize * (.95 + (randoms[mod + 1] * .1));
            const brightness = Math.floor(200 + (randoms[mod + 2] * 55));
            const lineWidth = this.SCALE * (.2 + (randoms[mod + 3] * 1.4));
            const isCircle = randoms[mod + 4] < circleThreshold;
            //console.log('size:', size, 'brightness:', brightness, 'lineWidth:', lineWidth, 'isCircle:', isCircle);

            this.shapes.push({ size, brightness, lineWidth, isCircle });
        }

        this.drawShapes(ctx, centerX, centerY);

        return drawingCanvas;
    }

    drawShapes(ctx, centerX, centerY) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        // Re-add shadows for the shapes
        ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
        ctx.shadowBlur = 4 * this.SCALE;

        this.shapes.forEach(shape => {
            const strokeStyle = `rgb(${shape.brightness}, ${shape.brightness}, ${shape.brightness})`;

            if (shape.isCircle) {
                this.drawCircle(ctx, centerX, centerY, shape.size, strokeStyle, shape.lineWidth);
            } else {
                this.drawHexagon(ctx, centerX, centerY, shape.size, strokeStyle, shape.lineWidth);
            }
        });

        // Draw the outer circle with a subtle stroke
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        ctx.beginPath();
        ctx.arc(centerX, centerY, this.shapes[0].size * 1.1, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = this.SCALE * 0.5;
        ctx.stroke();
    }

    drawHexagon(ctx, centerX, centerY, size, strokeStyle, lineWidth) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = i * Math.PI / 3 - Math.PI / 2;
            const x = centerX + size * Math.cos(angle);
            const y = centerY + size * Math.sin(angle);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }

    drawCircle(ctx, centerX, centerY, size, strokeStyle, lineWidth) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, size, 0, Math.PI * 2);
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }
}

// Export the class for use in other modules
//export default PatternGenerator;

const isNode = typeof module !== 'undefined' && module.exports;
if (isNode) { module.exports = PatternGenerator; }
//module.exports = PatternGenerator;
