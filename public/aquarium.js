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

  init(stageElement) {
    this.stage = stageElement;
    this.stage.addEventListener('click', (e) => this.handleClick(e));
    this.stage.addEventListener('contextmenu', (e) => { e.preventDefault(); this.handleFeed(e); });
  },

  async loadFishIntoAquarium() {
    const res = await fetch('/api/fish?sort=new&limit=20');
    const data = await res.json();
    this.fishData = data.fish;

    for (let i = 0; i < this.fishData.length; i++) {
      await this.addFish(this.fishData[i], i);
    }
    this.startAnimation();
  },

  async addFish(fish, index) {
    // Fetch full image data
    let imageData;
    try {
      const res = await fetch(`/api/fish/${fish.id}`);
      const full = await res.json();
      imageData = full.image_data;
    } catch (e) { return; }
    if (!imageData) return;

    // Load image
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = imageData;
    });

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
    const stageW = stage.offsetWidth;
    const stageH = stage.offsetHeight;

    const animate = () => {
      // Update food particles
      this.foods = this.foods.filter(f => {
        f.y += f.vy;
        f.vy += 0.02;
        f.life--;
        f.el.style.left = f.x + 'px';
        f.el.style.top = f.y + 'px';
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

          if (state.x > stageW + displayW) {
            state.x = -displayW;
            state.targetY = 20 + Math.random() * (stageH - displayH - 40);
          }
          if (state.x < -displayW * 2) {
            state.x = stageW + displayW;
            state.targetY = 20 + Math.random() * (stageH - displayH - 40);
          }

          el.style.top = (state.y + waveY) + 'px';

          if (Math.random() < 0.0005) {
            state.direction *= -1;
            state.targetY = 20 + Math.random() * (stageH - displayH - 40);
          }
        } else {
          const dx = (state.feedTarget?.x || 0) - state.x;
          const dy = (state.feedTarget?.y || 0) - state.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 3) {
            state.x += (dx / dist) * state.speed;
            state.y += (dy / dist) * state.speed;
          }
          el.style.top = state.y + 'px';
        }

        el.style.left = state.x + 'px';
        el.style.zIndex = Math.floor(state.y + displayH);

        // === Render fish with tail wag (column-by-column) ===
        const dispCtx = displayCanvas.getContext('2d');
        this.renderFishWithWag(displayCanvas, srcCanvas, state, dispCtx);
      }

      this.animationId = requestAnimationFrame(animate);
    };

    this.animationId = requestAnimationFrame(animate);
  },

  renderFishWithWag(displayCanvas, srcCanvas, state, ctx) {
    if (!ctx) ctx = displayCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const w = displayCanvas.width;
    const h = displayCanvas.height;
    const tailEnd = Math.floor(w * state.peduncle);
    const time = state.time;
    const phase = state.phase;
    const dir = state.direction;

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

  handleFeed(e) {
    const rect = this.stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

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
        vy: -0.3 - Math.random() * 0.3,
        life: 100 + Math.random() * 40,
        el
      });
    }
  }
};
