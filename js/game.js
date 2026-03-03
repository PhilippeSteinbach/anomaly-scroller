/**
 * THE ANOMALY SCROLLER
 * Observation-horror / puzzle web game
 *
 * Architecture
 * ────────────
 *  AudioSystem      – Web Audio API sounds (ambient drone, steps, stings)
 *  Renderer         – Single-canvas procedural drawing; 3 parallax layers
 *  InputController  – Mouse-wheel, touch-swipe, keyboard arrows
 *  StareDetector    – Fires after CFG.STARE_MS of no movement
 *  AnomalySystem    – Per-level anomaly state & visibility rules
 *  Game             – State machine: menu → playing → returning → clear/fail
 */
(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  //  CONFIGURATION
  // ════════════════════════════════════════════════════════════
  const CFG = {
    SCROLL_FACTOR:       3,      // virtual units per raw wheel delta unit
    MAX_SCROLL_DELTA:    80,     // clamp individual wheel events
    STARE_MS:            3000,   // ms of no movement before stare fires
    RETURN_THRESHOLD:    100,    // virtual units from 0 counted as "at start"
    END_THRESHOLD:       120,    // virtual units from end counted as "at end"
    // Anomaly becomes "visible" this many virtual units before its trigger point
    ANOMALY_LEAD:        300,
    // …and remains visible this many units past it
    ANOMALY_TRAIL:       500,

    // Parallax rates (fraction of scroll delta applied to each layer)
    P_BG:  0.15,
    P_MID: 0.45,
    P_FG:  0.90,

    // Scene geometry constants
    TILE_W:          80,
    TILE_H:          68,
    PILLAR_SPACING:  480,
    POSTER_SPACING:  700,
    LIGHT_SPACING:   280,

    // Temporal anomaly: scroll slowed to this fraction of normal
    TEMPORAL_SLOW:   0.12,
  };

  // ════════════════════════════════════════════════════════════
  //  LEVEL DATA
  // ════════════════════════════════════════════════════════════
  /**
   * Each level entry:
   *   id           – number
   *   name         – HUD label
   *   length       – virtual scroll units (level width)
   *   hasAnomaly   – boolean
   *   anomaly      – { type, progress } where progress ∈ (0,1)
   *   pal          – colour palette
   *   hint         – message shown when level starts
   *
   * Anomaly types:
   *   visual_poster  – poster text changes at trigger position
   *   stare_figure   – silhouette appears after 3 s of staring at trigger pos
   *   temporal_slow  – scroll is forcibly slowed inside trigger window
   *   visual_shadow  – a shadow moves in the wrong direction
   */
  const LEVELS = [
    {
      id: 0,
      name: 'SECTION 00',
      length: 3000,
      hasAnomaly: false,
      pal: { wall: '#22222c', floor: '#181820', ceiling: '#0d0d12',
             light: '#9090a8', pillar: '#141418' },
      hint: 'Scroll to the end of the section.',
    },
    {
      id: 1,
      name: 'SECTION 01',
      length: 3500,
      hasAnomaly: true,
      anomaly: { type: 'visual_poster', progress: 0.40 },
      pal: { wall: '#1e1e28', floor: '#161620', ceiling: '#0b0b10',
             light: '#8888a8', pillar: '#121218' },
      hint: 'Observe the walls carefully.',
    },
    {
      id: 2,
      name: 'SECTION 02',
      length: 3200,
      hasAnomaly: false,
      pal: { wall: '#202020', floor: '#161616', ceiling: '#0c0c0c',
             light: '#888888', pillar: '#131313' },
      hint: 'Keep moving. Do not hesitate.',
    },
    {
      id: 3,
      name: 'SECTION 03',
      length: 4000,
      hasAnomaly: true,
      anomaly: { type: 'stare_figure', progress: 0.55 },
      pal: { wall: '#1a1a22', floor: '#121218', ceiling: '#090909',
             light: '#707088', pillar: '#0f0f12' },
      hint: 'Stop and wait. Some things take time to appear.',
    },
    {
      id: 4,
      name: 'SECTION 04',
      length: 3500,
      hasAnomaly: true,
      anomaly: { type: 'temporal_slow', progress: 0.48 },
      pal: { wall: '#1c1c1c', floor: '#141414', ceiling: '#0a0a0a',
             light: '#808080', pillar: '#111111' },
      hint: 'Pay attention to how movement feels.',
    },
    {
      id: 5,
      name: 'SECTION 05',
      length: 4200,
      hasAnomaly: true,
      anomaly: { type: 'visual_shadow', progress: 0.38 },
      pal: { wall: '#181818', floor: '#111111', ceiling: '#070707',
             light: '#686868', pillar: '#0d0d0d' },
      hint: 'The shadows do not lie.',
    },
    {
      id: 6,
      name: 'SECTION 06',
      length: 4500,
      hasAnomaly: false,
      pal: { wall: '#141414', floor: '#0e0e0e', ceiling: '#050505',
             light: '#585858', pillar: '#0a0a0a' },
      hint: 'Final section. You are almost free.',
    },
  ];

  // Normal & anomaly poster content
  const NORMAL_POSTERS = [
    { lines: ['METRO',  'LINE 4',  '\u2192'],  bg: '#1e3a6a' },
    { lines: ['PLEASE', 'STAND',   'BACK'],    bg: '#6a3a10' },
    { lines: ['EXIT',   '\u2191'],              bg: '#1a5030' },
    { lines: ['WATCH',  'YOUR',    'STEP'],     bg: '#5a1818' },
    { lines: ['THIS',   'WAY',     '\u2192'],   bg: '#2a2a50' },
    { lines: ['NO',     'ENTRY'],              bg: '#5a1010' },
    { lines: ['PLATFORM', 'A'],               bg: '#103858' },
    { lines: ['CAUTION', 'WET',    'FLOOR'],   bg: '#504010' },
  ];

  const ANOMALY_POSTERS = [
    { lines: ['HELP',   'ME'],               bg: '#5a0808' },
    { lines: ['DO NOT', 'LOOK BACK'],        bg: '#3a0808' },
    { lines: ['IT',     'FOLLOWS'],          bg: '#300000' },
    { lines: ['YOU',    'SAW', 'IT'],        bg: '#420808' },
  ];

  // ════════════════════════════════════════════════════════════
  //  UTILITIES
  // ════════════════════════════════════════════════════════════
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Lighten a hex colour by mixing with white (t ∈ 0..1). */
  function lighten(hex, t) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lr = Math.round(r + (255 - r) * t);
    const lg = Math.round(g + (255 - g) * t);
    const lb = Math.round(b + (255 - b) * t);
    return `rgb(${lr},${lg},${lb})`;
  }

  /** Darken a hex colour by mixing with black (t ∈ 0..1 → darker). */
  function darken(hex, t) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * (1 - t))},${Math.round(g * (1 - t))},${Math.round(b * (1 - t))})`;
  }

  // ════════════════════════════════════════════════════════════
  //  AUDIO SYSTEM
  // ════════════════════════════════════════════════════════════
  class AudioSystem {
    constructor() {
      this.ctx    = null;
      this.master = null;
      this._ambOsc = null;
      this.ready  = false;
    }

    /** Call once after a user gesture to comply with autoplay policy. */
    init() {
      if (this.ready) return;
      try {
        this.ctx    = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.30;
        this.master.connect(this.ctx.destination);
        this._startAmbience();
        this.ready = true;
      } catch (_) { /* audio unavailable */ }
    }

    _startAmbience() {
      // Low drone
      const osc  = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type           = 'sawtooth';
      osc.frequency.value = 52;
      gain.gain.value    = 0.018;
      osc.connect(gain);
      gain.connect(this.master);
      osc.start();
      this._ambOsc = osc;

      // White-noise room hiss
      const bufLen = this.ctx.sampleRate * 2;
      const buf    = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
      const d      = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) d[i] = (Math.random() - 0.5) * 0.025;
      const ns  = this.ctx.createBufferSource();
      const nf  = this.ctx.createBiquadFilter();
      const ng  = this.ctx.createGain();
      ns.buffer = buf;
      ns.loop   = true;
      nf.type   = 'bandpass';
      nf.frequency.value = 220;
      nf.Q.value         = 0.6;
      ng.gain.value      = 0.22;
      ns.connect(nf);
      nf.connect(ng);
      ng.connect(this.master);
      ns.start();
    }

    /** Short footstep click timed to scroll movement. */
    playStep() {
      if (!this.ready) return;
      const now = this.ctx.currentTime;
      const buf = this.ctx.createBuffer(1, 2048, this.ctx.sampleRate);
      const d   = buf.getChannelData(0);
      for (let i = 0; i < 2048; i++) {
        d[i] = (Math.random() - 0.5) * Math.pow(1 - i / 2048, 3.5);
      }
      const src = this.ctx.createBufferSource();
      const g   = this.ctx.createGain();
      src.buffer = buf;
      g.gain.value = 0.35;
      src.connect(g);
      g.connect(this.master);
      src.start(now);
    }

    /** Rising-then-falling sting for anomaly appearance. */
    playSting() {
      if (!this.ready) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g   = this.ctx.createGain();
      osc.type  = 'sine';
      osc.frequency.setValueAtTime(1100, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 1.6);
      g.gain.setValueAtTime(0.35, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 1.6);
      osc.connect(g);
      g.connect(this.master);
      osc.start(now);
      osc.stop(now + 1.6);
    }

    playSuccess() {
      if (!this.ready) return;
      [440, 550, 660, 880].forEach((f, i) => {
        const t = this.ctx.currentTime + i * 0.08;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type  = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.18, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        o.connect(g);
        g.connect(this.master);
        o.start(t);
        o.stop(t + 0.5);
      });
    }

    playFail() {
      if (!this.ready) return;
      [320, 220, 150].forEach((f, i) => {
        const t = this.ctx.currentTime + i * 0.22;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type  = 'sawtooth';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.22, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
        o.connect(g);
        g.connect(this.master);
        o.start(t);
        o.stop(t + 0.55);
      });
    }

    /** Short high-pass noise burst for glitch/temporal effects. */
    playGlitch() {
      if (!this.ready) return;
      const now    = this.ctx.currentTime;
      const len    = Math.floor(this.ctx.sampleRate * 0.35);
      const buf    = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d      = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() - 0.5) * Math.exp(-i / (len * 0.28));
      }
      const src = this.ctx.createBufferSource();
      const flt = this.ctx.createBiquadFilter();
      const g   = this.ctx.createGain();
      src.buffer      = buf;
      flt.type        = 'highpass';
      flt.frequency.value = 900;
      g.gain.value    = 0.45;
      src.connect(flt);
      flt.connect(g);
      g.connect(this.master);
      src.start(now);
    }

    /** Change ambient drone pitch (used for temporal anomaly). */
    setAmbientPitch(freq) {
      if (!this.ready || !this._ambOsc) return;
      this._ambOsc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.15);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  RENDERER
  // ════════════════════════════════════════════════════════════
  /**
   * Draws the corridor scene on a single <canvas> each frame.
   *
   * Scene layout (vertical bands):
   *   0  – 18% height  → ceiling (dark panels + fluorescent tubes)
   *   18 – 78% height  → wall    (tile grid, posters, doors, signs)
   *   78 – 100% height → floor   (tile grid)
   *
   * Three parallax offsets are supplied each frame:
   *   bgOff  = scrollPos * P_BG   (slowest — far tiles, ambient light)
   *   midOff = scrollPos * P_MID  (main wall content)
   *   fgOff  = scrollPos * P_FG   (foreground pillars)
   */
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx    = canvas.getContext('2d');
      this._resize();
    }

    _resize() {
      this.canvas.width  = window.innerWidth;
      this.canvas.height = window.innerHeight;
      this.W  = this.canvas.width;
      this.H  = this.canvas.height;
      const H = this.H, W = this.W;
      // Pre-computed layout constants
      this.L = {
        ceilH:   Math.floor(H * 0.18),
        wallY:   Math.floor(H * 0.18),
        wallBot: Math.floor(H * 0.78),
        wallH:   Math.floor(H * 0.60),
        floorY:  Math.floor(H * 0.78),
        posterY: Math.floor(H * 0.25),
        posterW: Math.max(60,  Math.floor(W * 0.055)),
        posterH: Math.max(90,  Math.floor(H * 0.22)),
      };
    }

    onResize() { this._resize(); }

    // ── Public draw entry-point ────────────────────────────────

    /**
     * @param {number}  scrollPos   – current virtual scroll position
     * @param {object}  level       – current LEVELS entry
     * @param {object}  anomSt      – anomaly state from AnomalySystem
     * @param {number}  glitchAlpha – 0..1 overlay glitch intensity
     * @param {number}  flashAlpha  – 0..1 white flash intensity
     * @param {number}  now         – performance.now() for animation
     */
    draw(scrollPos, level, anomSt, glitchAlpha, flashAlpha, now) {
      const bgOff  = scrollPos * CFG.P_BG;
      const midOff = scrollPos * CFG.P_MID;
      const fgOff  = scrollPos * CFG.P_FG;

      this._drawBg(bgOff,   level, anomSt, now);
      this._drawMid(midOff, level, anomSt, now);
      this._drawFg(fgOff,   level);
      this._drawEffects(scrollPos, anomSt, glitchAlpha, flashAlpha, now);
    }

    // ── Background layer ───────────────────────────────────────

    _drawBg(off, level, anomSt, now) {
      const { ctx, W, H, L } = this;
      const pal = level.pal;

      // Ceiling fill
      ctx.fillStyle = pal.ceiling;
      ctx.fillRect(0, 0, W, L.ceilH);

      // Wall base
      ctx.fillStyle = pal.wall;
      ctx.fillRect(0, L.wallY, W, L.wallH);

      // Floor base
      ctx.fillStyle = pal.floor;
      ctx.fillRect(0, L.floorY, W, H - L.floorY);

      // Far-wall tile grid (very faint, slow parallax)
      this._drawTileGrid(off, L.wallY, L.wallBot, pal.wall, 0.22);

      // Ambient light pools between ceiling fixtures
      this._drawLightPools(off, pal);

      // Stare figure (back-wall layer, appears after 3 s staring)
      if (anomSt && anomSt.type === 'stare_figure' && anomSt.figureAlpha > 0) {
        this._drawFigure(off, anomSt.figureAlpha, now);
      }
    }

    _drawTileGrid(off, yTop, yBot, baseCol, opacity) {
      const { ctx, W } = this;
      const tW = CFG.TILE_W * 1.5;
      const tH = CFG.TILE_H * 1.5;
      const r  = parseInt(baseCol.slice(1, 3), 16);
      const g  = parseInt(baseCol.slice(3, 5), 16);
      const b  = parseInt(baseCol.slice(5, 7), 16);
      ctx.strokeStyle = `rgba(${r + 20},${g + 20},${b + 20},${opacity})`;
      ctx.lineWidth   = 1;
      const sx = -(off % tW);
      for (let x = sx; x < W + tW; x += tW) {
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
      }
      for (let y = yTop; y <= yBot; y += tH) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }

    _drawLightPools(off, pal) {
      const { ctx, W, H, L } = this;
      const sp  = CFG.LIGHT_SPACING;
      const sx  = Math.floor(off / sp) * sp - off;
      for (let x = sx - sp; x < W + sp * 2; x += sp) {
        const gr = ctx.createRadialGradient(x, L.wallY, 0, x, L.wallY, 220);
        gr.addColorStop(0, `rgba(140,140,170,0.055)`);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(x - 240, 0, 480, H * 0.75);
      }
    }

    _drawFigure(off, alpha, now) {
      const { ctx, W, H, L } = this;
      // Silhouette standing at far end of corridor
      const figW = Math.floor(W * 0.025);
      const figH = Math.floor(H * 0.38);
      const cx   = W * 0.5 - (off * 0.05);  // very slow horizontal drift
      const figX = cx - figW / 2;
      const figY = L.wallBot - figH;

      // Slight flicker
      const flicker = 0.85 + Math.sin(now / 90) * 0.12;
      ctx.save();
      ctx.globalAlpha = clamp(alpha * flicker, 0, 1);

      // Body silhouette (head + torso + legs)
      ctx.fillStyle = '#000000';
      const headR = figW * 0.7;
      ctx.beginPath();
      ctx.arc(cx, figY + headR, headR, 0, Math.PI * 2);
      ctx.fill();
      // Torso
      ctx.fillRect(figX + figW * 0.15, figY + headR * 2, figW * 0.7, figH * 0.5);
      // Legs
      ctx.fillRect(figX + figW * 0.15, figY + headR * 2 + figH * 0.5, figW * 0.28, figH * 0.28);
      ctx.fillRect(figX + figW * 0.57, figY + headR * 2 + figH * 0.5, figW * 0.28, figH * 0.28);

      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // ── Midground layer ────────────────────────────────────────

    _drawMid(off, level, anomSt, now) {
      const { ctx, W, H, L } = this;
      const pal = level.pal;

      // ── Ceiling panels + fluorescent tubes
      this._drawCeilingPanels(off, pal);

      // ── Wall tile detail
      this._drawWallTiles(off, pal);

      // ── Floor tiles
      this._drawFloorTiles(off, pal);

      // ── Horizontal trim bands
      ctx.fillStyle = darken(pal.wall, 0.45);
      ctx.fillRect(0, L.wallY, W, 3);       // ceiling–wall seam
      ctx.fillRect(0, L.floorY - 5, W, 5); // dado at floor

      // Dado rail (1/3 up wall)
      ctx.fillStyle = darken(pal.wall, 0.55);
      ctx.fillRect(0, L.wallY + Math.floor(L.wallH * 0.32), W, 3);

      // ── Posters
      this._drawPosters(off, level, anomSt, now);

      // ── Door frames
      this._drawDoors(off, pal);

      // ── Emergency exit signs
      this._drawExitSigns(off);

      // ── Wrong shadow (anomaly)
      if (anomSt && anomSt.type === 'visual_shadow' && anomSt.active) {
        this._drawWrongShadow(off, anomSt.phase, now);
      }
    }

    _drawCeilingPanels(off, pal) {
      const { ctx, W, L } = this;
      const pW = 280;
      const sx = -(off % pW);
      for (let x = sx - pW; x < W + pW * 2; x += pW) {
        // Panel body
        ctx.fillStyle = lighten(pal.ceiling, 0.14);
        ctx.fillRect(x + 4, 2, pW - 8, L.ceilH - 4);

        // Fluorescent tube
        ctx.fillStyle = pal.light;
        ctx.fillRect(x + 22, L.ceilH * 0.33, pW - 44, L.ceilH * 0.16);

        // Soft glow downward from tube
        const gr = ctx.createLinearGradient(0, L.ceilH * 0.5, 0, L.ceilH + 90);
        gr.addColorStop(0, 'rgba(140,140,170,0.10)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(x, L.ceilH * 0.5, pW, 90);
      }
      // Bottom edge of ceiling
      ctx.fillStyle = darken(pal.ceiling, 0.5);
      ctx.fillRect(0, L.ceilH - 2, W, 2);
    }

    _drawWallTiles(off, pal) {
      const { ctx, W, L } = this;
      const tW = CFG.TILE_W, tH = CFG.TILE_H;
      const tileA = lighten(pal.wall, 0.09);
      const tileB = lighten(pal.wall, 0.04);
      const sx    = -(off % tW);

      for (let x = sx - tW; x < W + tW * 2; x += tW) {
        const col = Math.floor((x + off) / tW);
        for (let y = L.wallY; y < L.wallBot; y += tH) {
          const row = Math.floor((y - L.wallY) / tH);
          ctx.fillStyle = (col + row) % 2 === 0 ? tileA : tileB;
          ctx.fillRect(x + 1, y + 1, tW - 2, tH - 2);
        }
      }

      // Grout lines
      ctx.strokeStyle = darken(pal.wall, 0.65);
      ctx.lineWidth   = 1;
      for (let x = sx - tW; x < W + tW * 2; x += tW) {
        ctx.beginPath(); ctx.moveTo(x, L.wallY); ctx.lineTo(x, L.wallBot); ctx.stroke();
      }
      for (let y = L.wallY; y <= L.wallBot; y += tH) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }

    _drawFloorTiles(off, pal) {
      const { ctx, W, H, L } = this;
      const tW = Math.floor(CFG.TILE_W * 1.1);
      const tH = Math.floor(CFG.TILE_H * 0.85);
      const tileA = lighten(pal.floor, 0.12);
      const tileB = lighten(pal.floor, 0.06);
      const sx    = -(off % tW);

      for (let x = sx - tW; x < W + tW * 2; x += tW) {
        const col = Math.floor((x + off) / tW);
        for (let y = L.floorY; y < H + tH; y += tH) {
          const row = Math.floor((y - L.floorY) / tH);
          ctx.fillStyle = (col + row) % 2 === 0 ? tileA : tileB;
          ctx.fillRect(x + 1, y + 1, tW - 2, tH - 2);
        }
      }
      ctx.strokeStyle = darken(pal.floor, 0.65);
      ctx.lineWidth   = 1;
      for (let x = sx - tW; x < W + tW * 2; x += tW) {
        ctx.beginPath(); ctx.moveTo(x, L.floorY); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let y = L.floorY; y < H; y += tH) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }

    _drawPosters(off, level, anomSt, now) {
      const { W, L } = this;
      const sp = CFG.POSTER_SPACING;
      const sx = Math.floor(off / sp) * sp;
      for (let vx = sx - sp; vx < off + W + sp * 2; vx += sp) {
        const sx2 = vx - off;
        if (sx2 < -L.posterW - 10 || sx2 > W + 10) continue;
        const idx = Math.floor(vx / sp);

        // Determine if this poster position matches the anomaly trigger
        const isAnom = (
          level.hasAnomaly &&
          level.anomaly.type === 'visual_poster' &&
          anomSt && anomSt.active &&
          idx === Math.floor(level.anomaly.progress * level.length / sp)
        );

        const content = isAnom
          ? ANOMALY_POSTERS[Math.abs(idx) % ANOMALY_POSTERS.length]
          : NORMAL_POSTERS[Math.abs(idx) % NORMAL_POSTERS.length];

        this._drawOnePoster(sx2, L.posterY, L.posterW, L.posterH, content, isAnom, now);
      }
    }

    _drawOnePoster(x, y, w, h, content, isAnom, now) {
      const { ctx } = this;

      // Background
      ctx.fillStyle = isAnom ? '#3a0505' : content.bg;
      ctx.fillRect(x, y, w, h);

      // Border
      if (isAnom) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 180);
        ctx.strokeStyle = `rgba(220,40,40,${pulse})`;
        ctx.lineWidth   = 2;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth   = 1;
      }
      ctx.strokeRect(x, y, w, h);

      // Text
      ctx.fillStyle    = isAnom ? '#ff6060' : 'rgba(255,255,255,0.88)';
      const fSize      = Math.max(7, Math.floor(w / 5.5));
      ctx.font         = `bold ${fSize}px 'Courier New', monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      const lineH = h / (content.lines.length + 1);
      content.lines.forEach((line, i) => {
        ctx.fillText(line, x + w / 2, y + lineH * (i + 1));
      });
    }

    _drawDoors(off, pal) {
      const { ctx, W, L } = this;
      const sp  = 1500;
      const dW  = Math.max(30, Math.floor(W * 0.032));
      const dH  = Math.floor(L.wallH * 0.70);
      const dY  = L.wallBot - dH;
      const sx  = Math.floor(off / sp) * sp;

      for (let vx = sx - sp; vx < off + W + sp * 2; vx += sp) {
        const sx2 = vx - off;
        if (sx2 < -dW - 10 || sx2 > W + 10) continue;
        // Recessed frame
        ctx.fillStyle = darken(pal.wall, 0.45);
        ctx.fillRect(sx2 - 3, dY - 3, dW + 6, dH + 6);
        // Door surface
        ctx.fillStyle = darken(pal.wall, 0.25);
        ctx.fillRect(sx2, dY, dW, dH);
        // Door handle
        ctx.fillStyle = lighten(pal.wall, 0.25);
        ctx.fillRect(sx2 + dW * 0.72, dY + dH * 0.45, dW * 0.10, dH * 0.08);
      }
    }

    _drawExitSigns(off) {
      const { ctx, W, L } = this;
      const sp  = 900;
      const sW  = Math.max(32, Math.floor(W * 0.03));
      const sH  = Math.floor(sW * 0.4);
      const sY  = L.wallY + 10;
      const sx  = Math.floor(off / sp) * sp;

      for (let vx = sx - sp; vx < off + W + sp * 2; vx += sp) {
        const sx2 = vx - off;
        if (sx2 < -sW - 10 || sx2 > W + 10) continue;
        ctx.fillStyle   = '#1a4a28';
        ctx.fillRect(sx2, sY, sW, sH);
        ctx.fillStyle   = '#40cc70';
        ctx.font        = `bold ${Math.max(6, Math.floor(sH * 0.55))}px 'Courier New', monospace`;
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('EXIT', sx2 + sW / 2, sY + sH / 2);
      }
    }

    _drawWrongShadow(off, phase, now) {
      const { ctx, W, H, L } = this;
      // Normal shadow: would follow the direction of light (moves with mid parallax)
      // Anomaly shadow: moves in the OPPOSITE direction
      const lightX    = 300;  // virtual light source x
      const shadowLen = 200;
      // Phase oscillates to make the shadow gradually move wrong
      const wrongDir  = -1;   // reverse of expected
      const shadowX   = (W / 2) + wrongDir * (phase * shadowLen);

      ctx.save();
      ctx.globalAlpha = 0.35 + 0.2 * Math.sin(now / 400);
      const gr = ctx.createLinearGradient(shadowX, L.wallY + L.wallH * 0.2, shadowX + 40, L.wallBot);
      gr.addColorStop(0, 'rgba(0,0,0,0.6)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      // Human-shaped shadow profile
      ctx.beginPath();
      ctx.moveTo(shadowX,      L.wallBot);
      ctx.lineTo(shadowX + 15, L.wallY + L.wallH * 0.22);
      ctx.lineTo(shadowX + 30, L.wallY + L.wallH * 0.20);
      ctx.lineTo(shadowX + 40, L.wallBot);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // ── Foreground layer ───────────────────────────────────────

    _drawFg(off, level) {
      const pal = level.pal;
      this._drawPillars(off, pal);
      this._drawFloorStripes(off);
      this._drawOverheadCables(off, pal);
      this._drawVignette();
    }

    _drawPillars(off, pal) {
      const { ctx, W, H, L } = this;
      const sp  = CFG.PILLAR_SPACING;
      const pW  = Math.max(18, Math.floor(W * 0.018));
      const sx  = Math.floor(off / sp) * sp;

      for (let vx = sx - sp; vx < off + W + sp * 2; vx += sp) {
        const sx2 = vx - off;
        if (sx2 < -pW - 5 || sx2 > W + 5) continue;
        // Main column
        ctx.fillStyle = pal.pillar;
        ctx.fillRect(sx2, L.wallY, pW, H - L.wallY);
        // Slight highlight on left edge
        ctx.fillStyle = lighten(pal.pillar, 0.18);
        ctx.fillRect(sx2, L.wallY, 2, H - L.wallY);
        // Cap at ceiling
        ctx.fillStyle = lighten(pal.pillar, 0.08);
        ctx.fillRect(sx2 - 3, L.ceilH, pW + 6, 12);
      }
    }

    _drawFloorStripes(off) {
      const { ctx, W, H, L } = this;
      const sp   = CFG.PILLAR_SPACING;
      const strW = 60;
      const sx   = Math.floor(off / sp) * sp;

      ctx.fillStyle = 'rgba(180,140,20,0.22)';
      for (let vx = sx - sp; vx < off + W + sp * 2; vx += sp) {
        const sx2 = vx - off;
        // Hazard stripe at each pillar base
        for (let s = 0; s < 4; s++) {
          if (s % 2 === 0) {
            ctx.fillRect(sx2 + s * 10, L.floorY, 10, H - L.floorY);
          }
        }
      }
    }

    _drawOverheadCables(off, pal) {
      const { ctx, W, L } = this;
      const sp  = CFG.PILLAR_SPACING;
      const sx  = Math.floor(off / sp) * sp;
      ctx.strokeStyle = darken(pal.pillar, 0.2);
      ctx.lineWidth   = 1.5;
      // Catenary-ish cable between pillars
      for (let vx = sx - sp; vx < off + W + sp * 2; vx += sp) {
        const x1 = vx - off;
        const x2 = x1 + sp;
        const cy = L.ceilH + 8 + Math.floor(W * 0.01);
        ctx.beginPath();
        ctx.moveTo(x1, cy);
        ctx.quadraticCurveTo((x1 + x2) / 2, cy + 12, x2, cy);
        ctx.stroke();
      }
    }

    _drawVignette() {
      const { ctx, W, H } = this;
      const gr = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, W, H);
    }

    // ── Effect overlays ────────────────────────────────────────

    _drawEffects(scrollPos, anomSt, glitchAlpha, flashAlpha, now) {
      const { ctx, W, H } = this;

      // White flash
      if (flashAlpha > 0) {
        ctx.fillStyle = `rgba(255,255,255,${flashAlpha * 0.35})`;
        ctx.fillRect(0, 0, W, H);
      }

      // Glitch strips
      if (glitchAlpha > 0) {
        ctx.save();
        ctx.globalAlpha = glitchAlpha * 0.6;
        const stripCount = 5 + Math.floor(Math.random() * 6);
        for (let i = 0; i < stripCount; i++) {
          const sy    = Math.random() * H;
          const sh    = 2 + Math.random() * 12;
          const shift = (Math.random() - 0.5) * 30;
          ctx.drawImage(this.canvas, 0, sy, W, sh, shift, sy, W, sh);
        }
        // Colour aberration tint
        ctx.fillStyle = `rgba(0,220,255,${glitchAlpha * 0.08})`;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      // Temporal anomaly distortion lines
      if (anomSt && anomSt.type === 'temporal_slow' && anomSt.active) {
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.12 * Math.sin(now / 60);
        ctx.strokeStyle = 'rgba(100,100,255,0.4)';
        ctx.lineWidth   = 1;
        const lineY = (now / 8) % H;
        ctx.beginPath();
        ctx.moveTo(0, lineY);
        ctx.lineTo(W, lineY);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  //  INPUT CONTROLLER
  // ════════════════════════════════════════════════════════════
  class InputController {
    /**
     * @param {function(number): void} onScroll  – called with signed delta
     * @param {function(): void}       onReverse – called on reverse action
     */
    constructor(onScroll, onReverse) {
      this._onScroll  = onScroll;
      this._onReverse = onReverse;

      this._touchStartX = 0;
      this._touchStartY = 0;
      this._lastTouchX  = 0;

      this._bindEvents();
    }

    _bindEvents() {
      // Mouse wheel
      window.addEventListener('wheel', (e) => {
        e.preventDefault();
        const d = clamp(e.deltaY, -CFG.MAX_SCROLL_DELTA, CFG.MAX_SCROLL_DELTA);
        this._onScroll(d * CFG.SCROLL_FACTOR);
      }, { passive: false });

      // Touch swipe
      window.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        this._touchStartX = t.clientX;
        this._touchStartY = t.clientY;
        this._lastTouchX  = t.clientX;
      }, { passive: true });

      window.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const t    = e.touches[0];
        const dx   = this._lastTouchX - t.clientX;
        this._lastTouchX = t.clientX;
        this._onScroll(dx * CFG.SCROLL_FACTOR * 0.8);
      }, { passive: false });

      // Keyboard
      window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'd') this._onScroll( 18 * CFG.SCROLL_FACTOR);
        if (e.key === 'ArrowLeft'  || e.key === 'a') this._onScroll(-18 * CFG.SCROLL_FACTOR);
        if (e.key === 'r' || e.key === 'R')          this._onReverse();
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  //  STARE DETECTOR
  // ════════════════════════════════════════════════════════════
  /** Fires onStare() after the player has been still for CFG.STARE_MS ms. */
  class StareDetector {
    constructor(onStare) {
      this._onStare   = onStare;
      this._timer     = null;
      this._charging  = false;
      this.active     = false;
    }

    /** Call whenever the player scrolls. */
    notifyMovement() {
      this._cancelTimer();
    }

    /** Call each frame to check if player is still. Starts timer if needed. */
    startIfIdle() {
      if (this._charging || this._timer !== null) return;
      this._charging = true;
      this._timer    = setTimeout(() => {
        this._timer    = null;
        this._charging = false;
        if (this.active) this._onStare();
      }, CFG.STARE_MS);
    }

    _cancelTimer() {
      if (this._timer !== null) {
        clearTimeout(this._timer);
        this._timer    = null;
        this._charging = false;
      }
    }

    /** @returns {boolean} true while countdown is running */
    get isCharging() { return this._charging; }

    reset() { this._cancelTimer(); }
  }

  // ════════════════════════════════════════════════════════════
  //  ANOMALY SYSTEM
  // ════════════════════════════════════════════════════════════
  /**
   * Tracks per-level anomaly visibility state.
   *
   * Visibility window:
   *   [triggerPos - ANOMALY_LEAD,  triggerPos + ANOMALY_TRAIL]
   *
   * For stare_figure the anomaly becomes "active" (figureAlpha > 0) only
   * after the player stares for 3 s while inside the window.
   *
   * For temporal_slow the game scroll speed is reduced while inside window.
   *
   * For visual_shadow the shadow phase is driven by time elapsed inside window.
   */
  class AnomalySystem {
    constructor() {
      this.state = null; // { type, active, figureAlpha, phase, ... }
    }

    /** Called at level start to reset for new level. */
    initLevel(level) {
      if (!level.hasAnomaly) { this.state = null; return; }
      const a   = level.anomaly;
      const pos = a.progress * level.length;
      this.state = {
        type:        a.type,
        triggerPos:  pos,
        windowStart: pos - CFG.ANOMALY_LEAD,
        windowEnd:   pos + CFG.ANOMALY_TRAIL,
        active:      false,       // true when player is inside window
        responded:   false,       // true after player correctly reverses
        figureAlpha: 0,           // for stare_figure (0..1)
        phase:       0,           // for visual_shadow (0..1)
        enteredAt:   null,        // performance.now() when window entered
      };
    }

    /**
     * Update anomaly state.
     * @param {number} scrollPos   current virtual scroll position
     * @param {number} now         performance.now()
     * @param {number} stareElapsed ms the player has been still (0 if moving)
     * @returns {object|null} current state
     */
    update(scrollPos, now, stareElapsed) {
      if (!this.state || this.state.responded) return this.state;
      const s = this.state;
      const inWindow = (scrollPos >= s.windowStart && scrollPos <= s.windowEnd);

      if (inWindow && !s.active) {
        s.active    = true;
        s.enteredAt = now;
      } else if (!inWindow && s.active) {
        s.active    = false;
      }

      if (s.type === 'stare_figure' && s.active) {
        // Fade in proportionally to stare elapsed time
        s.figureAlpha = clamp(stareElapsed / CFG.STARE_MS, 0, 1);
      }

      if (s.type === 'visual_shadow' && s.active) {
        // Phase builds over 2 s of being in the window
        const elapsed = now - s.enteredAt;
        s.phase = clamp(elapsed / 2000, 0, 1);
      }

      return s;
    }

    /** @returns {number} 0..1 slow factor when temporal anomaly active, else 1 */
    getScrollMultiplier(scrollPos) {
      if (!this.state || this.state.type !== 'temporal_slow') return 1;
      if (this.state.active && !this.state.responded) return CFG.TEMPORAL_SLOW;
      return 1;
    }

    /**
     * Mark the anomaly as responded to.
     * @returns {boolean} true if the response was valid (anomaly was active)
     */
    respondToAnomaly() {
      if (!this.state) return false;
      if (!this.state.active) return false;
      if (this.state.type === 'stare_figure' && this.state.figureAlpha < 0.5) {
        // Figure must be mostly visible before the player can "see" it
        return false;
      }
      this.state.responded = true;
      return true;
    }

    /** @returns {boolean} anomaly was missed (player reached end without responding) */
    wasMissed(scrollPos, levelLength) {
      if (!this.state) return false;
      if (this.state.responded) return false;
      return scrollPos >= levelLength - CFG.END_THRESHOLD;
    }

    /** @returns {boolean} player reversed when no anomaly is active — false alarm */
    isFalseAlarm() {
      if (!this.state) return true;   // no anomaly level → any reverse is false alarm
      return !this.state.active;
    }
  }

  // ════════════════════════════════════════════════════════════
  //  GAME  (main state machine)
  // ════════════════════════════════════════════════════════════
  const STATE = {
    MENU:      'menu',
    PLAYING:   'playing',
    RETURNING: 'returning',   // reversed correctly; now return to start
    CLEAR:     'clear',
    GAMEOVER:  'gameover',
    VICTORY:   'victory',
  };

  class Game {
    constructor() {
      // DOM
      this.$canvas  = document.getElementById('gameCanvas');
      this.$hud     = document.getElementById('hud');
      this.$secNum  = document.getElementById('section-num');
      this.$pfill   = document.getElementById('progress-fill');
      this.$pdot    = document.getElementById('progress-dot');
      this.$stareRing   = document.getElementById('stare-ring');
      this.$msgBanner   = document.getElementById('msg-banner');
      this.$scrollHint  = document.getElementById('scroll-hint');

      this.$screens = {
        [STATE.MENU]:     document.getElementById('screen-menu'),
        [STATE.GAMEOVER]: document.getElementById('screen-gameover'),
        [STATE.CLEAR]:    document.getElementById('screen-clear'),
        [STATE.VICTORY]:  document.getElementById('screen-victory'),
      };

      // Systems
      this.audio    = new AudioSystem();
      this.renderer = new Renderer(this.$canvas);
      this.anomaly  = new AnomalySystem();
      this.stare    = new StareDetector(() => this._onStareComplete());
      this.input    = new InputController(
        (d) => this._handleScroll(d),
        ()  => this._handleReverse()
      );

      // State
      this.state       = STATE.MENU;
      this.levelIdx    = 0;
      this.scrollPos   = 0;
      this.direction   = 1;   // +1 = forward, -1 = backward
      this.lastScrollT = performance.now();
      this.stareElapsed = 0;

      // Effect state
      this.glitchAlpha = 0;
      this.flashAlpha  = 0;

      // Step sound throttle
      this._lastStepT  = 0;
      this._stepInterval = 220; // ms between step sounds

      // Footstep counter for alternating sounds
      this._stepCount = 0;

      this._bindUI();
    }

    _bindUI() {
      document.getElementById('btn-start')  .addEventListener('click', () => this._startGame());
      document.getElementById('btn-retry')  .addEventListener('click', () => this._startGame());
      document.getElementById('btn-next')   .addEventListener('click', () => this._advanceLevel());
      document.getElementById('btn-restart').addEventListener('click', () => this._startGame());
      document.getElementById('btn-reverse').addEventListener('click', () => this._handleReverse());
    }

    // ── Game flow ──────────────────────────────────────────────

    _startGame() {
      this.levelIdx  = 0;
      this.scrollPos = 0;
      this._beginLevel();
    }

    _beginLevel() {
      const level = LEVELS[this.levelIdx];
      this.scrollPos    = 0;
      this.direction    = 1;
      this.glitchAlpha  = 0;
      this.flashAlpha   = 0;
      this.stareElapsed = 0;
      this.stare.reset();
      this.anomaly.initLevel(level);

      this.$secNum.textContent = String(this.levelIdx).padStart(2, '0');
      this._showBanner(level.hint);
      this._setState(STATE.PLAYING);
      this.$hud.classList.remove('hidden');
      this.$scrollHint.classList.add('gone');

      this.audio.init();
      this.audio.setAmbientPitch(52);
    }

    _advanceLevel() {
      this.levelIdx++;
      if (this.levelIdx >= LEVELS.length) {
        this._setState(STATE.VICTORY);
        this.audio.playSuccess();
        return;
      }
      this._beginLevel();
    }

    _failLevel(reason) {
      this.audio.playFail();
      this.glitchAlpha = 1;

      const msgs = {
        missed_anomaly:  'You failed to notice the anomaly.',
        false_alarm:     'There was nothing there. You panicked.',
        wrong_direction: 'You reversed at the wrong moment.',
      };

      document.getElementById('go-msg').textContent = msgs[reason] || 'The loop has reset.';
      this._setState(STATE.GAMEOVER);
      this.$hud.classList.add('hidden');

      // Reset to level 0 on next attempt
      this.levelIdx = 0;
    }

    _levelClear() {
      this.audio.playSuccess();
      const level = LEVELS[this.levelIdx];

      const isAnomalyLevel = level.hasAnomaly;
      document.getElementById('clr-msg').textContent = isAnomalyLevel
        ? 'Anomaly neutralised. The loop resets.'
        : 'Section complete. Proceeding.';

      this._setState(STATE.CLEAR);
      this.$hud.classList.add('hidden');
    }

    // ── Input handling ─────────────────────────────────────────

    _handleScroll(rawDelta) {
      if (this.state !== STATE.PLAYING && this.state !== STATE.RETURNING) return;

      // Temporal slow-down anomaly
      const mult = this.anomaly.getScrollMultiplier(this.scrollPos);
      const d    = rawDelta * mult;

      const level = LEVELS[this.levelIdx];
      const newPos = clamp(this.scrollPos + d, 0, level.length);
      const moved  = newPos !== this.scrollPos;

      if (moved) {
        this.direction    = d > 0 ? 1 : -1;
        this.scrollPos    = newPos;
        this.stare.notifyMovement();
        this.lastScrollT  = performance.now();
        this.stareElapsed = 0;

        // Footstep sound
        const now = performance.now();
        if (now - this._lastStepT > this._stepInterval) {
          this.audio.playStep();
          this._lastStepT = now;
        }

        // Check end-conditions
        this._checkScrollBounds(level);
      }
    }

    _handleReverse() {
      if (this.state !== STATE.PLAYING) return;
      const level = LEVELS[this.levelIdx];

      if (level.hasAnomaly) {
        // Valid response: anomaly is currently visible
        const valid = this.anomaly.respondToAnomaly();
        if (!valid) {
          // False alarm — wrong position or figure not visible yet
          this._failLevel('false_alarm');
          return;
        }
        // Correct — now the player must scroll BACK to start
        this.audio.playSting();
        this.flashAlpha = 1;
        this._setState(STATE.RETURNING);
        this._showBanner('Anomaly spotted! Return to the start.');
      } else {
        // No anomaly level — any reverse is a false alarm
        this._failLevel('false_alarm');
      }
    }

    _onStareComplete() {
      // Stare timer fired — let the anomaly system register the full stare
      // (figureAlpha will be 1 by now)
      const st = this.anomaly.state;
      if (st && st.type === 'stare_figure' && st.active && !st.responded) {
        this.audio.playSting();
        this.glitchAlpha = 0.6;
      }
    }

    _checkScrollBounds(level) {
      if (this.state === STATE.RETURNING) {
        // Player is heading back to start
        if (this.scrollPos <= CFG.RETURN_THRESHOLD) {
          this._levelClear();
        }
        return;
      }

      // STATE.PLAYING
      if (this.scrollPos >= level.length - CFG.END_THRESHOLD) {
        // Reached the end
        if (level.hasAnomaly && !this.anomaly.state.responded) {
          this._failLevel('missed_anomaly');
        } else {
          // No-anomaly level, or anomaly already handled
          this._levelClear();
        }
      }
    }

    // ── State machine ──────────────────────────────────────────

    _setState(newState) {
      this.state = newState;
      // Hide all screens
      Object.values(this.$screens).forEach((s) => s.classList.remove('active'));
      // Show relevant screen
      if (this.$screens[newState]) {
        this.$screens[newState].classList.add('active');
      }
    }

    // ── Helpers ────────────────────────────────────────────────

    _showBanner(text) {
      const el = this.$msgBanner;
      el.textContent = text;
      el.classList.remove('hidden');
      // Restart CSS animation
      el.style.animation = 'none';
      // Force reflow
      void el.offsetWidth;
      el.style.animation = '';
      el.classList.remove('hidden');
      // Hide after animation completes
      setTimeout(() => el.classList.add('hidden'), 4200);
    }

    // ── Main loop ──────────────────────────────────────────────

    start() {
      window.addEventListener('resize', () => this.renderer.onResize());
      requestAnimationFrame((t) => this._loop(t));
    }

    _loop(now) {
      requestAnimationFrame((t) => this._loop(t));
      this._update(now);
      this._render(now);
    }

    _update(now) {
      const dt = Math.min(now - (this._lastNow || now), 100); // cap at 100ms
      this._lastNow = now;

      if (this.state !== STATE.PLAYING && this.state !== STATE.RETURNING) return;

      const level = LEVELS[this.levelIdx];

      // Stare detection: track elapsed idle time
      const idleMs = now - this.lastScrollT;
      if (idleMs > 400) {
        // Player has been still long enough — start stare timer
        this.stare.active = true;
        this.stare.startIfIdle();
        this.stareElapsed = clamp(idleMs, 0, CFG.STARE_MS);
      } else {
        this.stare.active = false;
        this.stareElapsed = 0;
      }

      // Stare ring UI
      if (this.stare.isCharging && this.state === STATE.PLAYING) {
        this.$stareRing.classList.remove('hidden');
        if (!this.$stareRing.classList.contains('charging')) {
          this.$stareRing.classList.add('charging');
        }
      } else {
        this.$stareRing.classList.add('hidden');
        this.$stareRing.classList.remove('charging');
      }

      // Update anomaly state
      this.anomaly.update(this.scrollPos, now, this.stareElapsed);

      // Temporal anomaly: play glitch sound when entering slow zone
      const st = this.anomaly.state;
      if (st && st.type === 'temporal_slow' && st.active && !st._glitchPlayed) {
        this.audio.playGlitch();
        this.audio.setAmbientPitch(28);
        st._glitchPlayed = true;
      }
      if (st && st.type === 'temporal_slow' && !st.active && st._glitchPlayed && !st.responded) {
        st._glitchPlayed = false;
        this.audio.setAmbientPitch(52);
      }

      // Decay effects
      this.glitchAlpha = Math.max(0, this.glitchAlpha - dt / 600);
      this.flashAlpha  = Math.max(0, this.flashAlpha  - dt / 300);

      // Progress bar
      const pct = clamp((this.scrollPos / level.length) * 100, 0, 100);
      this.$pfill.style.width = `${pct}%`;
      this.$pdot.style.left   = `${pct}%`;
    }

    _render(now) {
      const level   = LEVELS[this.levelIdx];
      const anomSt  = this.anomaly.state;

      if (this.state === STATE.MENU) {
        // Draw a static scene behind the menu
        this.renderer.draw(0, LEVELS[0], null, 0, 0, now);
        return;
      }

      this.renderer.draw(
        this.scrollPos,
        level,
        anomSt,
        this.glitchAlpha,
        this.flashAlpha,
        now
      );
    }
  }

  // ════════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════════
  window.addEventListener('DOMContentLoaded', () => {
    const game = new Game();
    game.start();
  });

})();
