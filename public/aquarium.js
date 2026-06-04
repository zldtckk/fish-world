// Aquarium fish rendering engine — canvas-based with column-by-column tail wag
const Aquarium = {
  stage: null,
  fishData: [],
  fishObjects: new Map(), // fishId → { srcCanvas, displayCanvas, state, el }
  animationId: null,
  foods: [],
  PEDUNCLE: 0.4,        // % of fish width that wags (tail portion)
  WAG_SPEED: 3,          // wag frequency multiplier
  WAG_AMP: 12,           // max pixel displacement at tail tip
  _fsCalib: null,        // fullscreen coordinate calibration cache

  init(stageElement) {
    this.stage = stageElement;
    this.stage.addEventListener('click', (e) => this.handleClick(e));
    this.stage.addEventListener('contextmenu', (e) => { e.preventDefault(); this.handleFeed(e); });
  },

  // Self-calibrate the fullscreen CSS → viewport coordinate mapping.
  // Places tiny test elements at known CSS positions and reads their actual viewport rect.
  // Result: for any viewport (vx, vy) we can compute the CSS (left, top) needed.
  calibrateFS() {
    this._fsCalib = null;
    const s = this.stage;
    if (!s.classList.contains('-fullscreen')) return;

    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;width:0;height:0;left:0;top:0;pointer-events:none';
    s.appendChild(d);
    const r0 = d.getBoundingClientRect();

    d.style.left = '100px';
    const rX = d.getBoundingClientRect();

    d.style.left = '0px';
    d.style.top = '100px';
    const rY = d.getBoundingClientRect();
    d.remove();

    // viewportX = a*left + b*top + ox
    // viewportY = c*left + d*top + oy
    const a = (rX.left - r0.left) / 100;
    const b = (rY.left - r0.left) / 100;
    const c = (rX.top - r0.top) / 100;
    const d_ = (rY.top - r0.top) / 100;
    const ox = r0.left;
    const oy = r0.top;

    const det = a * d_ - b * c;
    if (Math.abs(det) < 0.001) return;

    this._fsCalib = {
      invA: d_ / det, invB: -b / det,
      invC: -c / det, invD: a / det,
      ox, oy,
      // vY direction: positive c means "CSS left ↑ → viewportY ↑ → down is positive"
      yDir: c > 0 ? 1 : -1,
    };
  },

  // Convert viewport coordinates → stage CSS { left, top } in fullscreen mode
  viewportToStage(vx, vy) {
    const cal = this._fsCalib;
    if (!cal) return { left: vx, top: vy };
    const dx = vx - cal.ox;
    const dy = vy - cal.oy;
    return {
      left: cal.invA * dx + cal.invB * dy,
      top:  cal.invC * dx + cal.invD * dy,
    };
  },

  async loadFishIntoAquarium(fishList) {
    const list = fishList || this.fishData;
    this.fishData = list;

    // Fetch all fish details in parallel so one slow response doesn't block others
    const promises = list.map(fish => this.addFish(fish));
    await Promise.allSettled(promises);
    this.startAnimation();
  },

  async addFish(fish, index) {
    // Fetch full image data with timeout
    let imageData;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`/api/fish/${fish.id}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      const full = await res.json();
      imageData = full.image_data;
    } catch (e) { return; }
    if (!imageData) return;

    // Load image with error handling
    let img;
    try {
      img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('image load failed'));
        i.src = imageData;
        // Timeout safeguard
        setTimeout(() => reject(new Error('image load timeout')), 30000);
      });
    } catch (e) {
      console.warn('Skipping fish ' + fish.id + ': ' + e.message);
      return;
    }

    // Pre-render source at final display size on a canvas (for fast column access)
    const displayW = 48 + Math.random() * 56; // 48-104px wide
    const aspect = img.naturalHeight / img.naturalWidth;
    const displayH = Math.round(displayW * aspect);

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = displayW;
    srcCanvas.height = displayH;
    const srcCtx = srcCanvas.getContext('2d');

    // Draw image directly (no white fill — fish already has transparent background)
    srcCtx.drawImage(img, 0, 0, displayW, displayH);

    // Display canvas — use nearest-neighbor to avoid sub-pixel bleed between columns
    const displayCanvas = document.createElement('canvas');
    displayCanvas.className = 'aquarium-fish-canvas';
    displayCanvas.width = displayW;
    displayCanvas.height = displayH;
    displayCanvas.style.width = displayW + 'px';
    displayCanvas.style.height = displayH + 'px';
    const dispCtx = displayCanvas.getContext('2d');
    dispCtx.imageSmoothingEnabled = false;

    // Container element
    const el = document.createElement('div');
    el.className = 'aquarium-fish';
    el.dataset.fishId = fish.id;
    el.appendChild(displayCanvas);
    el.style.width = displayW + 'px';
    el.style.height = displayH + 'px';

    const stageH = this.stage.offsetHeight;
    const state = {
      x: -displayW - Math.random() * 100,
      y: 20 + Math.random() * (stageH - displayH - 40),
      direction: 1,
      speed: 0.2 + Math.random() * 0.4,
      targetY: 0,
      phase: Math.random() * Math.PI * 2,
      time: Math.random() * 1000,
      feeding: false,
      feedTarget: null,
      peduncle: this.PEDUNCLE,
    };
    state.targetY = state.y;

    this.stage.appendChild(el);
    this.fishObjects.set(fish.id, { srcCanvas, displayCanvas, state, el, displayW, displayH });
  },

  startAnimation() {
    const stage = this.stage;
    let stageW = stage.offsetWidth;
    let stageH = stage.offsetHeight;

    const animate = () => {
      // Detect whether the stage is visually rotated (mobile fullscreen, 90° rotation)
      // vs. just fullscreen (desktop, no rotation). Use window width to match the CSS
      // media query @media (max-width: 768px) that applies the rotate(90deg) transform.
      const fs = stage.classList.contains('-fullscreen');
      const rotated = fs && window.innerWidth <= 768 && window.innerWidth > window.innerHeight;
      const bw = rotated ? stageH : stageW; // visual width
      const bh = rotated ? stageW : stageH; // visual height

      // Update food particles
      this.foods = this.foods.filter(f => {
        f.y += f.vy;
        f.vy += 0.02;
        f.life--;
        if (rotated) {
          f.el.style.top = f.x + 'px';
          f.el.style.left = f.y + 'px';
        } else {
          f.el.style.left = f.x + 'px';
          f.el.style.top = f.y + 'px';
        }
        f.el.style.opacity = Math.min(1, f.life / 30);
        if (f.life <= 0) { f.el.remove(); return false; }
        return true;
      });

      for (const [fishId, obj] of this.fishObjects) {
        const { srcCanvas, displayCanvas, state, el, displayW, displayH } = obj;
        if (!state || !el) continue;

        state.time += 0.016; // ~60fps increment

        // Feeding behavior
        if (this.foods.length > 0) {
          let nearest = null, nearDist = 300;
          for (const f of this.foods) {
            const dx = f.x - state.x;
            const dy = f.y - state.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < nearDist) { nearDist = dist; nearest = f; }
          }
          if (nearest) {
            state.feeding = true;
            state.feedTarget = nearest;
            const dx = nearest.x - state.x;
            state.direction = dx > 0 ? 1 : -1;
            state.speed = Math.min(1.2, state.speed + 0.005);
          }
        } else {
          state.feeding = false;
          state.speed += (0.2 + Math.sin(state.time * 0.3) * 0.2 - state.speed) * 0.003;
        }

        // Movement
        if (!state.feeding) {
          state.x += state.speed * state.direction;
          const waveY = Math.sin(state.time * 5 + state.phase) * (4 + state.speed * 4);
          state.y += (state.targetY - state.y) * 0.002;

          if (state.x > bw + displayW) {
            state.x = -displayW;
            state.targetY = 20 + Math.random() * (bh - displayH - 40);
          }
          if (state.x < -displayW * 2) {
            state.x = bw + displayW;
            state.targetY = 20 + Math.random() * (bh - displayH - 40);
          }

          if (rotated) {
            el.style.left = (state.y + waveY) + 'px';
            el.style.top = state.x + 'px';
          } else {
            el.style.top = (state.y + waveY) + 'px';
            el.style.left = state.x + 'px';
          }

          if (Math.random() < 0.0005) {
            state.direction *= -1;
            state.targetY = 20 + Math.random() * (bh - displayH - 40);
          }
        } else {
          const dx = (state.feedTarget?.x || 0) - state.x;
          const dy = (state.feedTarget?.y || 0) - state.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 3) {
            state.x += (dx / dist) * state.speed;
            state.y += (dy / dist) * state.speed;
          }
          if (rotated) {
            el.style.left = state.y + 'px';
            el.style.top = state.x + 'px';
          } else {
            el.style.top = state.y + 'px';
            el.style.left = state.x + 'px';
          }
        }

        // Z-index based on visual depth
        el.style.zIndex = rotated
          ? Math.floor(state.x + displayW)
          : Math.floor(state.y + displayH);

        // === Render fish with tail wag (column-by-column) ===
        const dispCtx = displayCanvas.getContext('2d');
        this.renderFishWithWag(displayCanvas, srcCanvas, state, dispCtx, rotated);
      }

      this.animationId = requestAnimationFrame(animate);
    };

    this.animationId = requestAnimationFrame(animate);
  },

  renderFishWithWag(displayCanvas, srcCanvas, state, ctx, flipDir) {
    if (!ctx) ctx = displayCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const w = displayCanvas.width;
    const h = displayCanvas.height;
    const tailEnd = Math.floor(w * state.peduncle);
    const time = state.time;
    const phase = state.phase;
    // In fullscreen mode (90° rotation), the visual direction is inverted,
    // so flip rendering to match the actual movement direction
    const dir = flipDir ? -state.direction : state.direction;

    ctx.clearRect(0, 0, w, h);

    // Draw column by column — tail columns get horizontal wiggle (integer-only to avoid gaps)
    for (let i = 0; i < w; i++) {
      let isTail, t, wiggle, srcCol;
      if (dir === 1) { // facing right — tail is on the left
        isTail = i < tailEnd;
        t = isTail ? (tailEnd - i) / tailEnd : 0;
        wiggle = isTail ? Math.round(Math.sin(time * this.WAG_SPEED + phase + t * 2) * t * this.WAG_AMP) : 0;
        srcCol = i;
      } else { // facing left — tail is on the right
        isTail = i >= w - tailEnd;
        t = isTail ? (i - (w - tailEnd)) / tailEnd : 0;
        wiggle = isTail ? Math.round(Math.sin(time * this.WAG_SPEED + phase + t * 2) * t * this.WAG_AMP) : 0;
        srcCol = w - i - 1;
      }

      ctx.drawImage(srcCanvas, srcCol, 0, 1, h, i + wiggle, 0, 1, h);
    }
  },

  stopAnimation() {
    if (this.animationId) { cancelAnimationFrame(this.animationId); this.animationId = null; }
  },

  clear() {
    this.stopAnimation();
    for (const [fishId, obj] of this.fishObjects) { obj.el.remove(); }
    this.fishObjects.clear();
    this.foods.forEach(f => f.el.remove());
    this.foods = [];
  },

  handleClick(e) {
    const fishEl = e.target.closest('.aquarium-fish');
    if (!fishEl) return;

    if (e.shiftKey) {
      const state = this.fishObjects.get(fishEl.dataset.fishId)?.state;
      if (state) state.direction *= -1;
      return;
    }

    openFishModal(fishEl.dataset.fishId);
  },

  feedCenter() {
    const rect = this.stage.getBoundingClientRect();
    const rotated = this.stage.classList.contains('-fullscreen') && window.innerWidth <= 768 && window.innerWidth > window.innerHeight;
    let cx, cy, yScale;
    if (rotated) {
      this.calibrateFS();
      const vx = rect.width * (0.3 + Math.random() * 0.4);
      const vy = rect.height * (0.2 + Math.random() * 0.4);
      const stage = this.viewportToStage(vx, vy);
      cx = stage.top;   // → CSS top in FS
      cy = stage.left;  // → CSS left in FS
      yScale = this._fsCalib ? this._fsCalib.yDir : 1;
    } else {
      cx = rect.width * (0.3 + Math.random() * 0.4);
      cy = rect.height * (0.2 + Math.random() * 0.4);
      yScale = 1;
    }
    for (let i = 0; i < 12; i++) {
      const el = document.createElement('div');
      el.style.cssText = `
        position: absolute; width: 5px; height: 5px;
        border-radius: 50%;
        background: radial-gradient(circle at 30% 30%, #ff6b6b, #c0392b);
        pointer-events: none; z-index: 100;
        box-shadow: 0 0 3px rgba(255,107,107,0.5);
        left: ${cx + (Math.random() - 0.5) * 8}px;
        top: ${cy + (Math.random() - 0.5) * 8}px;
      `;
      this.stage.appendChild(el);
      this.foods.push({
        x: cx + (Math.random() - 0.5) * 8,
        y: cy + (Math.random() - 0.5) * 8,
        vy: -0.3 * yScale - Math.random() * 0.3 * yScale,
        life: 100 + Math.random() * 40,
        el
      });
    }
  },

  handleFeed(e) {
    const rect = this.stage.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    let yScale = 1;

    const rotated = this.stage.classList.contains('-fullscreen') && window.innerWidth <= 768 && window.innerWidth > window.innerHeight;
    if (rotated) {
      this.calibrateFS();
      const stage = this.viewportToStage(x, y);
      x = stage.top;   // → CSS top in FS
      y = stage.left;  // → CSS left in FS
      yScale = this._fsCalib ? this._fsCalib.yDir : 1;
    }

    for (let i = 0; i < 10; i++) {
      const el = document.createElement('div');
      el.style.cssText = `
        position: absolute; width: 5px; height: 5px;
        border-radius: 50%;
        background: radial-gradient(circle at 30% 30%, #ff6b6b, #c0392b);
        pointer-events: none; z-index: 100;
        box-shadow: 0 0 3px rgba(255,107,107,0.5);
        left: ${x + (Math.random() - 0.5) * 8}px;
        top: ${y + (Math.random() - 0.5) * 8}px;
      `;
      this.stage.appendChild(el);
      this.foods.push({
        x: x + (Math.random() - 0.5) * 8,
        y: y + (Math.random() - 0.5) * 8,
        vy: -0.3 * yScale - Math.random() * 0.3 * yScale,
        life: 100 + Math.random() * 40,
        el
      });
    }
  }
};
