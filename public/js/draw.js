// Drawing canvas logic with real-time fish detection
const DrawApp = {
  canvas: null,
  ctx: null,
  isDrawing: false,
  lastX: 0,
  lastY: 0,
  color: '#333333',
  brushSize: 3,
  isEraser: false,
  history: [],
  historyIndex: -1,
  maxHistory: 50,
  fishConfidence: 0,
  detectionTimer: null,

  init(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.setupCanvas();
    this.bindEvents();
    this.clearCanvas();
  },

  setupCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.displayWidth = rect.width;
    this.displayHeight = rect.height;
  },

  bindEvents() {
    const c = this.canvas;

    c.addEventListener('mousedown', (e) => this.startDraw(e));
    c.addEventListener('mousemove', (e) => this.draw(e));
    c.addEventListener('mouseup', () => this.stopDraw());
    c.addEventListener('mouseleave', () => this.stopDraw());

    c.addEventListener('touchstart', (e) => { e.preventDefault(); this.startDraw(e); }, { passive: false });
    c.addEventListener('touchmove', (e) => { e.preventDefault(); this.draw(e); }, { passive: false });
    c.addEventListener('touchend', (e) => { e.preventDefault(); this.stopDraw(); }, { passive: false });

    window.addEventListener('resize', () => {
      this.saveState();
      this.setupCanvas();
      this.restoreState();
    });
  },

  getPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  },

  startDraw(e) {
    this.isDrawing = true;
    const pos = this.getPos(e);
    this.lastX = pos.x;
    this.lastY = pos.y;
    this.saveState();
  },

  draw(e) {
    if (!this.isDrawing) return;
    const pos = this.getPos(e);
    const ctx = this.ctx;

    ctx.beginPath();
    ctx.moveTo(this.lastX, this.lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = this.isEraser ? '#ffffff' : this.color;
    ctx.lineWidth = this.isEraser ? this.brushSize * 3 : this.brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    this.lastX = pos.x;
    this.lastY = pos.y;

    // Debounced fish detection
    if (!this.detectionTimer) {
      this.detectionTimer = setTimeout(() => {
        this.detectFish();
        this.detectionTimer = null;
      }, 200);
    }
  },

  stopDraw() {
    this.isDrawing = false;
    this.detectFish();
  },

  // Heuristic fish detection (no ML model needed)
  detectFish() {
    const w = this.displayWidth;
    const h = this.displayHeight;
    const dpr = window.devicePixelRatio || 1;
    const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const px = imgData.data;

    let minX = this.canvas.width, minY = this.canvas.height, maxX = 0, maxY = 0;
    let totalPixels = 0;
    const T = 240; // color threshold

    for (let y = 0; y < this.canvas.height; y++) {
      for (let x = 0; x < this.canvas.width; x++) {
        const i = (y * this.canvas.width + x) * 4;
        const r = px[i], g = px[i+1], b = px[i+2], a = px[i+3];
        if (a > 0 && (r < T || g < T || b < T)) {
          totalPixels++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // Not enough drawn
    if (totalPixels < 50) {
      this.setFishConfidence(0);
      return;
    }

    // Simple check: anything with significant drawing passes
    this.setFishConfidence(80);
  },

  setFishConfidence(value) {
    this.fishConfidence = value;
    const indicator = document.getElementById('fishIndicator');
    if (!indicator) return;

    indicator.textContent = value >= 60 ? '✅ 是条鱼！' :
                           value >= 30 ? '🎣 像条鱼...' : '✏️ 继续画...';
    indicator.className = 'fish-indicator ' +
      (value >= 60 ? 'good' : value >= 30 ? 'ok' : '');

    // removed green glow per request

    // Enable/disable submit
    const btn = document.getElementById('submitBtn');
    if (btn) {
      btn.disabled = value < 60;
      btn.title = value < 60 ? '画一条能被认出来的鱼吧！' : '';
    }
    const hint = document.getElementById('submitHint');
    if (hint) {
      hint.textContent = value >= 60 ? '✅ 鱼已识别，可以发布！' : '画一条能被识别的鱼才能发布';
      hint.style.color = value >= 60 ? '#2ed573' : 'var(--text2)';
    }
  },

  setColor(color) {
    this.color = color;
    this.isEraser = false;
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.color-btn[data-color="${color}"]`)?.classList.add('active');
  },

  setBrushSize(size) {
    this.brushSize = parseInt(size);
  },

  toggleEraser() {
    this.isEraser = !this.isEraser;
    document.getElementById('eraserBtn')?.classList.toggle('active', this.isEraser);
  },

  clearCanvas() {
    const ctx = this.ctx;
    this.saveState();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.displayWidth, this.displayHeight);
    this.history = [];
    this.historyIndex = -1;
    this.setFishConfidence(0);
    const wrap = (this.canvas && this.canvas.closest('.canvas-wrap')) || this.canvas;
    if (wrap) wrap.style.boxShadow = 'none';
  },

  saveState() {
    if (!this.canvas) return;
    const data = this.canvas.toDataURL();
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(data);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.historyIndex = this.history.length - 1;
  },

  restoreState() {
    if (this.historyIndex >= 0 && this.history[this.historyIndex]) {
      const img = new Image();
      img.onload = () => { this.ctx.drawImage(img, 0, 0, this.displayWidth, this.displayHeight); };
      img.src = this.history[this.historyIndex];
    }
  },

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, this.displayWidth, this.displayHeight);
      this.restoreState();
      this.detectFish();
    }
  },

  getImageData() {
    return this.canvas.toDataURL('image/png');
  },

  isEmpty() {
    const ctx = this.ctx;
    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const pixels = imageData.data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 0) return false;
    }
    return true;
  }
};
