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
  isLandscape: false,
  history: [],
  historyIndex: -1,
  maxHistory: 50,
  fishConfidence: 0,
  detectionTimer: null,
  ortSession: null,

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
    this.loadModel();
  },

  async loadModel() {
    if (!window.ort) return;
    try {
      this.ortSession = await window.ort.InferenceSession.create('/fish_doodle_classifier.onnx');
    } catch (e) {
      console.warn('ONNX model load failed, using fallback detection');
    }
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
        this.detectFish().catch(() => {});
        this.detectionTimer = null;
      }, 200);
    }
  },

  stopDraw() {
    this.isDrawing = false;
    this.detectFish().catch(() => {});
  },

  // Fish detection via ONNX model, with pixel-count fallback
  async detectFish() {
    const canvas = this.canvas;
    if (!canvas) return;

    // Use ONNX model if available
    if (this.ortSession) {
      try {
        const result = await this.verifyFishDoodle(canvas);
        const pct = Math.round(result.prob * 100);
        this.setFishConfidence(pct, result.isFish);
        return;
      } catch (e) { /* fall through to pixel method */ }
    }

    // Fallback: pixel count + bounding box heuristics
    const w = canvas.width, h = canvas.height;
    const imgData = this.ctx.getImageData(0, 0, w, h);
    const px = imgData.data;
    const T = 240;
    let drawn = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i+3] > 0 && (px[i] < T || px[i+1] < T || px[i+2] < T)) {
          drawn++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const displayPixels = this.displayWidth * this.displayHeight;
    const coverage = drawn / (w * h);
    const pct = Math.round(coverage * 100);

    const pixelThreshold = Math.max(200, displayPixels * 0.03);
    if (drawn < pixelThreshold) { this.setFishConfidence(pct, false); return; }

    const dpr = w / this.displayWidth;
    const bbW = (maxX - minX + 1) / dpr;
    const bbH = (maxY - minY + 1) / dpr;
    const aspect = bbW / bbH;
    const shapeOk = aspect >= 0.8 && aspect <= 4.0;
    const bbPixels = (maxX - minX + 1) * (maxY - minY + 1);
    const filled = drawn / bbPixels > 0.08;

    this.setFishConfidence(pct, shapeOk && filled);
  },

  setFishConfidence(pct, detected) {
    this.fishConfidence = detected ? 60 + Math.round(pct * 0.4) : 0;
    const indicator = document.getElementById('fishIndicator');
    if (!indicator) return;

    indicator.textContent = detected
      ? `✅ 是条鱼！ (${pct}% 覆盖)`
      : `✏️ 继续画... (${pct}%)`;
    indicator.className = 'fish-indicator ' + (detected ? 'good' : '');

    // Enable/disable submit
    const btn = document.getElementById('submitBtn');
    if (btn) {
      btn.disabled = !detected;
      btn.title = detected ? '' : '画一条能被认出来的鱼吧！';
    }
    const hint = document.getElementById('submitHint');
    if (hint) {
      hint.textContent = detected ? '✅ 鱼已识别，可以发布！' : '画一条能被识别的鱼才能发布';
      hint.style.color = detected ? '#2ed573' : 'var(--text2)';
    }
  },

  // ONNX model inference — matches drawafish.com logic
  async fishProbability(canvas) {
    const inputTensor = this.preprocessCanvas(canvas);
    const feeds = {};
    const inputName = this.ortSession.inputNames ? this.ortSession.inputNames[0] : 'input';
    feeds[inputName] = inputTensor;
    const results = await this.ortSession.run(feeds);
    const output = results[Object.keys(results)[0]].data;
    const sig = 1 / (1 + Math.exp(-output[0]));
    return 1 - sig; // fish probability (model was trained with inverted labels)
  },

  async verifyFishDoodle(canvas) {
    let inputCanvas = canvas;
    if (this.isLandscape) {
      // Unrotate content that was rotated +90° for landscape display
      inputCanvas = document.createElement('canvas');
      inputCanvas.width = canvas.height;
      inputCanvas.height = canvas.width;
      const ctx = inputCanvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, inputCanvas.width, inputCanvas.height);
      ctx.translate(inputCanvas.width / 2, inputCanvas.height / 2);
      ctx.rotate(-90 * Math.PI / 180);
      ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    }
    const prob = await this.fishProbability(inputCanvas);
    return { prob, isFish: prob >= 0.25 };
  },

  preprocessCanvas(canvas) {
    const SIZE = 224;
    const temp = document.createElement('canvas');
    const tCtx = temp.getContext('2d');
    temp.width = SIZE; temp.height = SIZE;
    tCtx.fillStyle = 'white';
    tCtx.fillRect(0, 0, SIZE, SIZE);
    tCtx.drawImage(canvas, 0, 0, SIZE, SIZE);
    const data = tCtx.getImageData(0, 0, SIZE, SIZE).data;
    const input = new Float32Array(1 * 3 * SIZE * SIZE);
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    for (let i = 0; i < SIZE * SIZE; i++) {
      const p = i * 4;
      const r = data[p] / 255, g = data[p+1] / 255, b = data[p+2] / 255;
      input[i] = (r - mean[0]) / std[0];
      input[i + SIZE * SIZE] = (g - mean[1]) / std[1];
      input[i + 2 * SIZE * SIZE] = (b - mean[2]) / std[2];
    }
    return new window.ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
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
    this.setFishConfidence(0, false);
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

  restoreRotated(angle) {
    if (this.historyIndex >= 0 && this.history[this.historyIndex]) {
      const img = new Image();
      img.onload = () => {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.displayWidth, this.displayHeight);
        this.ctx.save();
        this.ctx.translate(this.displayWidth / 2, this.displayHeight / 2);
        this.ctx.rotate(angle * Math.PI / 180);
        const scale = Math.min(this.displayWidth / img.height, this.displayHeight / img.width);
        const dw = img.width * scale, dh = img.height * scale;
        this.ctx.drawImage(img, -dw/2, -dh/2, dw, dh);
        this.ctx.restore();
        this.detectFish().catch(() => {});
      };
      img.src = this.history[this.historyIndex];
    }
  },

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, this.displayWidth, this.displayHeight);
      this.restoreState();
      this.detectFish().catch(() => {});
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
