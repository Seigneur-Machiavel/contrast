class WelcomeAnimationBlob {
    constructor(canvasElement, width, height, colorText) {
        this.colorText = colorText;
        this.canvas = canvasElement;
        this.setCanvasSize(width, height);
        this.ctx = canvasElement.getContext('2d');
        this.ob = [];

        this.dotAppearTimings = [3000, 1000, 1000, 200, 200, 200];
        this.rndMaxDelay = 2000;
        this.paused = false;
    }
    setCanvasSize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
    }
    newBlob(amount = 1) {
        let a,b,c,d;
        let tx = this.canvas.width/2;
        let ty = this.canvas.height/2;
    
        for(a=0;a<amount;a++){
            b={};
            c=Math.PI*2* Math.random();
            d=Math.random()*1000;
            b.x=tx+Math.cos(c)*d;
            b.y=ty+Math.sin(c)*d;
            b.rx=b.ry=0;
            b.typ=(Math.random()*360)|0;
            this.ob.push(b);
        }
    }
    start() {
        this.initBlobAppearSequence();
        requestAnimationFrame(() => this.frameAction());
    }
    async initBlobAppearSequence() {
        for (let i = 0; i < 50; i++) {
            if (this.paused) {
                await new Promise(resolve => setTimeout(resolve, 20));
                i--;
                continue;
            }

            this.newBlob(1);

            const rndDelay = Math.random() * this.rndMaxDelay;
            const delay = this.dotAppearTimings[i] || rndDelay;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    async frameAction() {
        while (this.paused) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        const colorText = this.colorText;
        const ob = this.ob;
        const tx=this.canvas.width/2;
        const ty=this.canvas.height/2;

        let count=0;
        let a,b,c,d,e,f,g,h,x,y,abs,pe,tim;
        /** @type {CanvasRenderingContext2D} */
        const ctx = this.ctx;
        ctx.globalCompositeOperation = "source-over";
    
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
        tim=count/270;
        abs=Math.abs;
        pe=1.2+Math.sin(tim/14.7)*0.87;
        
        for(a=0;a<ob.length;a++){
            b=ob[a];
            b.rx*=0.2;
            b.ry*=0.2;
            b.s=0.72+Math.sin((b.typ/360)*Math.PI*2+tim)/2;
            b.s*=b.s;
        }
        for(a=0;a<ob.length;a++){
            b=ob[a];
            for(c=a+1;c<ob.length;c++){
                d=ob[c];
                x=b.x-d.x;
                y=b.y-d.y;
                e=(b.typ-d.typ)/360;
                if(e<0)e+=1;
                if(e>0.52)e=1-e;
                e*=pe;
                if(e>1)continue;
                e=0.2+e*1.2;
                h=120*e*(b.s+d.s+0.4)/pe;
                if(abs(x)>h || abs(y)>h)continue;
                e=Math.pow(x*x+y*y,0.68);
                if(e<h){
                    e=(h-e)/h;
                    e*=e/10;
                    x*=e;
                    y*=e;
                    b.rx+=x;
                    b.ry+=y;
                    d.rx-=x;
                    d.ry-=y;
                }
            }
        }
        for(a=0;a<ob.length;a++){
            b=ob[a];
            x=b.x-tx;
            y=b.y-ty;
            e=Math.pow(x*x+y*y,0.5);
            b.rx-=x*e/2000; // 2750
            b.ry-=y*e/2000; // 2750
            b.x+=b.rx;
            b.y+=b.ry;
        }
        for(a=0;a<ob.length;a++){
            b=ob[a];
            ctx.strokeStyle=ctx.fillStyle=colorText;
            ctx.beginPath();
            if (a === 0) {
                ctx.arc(b.x,b.y,10,0,Math.PI*2,0);
            } else {
                ctx.arc(b.x,b.y,10*(b.s+0.8),0,Math.PI*2,0);
            }
            ctx.fill();
            ctx.stroke();
        }
        count++;
        requestAnimationFrame(() => this.frameAction());
    }
}
class ParticleAnimation {
    // ==================== Configuration Objects ====================
    systemConfig = {
        motion: {
            flowSpeed: 0.65,
            complexity: 3,
            drift: 0.05
        },
        field: {
            intensity: 0.8,
            patterns: ['spiral', 'wave', 'circular'],
            blendStrength: 0.3
        },
        detail: {
            levels: 3,
            scale: 1.5,
            rotation: Math.PI / 6
        }
    };
    canvasConfig = {
        backgroundColor: 'rgb(255, 255, 255)', // Default, will be set in init
        resizeDebounce: 100,
    };
    waveConfig = {
        scale1: 0.03,
        scale2: 0.02,
        scale3: 0.01,
        amplitude: 8,
    };
    particleConfig = {
        number: 128,
        radius: 64,
        sizeCategories: {
            probabilities: {
                huge: 0.08,
                large: 0.15,
                medium: 0.27,
                small: 0.50,
            },
            multipliers: {
                huge: { min: .5, max: 1 },
                large: { min: .3, max: .5 },
                medium: { min: .2, max: .3 },
                small: { min: .1, max: .2 },
            },
        },
        sizeRange: [2, 16],
        pulsing: {
            frequencyRange: [0.5, 4],
            amplitudeRange: [0.8, 2.0],
            waveforms: ['sin', 'triangle'],
        },
        colors: {
            primary: 'rgb(0, 0, 0)', // Default, will be set in init
        },
    };
    connectionConfig = {
        maxConnections: 8,
        distanceThreshold: 250,
        decayRange: [0.002, 0.008],
        thicknessRange: [0.1, 1],
        colors: {
            primary: 'rgb(0, 0, 0)', // Default, will be set in init
        },
        tetherPhysics: {
            tension: 0.5,
            dampening: 0.7,
            rigidity: 0.05,
            segments: 8,
            noiseInfluence: 0.5
        },
        shooting: {
            speed: 0.02,
            fadeDuration: 60,
        }
    };
    animationConfig = {
        timeIncrement: 0.01,
        fps: 60,
    };

    // ==================== Instance Properties ====================
    animationColor1 = '255, 255, 255'; // Background color
    animationColor2 = '0, 0, 0';       // Particle and connection color
    canvas = null;
    ctx = null;
    simplex = null;
    time = 0;
    particles = [];
    connections = [];
    animationId = null;

    // ==================== Utility Functions ====================
    static map(value, start1, stop1, start2, stop2) {
        return start2 + ((stop2 - start2) * ((value - start1) / (stop1 - start1)));
    }
    static getWaveform(type, value) {
        switch (type) {
            case 'triangle':
                return Math.asin(Math.sin(value)) / (Math.PI / 2);
            default:
                return Math.sin(value);
        }
    }

    // ==================== Motion Pattern Functions ====================
    spiralPattern(x, y, z, t) {
        const u = Math.cos(x) * Math.sin(2 * y);
        const v = Math.sin(x) * Math.sin(2 * y);
        const w = Math.cos(2 * y);
        return (u + v + w) * Math.sin(t);
    }
    wavePattern(x, y, z, t) {
        const u = (1 + (y / 2) * Math.cos(x / 2)) * Math.cos(x);
        const v = (1 + (y / 2) * Math.cos(x / 2)) * Math.sin(x);
        const w = (y / 2) * Math.sin(x / 2);
        return (u * v * w) * Math.cos(t);
    }
    circularPattern(s, t, p, q) {
        const r = Math.cos(q * s) + 2;
        const x = r * Math.cos(p * s);
        const y = r * Math.sin(p * s);
        const z = -Math.sin(q * s);
        return { x, y, z };
    }
    complexMotion(x, y, z, t) {
        const wave1 = Math.sin(x * this.waveConfig.scale1 + t) *
                      Math.cos(y * this.waveConfig.scale1 + t) * 0.5;
        const wave2 = Math.sin(x * this.waveConfig.scale2 - t * 0.7) *
                      Math.cos(z * this.waveConfig.scale2 + t * 1.2) * 0.3;
        const wave3 = Math.sin(y * this.waveConfig.scale3 + t * 1.1) *
                      Math.cos(z * this.waveConfig.scale3 - t * 0.9) * 0.2;

        const spiral = this.spiralPattern(x * 0.01, y * 0.01, z * 0.01, t) *
                       this.systemConfig.field.intensity;
        const wave = this.wavePattern(x * 0.01, y * 0.01, z * 0.01, t) *
                     this.systemConfig.field.intensity;
        const flow = Math.tanh(Math.sin(x * 0.02 + t) * Math.cos(y * 0.02 - t)) *
                     this.systemConfig.motion.flowSpeed;
        const noise = this.simplex.noise4D(x * 0.01, y * 0.01, z * 0.01, t) *
                      this.systemConfig.field.blendStrength;

        return (wave1 + wave2 + wave3) * this.waveConfig.amplitude +
               spiral * Math.sin(t) +
               wave * Math.cos(t) +
               flow +
               noise;
    }

    // ==================== Initialization ====================
    /** Initializes the animation with a given canvas element.
     * @param {HTMLCanvasElement} canvasElement - The canvas element to render the animation on. */
    init(canvasElement) {
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');
        this.simplex = new SimplexNoise();

        // Set colors based on instance properties
        this.canvasConfig.backgroundColor = `rgb(${this.animationColor1})`;
        this.particleConfig.colors.primary = `rgb(${this.animationColor2})`;
        this.connectionConfig.colors.primary = `rgb(${this.animationColor2})`;

        this.initParticles();
        this.animate();
    }

    /**
     * Creates a debounced version of a function.
     * @param {Function} func - The function to debounce.
     * @param {number} wait - The debounce delay in milliseconds.
     * @returns {Function} - The debounced function.
     */
    debounce(func, wait) {
        let timeout;
        return () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                func();
            }, wait);
        };
    }

    // ==================== Particle Class ====================
    /**
     * Represents a single particle in the animation.
     */
    Particle = class {
        /**
         * Creates a new Particle instance.
         * @param {ParticleAnimation} animation - Reference to the parent ParticleAnimation instance.
         */
        constructor(animation) {
            this.animation = animation;
            this.reset();
            this.phi = Math.random() * Math.PI * 2;
            this.theta = Math.random() * Math.PI;
            this.z = 0;

            this.sizeCategory = this.assignSizeCategory(Math.random());
            this.sizeMultiplier = this.getSizeMultiplier();
            this.baseSize = ParticleAnimation.map(
                Math.random(),
                0,
                1,
                this.animation.particleConfig.sizeRange[0],
                this.animation.particleConfig.sizeRange[1]
            ) * this.sizeMultiplier;

            this.noiseOffsetX = Math.random() * 1000;
            this.noiseOffsetY = Math.random() * 1000;

            this.pulseFrequency = ParticleAnimation.map(
                Math.random(),
                0,
                1,
                this.animation.particleConfig.pulsing.frequencyRange[0],
                this.animation.particleConfig.pulsing.frequencyRange[1]
            );
            this.pulseAmplitude = ParticleAnimation.map(
                Math.random(),
                0,
                1,
                this.animation.particleConfig.pulsing.amplitudeRange[0],
                this.animation.particleConfig.pulsing.amplitudeRange[1]
            );
            this.pulsePhase = Math.random() * Math.PI * 2;
            this.waveformType = this.animation.particleConfig.pulsing.waveforms[
                Math.floor(Math.random() * this.animation.particleConfig.pulsing.waveforms.length)
            ];

            this.deformationPhase = Math.random() * Math.PI * 2;
            this.deformationFrequency = Math.random() * 2 + 1;

            this.motionPhase = Math.random() * Math.PI * 2;
            this.motionX = Math.floor(Math.random() * 3) + 2;
            this.motionY = Math.floor(Math.random() * 3) + 3;
        }

        /**
         * Assigns a size category based on a random value.
         * @param {number} rand - A random number between 0 and 1.
         * @returns {string} - The size category.
         */
        assignSizeCategory(rand) {
            const { probabilities } = this.animation.particleConfig.sizeCategories;
            const cumulative = [];
            let sum = 0;
            for (let key in probabilities) {
                sum += probabilities[key];
                cumulative.push({ category: key, threshold: sum });
            }
            for (let item of cumulative) {
                if (rand < item.threshold) return item.category;
            }
            return 'small';
        }

        /**
         * Determines the size multiplier based on the size category.
         * @returns {number} - The size multiplier.
         */
        getSizeMultiplier() {
            const { multipliers } = this.animation.particleConfig.sizeCategories;
            const category = this.sizeCategory;
            const range = multipliers[category];
            return ParticleAnimation.map(Math.random(), 0, 1, range.min, range.max);
        }

        /**
         * Resets the particle's position and properties.
         */
        reset() {
            this.radius = this.animation.particleConfig.radius;
            this.updatePosition();
        }

        /**
         * Updates the particle's position based on motion patterns.
         */
        updatePosition() {
            this.phi += 0.001;
            this.z = this.radius * Math.cos(this.theta);
            const projectedRadius = this.radius * Math.sin(this.theta);
            this.x = this.animation.canvas.width / 2 + projectedRadius * Math.cos(this.phi);
            this.y = this.animation.canvas.height / 2 + projectedRadius * Math.sin(this.phi);

            const circularMotion = this.animation.circularPattern(
                this.motionPhase,
                this.animation.time,
                this.motionX,
                this.motionY
            );
            const motionInfluence = this.animation.systemConfig.motion.drift;

            this.x += circularMotion.x * motionInfluence * this.radius;
            this.y += circularMotion.y * motionInfluence * this.radius;
            this.z += circularMotion.z * motionInfluence * this.radius;

            this.motionPhase += 0.001;
            this.scale = Math.tanh(ParticleAnimation.map(this.z, -this.radius, this.radius, -1, 1)) * 0.5 + 0.7;
        }

        /**
         * Updates the particle's state.
         */
        update() {
            this.updatePosition();
            const motion = this.animation.complexMotion(this.x, this.y, this.z, this.animation.time);

            let noise = 0;
            let amplitude = 1;
            let frequency = 1;

            for (let i = 0; i < this.animation.systemConfig.detail.levels; i++) {
                noise += amplitude * this.animation.simplex.noise3D(
                    this.x * frequency * 0.01,
                    this.y * frequency * 0.01,
                    this.animation.time * 0.2
                );
                amplitude *= 0.5;
                frequency *= this.animation.systemConfig.detail.scale;
            }

            const flowEffect = Math.sin(this.z * this.animation.systemConfig.motion.flowSpeed + this.animation.time);
            const blendEffect = Math.cos(noise * this.animation.systemConfig.field.intensity);

            this.x += (motion * 5 + noise * 4) * this.scale * flowEffect;
            this.y += (motion * 5 + noise * 4) * this.scale * blendEffect;
        }

        /**
         * Draws the particle on the canvas.
         */
        draw() {
            const scaledSize = this.baseSize * this.scale;
            const mainPulse = ParticleAnimation.getWaveform(
                this.waveformType,
                this.animation.time * this.pulseFrequency + this.pulsePhase
            );
            const secondaryPulse = Math.sin(this.animation.time * this.deformationFrequency + this.deformationPhase);
            const deformation = mainPulse * this.pulseAmplitude + secondaryPulse * 0.3;

            const currentSizeX = scaledSize * (1 + deformation * 0.2);
            const currentSizeY = scaledSize * (1 - deformation * 0.15);

            this.animation.ctx.save();
            this.animation.ctx.translate(this.x, this.y);
            this.animation.ctx.rotate(this.animation.time * 0.5 + this.pulsePhase);

            this.animation.ctx.beginPath();
            this.animation.ctx.ellipse(0, 0, currentSizeX, currentSizeY, 0, 0, Math.PI * 2);
            this.animation.ctx.fillStyle = this.animation.particleConfig.colors.primary;
            this.animation.ctx.fill();

            this.animation.ctx.restore();
        }
    };

    // ==================== Connection Class ====================
    /**
     * Represents a connection between two particles.
     */
    Connection = class {
        /**
         * Creates a new Connection instance.
         * @param {ParticleAnimation} animation - Reference to the parent ParticleAnimation instance.
         * @param {Particle} p1 - The first particle.
         * @param {Particle} p2 - The second particle.
         */
        constructor(animation, p1, p2) {
            this.animation = animation;
            this.p1 = p1;
            this.p2 = p2;
            this.life = 1;
            this.decay = ParticleAnimation.map(
                Math.random(),
                0,
                1,
                this.animation.connectionConfig.decayRange[0],
                this.animation.connectionConfig.decayRange[1]
            );
            this.pulsePhase = Math.random() * Math.PI * 2;
            this.thickness = ParticleAnimation.map(
                Math.random(),
                0,
                1,
                this.animation.connectionConfig.thicknessRange[0],
                this.animation.connectionConfig.thicknessRange[1]
            );
            this.waveformType = this.animation.particleConfig.pulsing.waveforms[
                Math.floor(Math.random() * this.animation.particleConfig.pulsing.waveforms.length)
            ];

            const { tetherPhysics } = this.animation.connectionConfig;
            this.segments = tetherPhysics.segments;
            this.points = Array(this.segments).fill().map(() => ({
                x: 0, y: 0,
                vx: 0, vy: 0,
                ax: 0, ay: 0
            }));

            this.tension = tetherPhysics.tension;
            this.dampening = tetherPhysics.dampening;
            this.rigidity = tetherPhysics.rigidity;
            this.noiseInfluence = tetherPhysics.noiseInfluence;

            this.flowOffset = Math.random() * 1000;
            this.turbulenceScale = Math.random() * 0.3 + 0.7;
            this.timeScale = Math.random() * 0.5 + 0.75;

            this.updateControlPoints();

            this.progress = 0;
            this.speed = this.animation.connectionConfig.shooting.speed;
            this.fading = false;
            this.fadeCounter = 0;
        }

        /**
         * Initializes control points between the two particles.
         */
        updateControlPoints() {
            const dx = (this.p2.x - this.p1.x) / (this.segments - 1);
            const dy = (this.p2.y - this.p1.y) / (this.segments - 1);

            this.points.forEach((point, i) => {
                point.x = this.p1.x + dx * i;
                point.y = this.p1.y + dy * i;
                point.vx = (Math.random() - 0.5) * 0.5;
                point.vy = (Math.random() - 0.5) * 0.5;
            });
        }

        /**
         * Updates the physics of the connection.
         */
        updatePhysics() {
            const dt = 1 / 60;

            for (let i = 1; i < this.segments - 1; i++) {
                const point = this.points[i];
                const prevPoint = this.points[i - 1];
                const nextPoint = this.points[i + 1];

                point.ax = 0;
                point.ay = 0;

                const dx1 = prevPoint.x - point.x;
                const dy1 = prevPoint.y - point.y;
                const dx2 = nextPoint.x - point.x;
                const dy2 = nextPoint.y - point.y;

                const dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

                if (dist1 === 0 || dist2 === 0) continue;

                const springForce1 = this.tension * (dist1 - 30);
                const springForce2 = this.tension * (dist2 - 30);

                point.ax += (dx1 / dist1) * springForce1 + (dx2 / dist2) * springForce2;
                point.ay += (dy1 / dist1) * springForce1 + (dy2 / dist2) * springForce2;

                const turbulence = this.animation.simplex.noise3D(
                    point.x * 0.01 + this.flowOffset,
                    point.y * 0.01,
                    this.animation.time * this.timeScale
                ) * this.turbulenceScale;

                const noiseX = this.animation.simplex.noise3D(
                    point.x * 0.02 + this.animation.time,
                    point.y * 0.02,
                    this.flowOffset
                ) * this.noiseInfluence;

                const noiseY = this.animation.simplex.noise3D(
                    point.x * 0.02,
                    point.y * 0.02 + this.animation.time,
                    this.flowOffset + 100
                ) * this.noiseInfluence;

                point.ax += noiseX * turbulence;
                point.ay += noiseY * turbulence;

                point.vx += point.ax * dt;
                point.vy += point.ay * dt;

                point.vx *= this.dampening;
                point.vy *= this.dampening;

                point.x += point.vx;
                point.y += point.vy;

                const idealX = this.p1.x + (this.p2.x - this.p1.x) * (i / (this.segments - 1));
                const idealY = this.p1.y + (this.p2.y - this.p1.y) * (i / (this.segments - 1));

                point.x += (idealX - point.x) * this.rigidity;
                point.y += (idealY - point.y) * this.rigidity;
            }

            // Ensure the first and last points are anchored to the particles
            this.points[0].x = this.p1.x;
            this.points[0].y = this.p1.y;
            this.points[this.segments - 1].x = this.p2.x;
            this.points[this.segments - 1].y = this.p2.y;
        }

        /**
         * Updates the connection's state.
         * @returns {boolean} - Returns true if the connection is still active.
         */
        update() {
            if (!this.fading) {
                this.progress += this.speed;
                if (this.progress >= 1) {
                    this.progress = 1;
                    this.fading = true;
                }
            } else {
                this.fadeCounter++;
                if (this.fadeCounter >= this.animation.connectionConfig.shooting.fadeDuration) {
                    this.life -= this.decay;
                }
            }

            this.updatePhysics();
            return this.life > 0;
        }

        /**
         * Draws the connection on the canvas.
         */
        draw() {
            const dx = this.p2.x - this.p1.x;
            const dy = this.p2.y - this.p1.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > this.animation.connectionConfig.distanceThreshold) return;

            const pulse = ParticleAnimation.getWaveform(
                this.waveformType,
                this.animation.time * 2 + this.pulsePhase
            );
            const glowIntensity = 0.5 + pulse * 0.5;

            this.animation.ctx.save();

            // Create gradient for the connection
            const gradient = this.animation.ctx.createLinearGradient(
                this.p1.x, this.p1.y,
                this.p2.x, this.p2.y
            );
            gradient.addColorStop(0, `rgba(${this.animation.animationColor2}, ${this.life * glowIntensity})`);
            gradient.addColorStop(0.5, `rgba(${this.animation.animationColor2}, ${this.life * 0.8 * glowIntensity})`);
            gradient.addColorStop(1, `rgba(${this.animation.animationColor2}, ${this.life * glowIntensity})`);

            this.animation.ctx.beginPath();
            const currentSegments = Math.floor(this.segments * this.progress);

            if (currentSegments < 2) {
                this.animation.ctx.restore();
                return;
            }

            this.animation.ctx.moveTo(this.points[0].x, this.points[0].y);

            for (let i = 1; i < currentSegments; i++) {
                const xc = (this.points[i].x + this.points[i - 1].x) / 2;
                const yc = (this.points[i].y + this.points[i - 1].y) / 2;
                this.animation.ctx.quadraticCurveTo(
                    this.points[i - 1].x,
                    this.points[i - 1].y,
                    xc, yc
                );
            }

            if (currentSegments < this.segments) {
                const lastFull = this.points[currentSegments - 1];
                const nextPoint = this.points[currentSegments];
                if (nextPoint) {
                    const remaining = (this.progress * this.segments) - currentSegments;
                    this.animation.ctx.quadraticCurveTo(
                        lastFull.x,
                        lastFull.y,
                        lastFull.x + (nextPoint.x - lastFull.x) * remaining,
                        lastFull.y + (nextPoint.y - lastFull.y) * remaining
                    );
                }
            }

            // Stroke the main connection
            this.animation.ctx.strokeStyle = gradient;
            this.animation.ctx.lineWidth = this.thickness * (1 + pulse * 0.3);
            this.animation.ctx.lineCap = 'round';
            this.animation.ctx.lineJoin = 'round';
            this.animation.ctx.stroke();

            // Add glow effect
            this.animation.ctx.globalAlpha = this.life * 0.3;
            this.animation.ctx.filter = 'blur(4px)';
            this.animation.ctx.strokeStyle = `rgba(${this.animation.animationColor2}, 0.5)`;
            this.animation.ctx.lineWidth = this.thickness * 2;
            this.animation.ctx.stroke();

            // Add secondary glow
            this.animation.ctx.globalAlpha = this.life * 0.7;
            this.animation.ctx.filter = 'none';
            this.animation.ctx.strokeStyle = `rgba(${this.animation.animationColor2}, 0.8)`;
            this.animation.ctx.lineWidth = this.thickness * 0.5;
            this.animation.ctx.stroke();

            this.animation.ctx.restore();
        }
    };

    // ==================== Animation Management ====================
    /**
     * Initializes all particles.
     */
    initParticles() {
        this.particles = [];
        for (let i = 0; i < this.particleConfig.number; i++) {
            this.particles.push(new this.Particle(this));
        }
    }
    /**
     * Updates the connections between particles.
     */
    updateConnections() {
        // Remove inactive connections
        for (let i = this.connections.length - 1; i >= 0; i--) {
            if (!this.connections[i].update()) {
                this.connections.splice(i, 1);
            }
        }

        // Add new connections if below the maximum
        while (this.connections.length < this.connectionConfig.maxConnections) {
            const p1 = this.particles[Math.floor(Math.random() * this.particles.length)];
            const p2 = this.particles[Math.floor(Math.random() * this.particles.length)];

            if (p1 === p2) continue;

            let exists = this.connections.some(conn =>
                (conn.p1 === p1 && conn.p2 === p2) ||
                (conn.p1 === p2 && conn.p2 === p1)
            );
            if (exists) continue;

            this.connections.push(new this.Connection(this, p1, p2));
        }
    }

    /**
     * The main animation loop.
     */
    animate() {
        // Clear the canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Update and draw particles
        this.particles.forEach(particle => {
            particle.update();
            particle.draw();
        });

        // Update and draw connections
        this.updateConnections();
        this.connections.forEach(connection => connection.draw());

        // Increment time
        this.time += this.animationConfig.timeIncrement;

        // Request the next frame
        this.animationId = requestAnimationFrame(() => this.animate());
    }
    /**
     * Stops the animation.
     */
    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }
    /**
     * Resets the animation to its initial state.
     */
    reset() {
        this.stop();
        this.time = 0;
        this.particles = [];
        this.connections = [];
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.initParticles();
    }

    // ==================== Constructor ====================
    constructor() {
        // Configurations are already set as class fields
        // Additional initialization can be done here if necessary
    }
} // PROBABLY NOT USED

const horizontalBtnLoading = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid" width="200" height="200" style="shape-rendering: auto;display: block;width: 100%;height:200%;transform: translate(0, -25%);"><g><circle fill="#c4c4c4" r="10" cy="50" cx="84"><animate begin="0s" keySplines="0 0.5 0.5 1" values="10;0" keyTimes="0;1" calcMode="spline" dur="0.25s" repeatCount="indefinite" attributeName="r"/><animate begin="0s" values="#c4c4c4;#424242;#6e6e6e;#959595;#c4c4c4" keyTimes="0;0.25;0.5;0.75;1" calcMode="discrete" dur="1s" repeatCount="indefinite" attributeName="fill"/></circle><circle fill="#c4c4c4" r="10" cy="50" cx="16"><animate begin="0s" keySplines="0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1" values="0;0;10;10;10" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" dur="1s" repeatCount="indefinite" attributeName="r"/><animate begin="0s" keySplines="0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1" values="16;16;16;50;84" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" dur="1s" repeatCount="indefinite" attributeName="cx"/></circle><circle fill="#959595" r="10" cy="50" cx="50"><animate begin="-0.25s" keySplines="0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1" values="0;0;10;10;10" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" dur="1s" repeatCount="indefinite" attributeName="r"/><animate begin="-0.25s" keySplines="0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1" values="16;16;16;50;84" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" dur="1s" repeatCount="indefinite" attributeName="cx"/></circle><circle fill="#6e6e6e" r="10" cy="50" cx="84"><animate begin="-0.5s" keySplines="0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1" values="0;0;10;10;10" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" dur="1s" repeatCount="indefinite" attributeName="r"/><animate begin="-0.5s" keySplines="0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1" values="16;16;16;50;84" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" dur="1s" repeatCount="indefinite" attributeName="cx"/></circle><circle fill="#424242" r="10" cy="50" cx="16"><animate begin="-0.75s" keySplines="0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1" values="0;0;10;10;10" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" dur="1s" repeatCount="indefinite" attributeName="r"/><animate begin="-0.75s" keySplines="0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1;0 0.5 0.5 1" values="16;16;16;50;84" keyTimes="0;0.25;0.5;0.75;1" calcMode="spline" dur="1s" repeatCount="indefinite" attributeName="cx"/></circle><g/></g><!-- [ldio] generated by https://loading.io --></svg>';

window.WelcomeAnimationBlob = WelcomeAnimationBlob;
window.ParticleAnimation = ParticleAnimation;
window.horizontalBtnLoading = horizontalBtnLoading;

if (false) {
    module.exports = {
        WelcomeAnimationBlob,
        ParticleAnimation,
        horizontalBtnLoading
    };
}