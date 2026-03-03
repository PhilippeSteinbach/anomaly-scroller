/**
 * THE ANOMALY SCROLLER
 * Observation-horror / puzzle web game
 *
 * Architecture
 * ────────────
 *  AudioSystem      – Web Audio API sounds (ambient drone, steps, stings)
 *  Renderer         – Three.js 3-D corridor renderer
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
    SCROLL_FACTOR:       2,      // virtual units per raw wheel delta unit
    MAX_SCROLL_DELTA:    60,     // clamp individual wheel events
    STARE_MS:            3000,   // ms of no movement before stare fires
    RETURN_THRESHOLD:    100,    // virtual units from 0 counted as "at start"
    END_THRESHOLD:       120,    // virtual units from end counted as "at end"
    // Anomaly becomes "visible" this many virtual units before its trigger point
    ANOMALY_LEAD:        600,
    // …and remains visible this many units past it
    ANOMALY_TRAIL:       900,

    // Parallax rates (fraction of scroll delta applied to each layer)
    P_BG:  0.20,
    P_MID: 0.55,
    P_FG:  1.00,

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
      length: 8000,
      hasAnomaly: false,
      pal: { wall: '#2a2a38', floor: '#1e1e28', ceiling: '#12121a',
             light: '#a8a8c8', pillar: '#18181e' },
      hint: 'Scroll to the end of the section.',
    },
    {
      id: 1,
      name: 'SECTION 01',
      length: 10000,
      hasAnomaly: true,
      anomaly: { type: 'visual_poster', progress: 0.40 },
      pal: { wall: '#2c2c34', floor: '#202028', ceiling: '#101018',
             light: '#9898b8', pillar: '#161620' },
      hint: 'Observe the walls carefully.',
    },
    {
      id: 2,
      name: 'SECTION 02',
      length: 9000,
      hasAnomaly: false,
      pal: { wall: '#282830', floor: '#1c1c24', ceiling: '#0e0e14',
             light: '#9090a0', pillar: '#151520' },
      hint: 'Keep moving. Do not hesitate.',
    },
    {
      id: 3,
      name: 'SECTION 03',
      length: 11000,
      hasAnomaly: true,
      anomaly: { type: 'stare_figure', progress: 0.55 },
      pal: { wall: '#2a2a32', floor: '#1e1e24', ceiling: '#10101a',
             light: '#8888a8', pillar: '#141420' },
      hint: 'Watch the corridor ahead. Something may appear.',
    },
    {
      id: 4,
      name: 'SECTION 04',
      length: 9500,
      hasAnomaly: true,
      anomaly: { type: 'temporal_slow', progress: 0.48 },
      pal: { wall: '#282828', floor: '#1c1c1c', ceiling: '#0e0e0e',
             light: '#888898', pillar: '#141418' },
      hint: 'If time slows down, something is wrong.',
    },
    {
      id: 5,
      name: 'SECTION 05',
      length: 12000,
      hasAnomaly: true,
      anomaly: { type: 'visual_shadow', progress: 0.38 },
      pal: { wall: '#262632', floor: '#1a1a24', ceiling: '#0c0c14',
             light: '#808098', pillar: '#121218' },
      hint: 'Shadows should follow the light.',
    },
    {
      id: 6,
      name: 'SECTION 06',
      length: 10000,
      hasAnomaly: false,
      pal: { wall: '#242430', floor: '#181822', ceiling: '#0a0a12',
             light: '#787890', pillar: '#101016' },
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
  //  RENDERER  (Three.js)
  // ════════════════════════════════════════════════════════════
  /**
   * First-person 3-D corridor renderer using Three.js.
   *
   * The corridor extends along the −Z axis.  Camera moves with scroll.
   * Procedural canvas textures for walls / floor / ceiling / posters.
   * Dynamic point-light pool repositioned each frame near the camera.
   */
  class Renderer {
    constructor(canvas) {
      this._r = new THREE.WebGLRenderer({ canvas, antialias: true });
      this._r.setSize(window.innerWidth, window.innerHeight);
      this._r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this._r.toneMapping = THREE.ACESFilmicToneMapping;
      this._r.toneMappingExposure = 0.7;

      this.scene = new THREE.Scene();
      this.cam = new THREE.PerspectiveCamera(
        72, window.innerWidth / window.innerHeight, 0.05, 200,
      );
      this.scene.add(this.cam);

      // virtual → Three.js scale  (10 000 units ≈ 100 m)
      this.S  = 0.01;
      this.CW = 5;      // corridor width  (m)
      this.CH = 3.5;    // corridor height (m)
      this.EY = 1.6;    // eye height      (m)

      // Level-specific state
      this._grp         = null;
      this._poolLights  = [];
      this._fixZs       = [];
      this._anomPoster  = null;
      this._anomMatNorm = null;
      this._anomMatAnom = null;
      this._figureMesh  = null;
      this._anomActive  = false;
      this._shadowMesh  = null;    // visual_shadow anomaly
      this._shadowBaseY = 0;
      this._temporalOverlay = null; // temporal_slow overlay
      this._baseFOV     = 72;

      // Full-screen flash overlay (child of camera so it moves with it)
      const fGeo = new THREE.PlaneGeometry(4, 4);
      this._flashMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        depthTest: false, depthWrite: false,
      });
      const flash = new THREE.Mesh(fGeo, this._flashMat);
      flash.position.z = -0.2;
      flash.renderOrder = 999;
      this.cam.add(flash);

      // Temporal slow overlay (blue tint, camera child)
      const tGeo = new THREE.PlaneGeometry(4, 4);
      this._temporalMat = new THREE.MeshBasicMaterial({
        color: 0x1020a0, transparent: true, opacity: 0,
        depthTest: false, depthWrite: false,
      });
      const tMesh = new THREE.Mesh(tGeo, this._temporalMat);
      tMesh.position.z = -0.19;
      tMesh.renderOrder = 998;
      this.cam.add(tMesh);

      this.cam.position.y = this.EY;
    }

    onResize() {
      this.cam.aspect = window.innerWidth / window.innerHeight;
      this.cam.updateProjectionMatrix();
      this._r.setSize(window.innerWidth, window.innerHeight);
    }

    // ── Build the 3-D scene for one level ──────────────────────

    initLevel(level) {
      // Dispose previous geometry / materials
      if (this._grp) {
        this._grp.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) [].concat(o.material).forEach(m => {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        });
        this.scene.remove(this._grp);
      }
      this._poolLights.forEach(l => this.scene.remove(l));
      this._poolLights = [];
      this.scene.children
        .filter(c => c.isAmbientLight)
        .forEach(l => this.scene.remove(l));

      this._grp = new THREE.Group();
      this.scene.add(this._grp);

      const len = level.length * this.S;
      const pal = level.pal;
      this._anomPoster = null;
      this._anomActive = false;
      this._shadowMesh = null;
      this._figureMesh = null;

      this._buildCorridor(len, pal);
      this._buildFixtures(len, pal);
      this._buildPillars(len, pal);
      this._buildPosters(len, level);
      this._buildDoors(len, pal);
      this._buildExitSigns(len);
      this._buildHazardStripes(len);
      this._buildFigure(level);
      this._buildShadow(level);

      // Fog + background
      this.scene.fog = new THREE.FogExp2(new THREE.Color(pal.ceiling), 0.025);
      this.scene.background = new THREE.Color(pal.ceiling);

      // Ambient light
      this.scene.add(new THREE.AmbientLight(new THREE.Color(pal.light), 0.12));

      // Pool of dynamic point-lights (repositioned each frame)
      for (let i = 0; i < 12; i++) {
        const pl = new THREE.PointLight(
          new THREE.Color(pal.light), 1.8, 12, 1.5,
        );
        pl.position.set(0, this.CH - 0.15, 0);
        this.scene.add(pl);
        this._poolLights.push(pl);
      }

      this.cam.position.set(0, this.EY, 0);
      this.cam.rotation.set(0, 0, 0);
      this.cam.fov = this._baseFOV;
      this.cam.updateProjectionMatrix();
      this._temporalMat.opacity = 0;
    }

    // ── Per-frame draw (same interface as the old 2-D version) ─

    draw(scrollPos, level, anomSt, glitchAlpha, flashAlpha, now) {
      const z = -scrollPos * this.S;

      // Camera position + subtle walking bob
      this.cam.position.z = z;
      this.cam.position.y = this.EY + Math.sin(scrollPos * 0.08) * 0.03;

      // Glitch → camera shake
      if (glitchAlpha > 0.01) {
        this.cam.position.x = (Math.random() - 0.5) * 0.12 * glitchAlpha;
        this.cam.rotation.z = (Math.random() - 0.5) * 0.025 * glitchAlpha;
      } else {
        this.cam.position.x = 0;
        this.cam.rotation.z = 0;
      }

      // Flash overlay
      this._flashMat.opacity = flashAlpha * 0.5;

      // Reposition dynamic lights near camera
      this._updateLights(z, now);

      // Anomaly poster swap
      this._updateAnomalyPoster(anomSt, now);

      // Stare figure — fade in via material opacity
      if (this._figureMesh) {
        const vis = anomSt && anomSt.type === 'stare_figure'
                    && anomSt.figureAlpha > 0;
        this._figureMesh.visible = !!vis;
        if (vis) {
          this._figureMat.opacity = anomSt.figureAlpha;
          // Subtle flicker when partially visible
          if (anomSt.figureAlpha < 0.9) {
            this._figureMat.opacity *= 0.85 + 0.15 * Math.sin(now * 0.02);
          }
        }
      }

      // Temporal slow — blue overlay + FOV shift
      if (anomSt && anomSt.type === 'temporal_slow' && anomSt.active) {
        this._temporalMat.opacity = 0.12 + 0.04 * Math.sin(now * 0.004);
        const targetFOV = 62;
        this.cam.fov += (targetFOV - this.cam.fov) * 0.05;
        this.cam.updateProjectionMatrix();
      } else {
        this._temporalMat.opacity *= 0.9; // fade out
        if (Math.abs(this.cam.fov - this._baseFOV) > 0.1) {
          this.cam.fov += (this._baseFOV - this.cam.fov) * 0.05;
          this.cam.updateProjectionMatrix();
        }
      }

      // Visual shadow — drift in wrong direction
      if (this._shadowMesh) {
        const active = anomSt && anomSt.type === 'visual_shadow' && anomSt.active;
        this._shadowMesh.visible = !!active;
        if (active) {
          this._shadowMat.opacity = 0.5 + 0.15 * Math.sin(now * 0.003);
          // Shadow drifts upward (wrong direction — should follow light downward)
          const drift = anomSt.phase * 0.8;
          this._shadowMesh.position.y = this._shadowBaseY + drift;
        }
      }

      this._r.render(this.scene, this.cam);
    }

    // ── Corridor geometry ──────────────────────────────────────

    _buildCorridor(len, pal) {
      const W = this.CW, H = this.CH;

      // Walls (tiled texture)
      const wGeo = new THREE.PlaneGeometry(len, H);

      const wTexL = this._tileTex(pal.wall, 0.14, 0.07, 0.5);
      wTexL.repeat.set(len / 1.5, H / 1.5);
      const wMatL = new THREE.MeshStandardMaterial({
        map: wTexL, roughness: 0.82, metalness: 0.02,
      });
      const lw = new THREE.Mesh(wGeo, wMatL);
      lw.rotation.y = Math.PI / 2;
      lw.position.set(-W / 2, H / 2, -len / 2);
      this._grp.add(lw);

      const wTexR = this._tileTex(pal.wall, 0.14, 0.07, 0.5);
      wTexR.repeat.set(len / 1.5, H / 1.5);
      const wMatR = new THREE.MeshStandardMaterial({
        map: wTexR, roughness: 0.82, metalness: 0.02,
      });
      const rw = new THREE.Mesh(wGeo.clone(), wMatR);
      rw.rotation.y = -Math.PI / 2;
      rw.position.set(W / 2, H / 2, -len / 2);
      this._grp.add(rw);

      // Floor (slightly reflective institutional tile)
      const fTex = this._tileTex(pal.floor, 0.18, 0.09, 0.5);
      fTex.repeat.set(W / 1.2, len / 1.2);
      const fMat = new THREE.MeshStandardMaterial({
        map: fTex, roughness: 0.55, metalness: 0.18,
      });
      const fGeo = new THREE.PlaneGeometry(W, len);
      const fl = new THREE.Mesh(fGeo, fMat);
      fl.rotation.x = -Math.PI / 2;
      fl.position.set(0, 0, -len / 2);
      this._grp.add(fl);

      // Ceiling
      const cTex = this._tileTex(pal.ceiling, 0.08, 0.04, 0.35);
      cTex.repeat.set(W / 2.5, len / 2.5);
      const cMat = new THREE.MeshStandardMaterial({
        map: cTex, roughness: 0.92, metalness: 0,
      });
      const cl = new THREE.Mesh(fGeo.clone(), cMat);
      cl.rotation.x = Math.PI / 2;
      cl.position.set(0, H, -len / 2);
      this._grp.add(cl);

      // Dado rails (horizontal wall trim)
      const dGeo = new THREE.BoxGeometry(0.06, 0.05, len);
      const dMat = new THREE.MeshStandardMaterial({
        color: darken(pal.wall, 0.3), roughness: 0.7,
      });
      const dadoY = H * 0.35;
      const dl = new THREE.Mesh(dGeo, dMat);
      dl.position.set(-W / 2 + 0.03, dadoY, -len / 2);
      this._grp.add(dl);
      const dr = new THREE.Mesh(dGeo.clone(), dMat);
      dr.position.set(W / 2 - 0.03, dadoY, -len / 2);
      this._grp.add(dr);
    }

    _buildFixtures(len, pal) {
      const sp  = CFG.LIGHT_SPACING * this.S;
      this._fixZs = [];
      const fGeo = new THREE.BoxGeometry(1.2, 0.04, 0.3);
      const fMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(pal.light),
      });
      for (let z = -sp; z > -len; z -= sp) {
        const m = new THREE.Mesh(fGeo, fMat);
        m.position.set(0, this.CH - 0.02, z);
        this._grp.add(m);
        this._fixZs.push(z);
      }
    }

    _buildPillars(len, pal) {
      const sp = CFG.PILLAR_SPACING * this.S;
      const W  = this.CW;
      const pGeo   = new THREE.BoxGeometry(0.25, this.CH, 0.25);
      const pMat   = new THREE.MeshStandardMaterial({
        color: pal.pillar, roughness: 0.7, metalness: 0.05,
      });
      const capGeo = new THREE.BoxGeometry(0.35, 0.12, 0.35);
      const capMat = new THREE.MeshStandardMaterial({
        color: lighten(pal.pillar, 0.08), roughness: 0.7,
      });
      for (let z = 0; z > -len; z -= sp) {
        for (const side of [-1, 1]) {
          const p = new THREE.Mesh(pGeo, pMat);
          p.position.set(side * (W / 2 - 0.13), this.CH / 2, z);
          this._grp.add(p);
          const c = new THREE.Mesh(capGeo, capMat);
          c.position.set(side * (W / 2 - 0.13), this.CH - 0.06, z);
          this._grp.add(c);
        }
      }
    }

    _buildPosters(len, level) {
      const sp = CFG.POSTER_SPACING * this.S;
      const W  = this.CW;
      const pw = 0.8, ph = 1.1;
      const pGeo = new THREE.PlaneGeometry(pw, ph);

      const anomIdx =
        level.hasAnomaly && level.anomaly.type === 'visual_poster'
          ? Math.floor(level.anomaly.progress * level.length / CFG.POSTER_SPACING)
          : -1;

      let idx = 0;
      for (let z = -sp; z > -len; z -= sp) {
        const side    = idx % 2 === 0 ? -1 : 1;
        const content = NORMAL_POSTERS[Math.abs(idx) % NORMAL_POSTERS.length];
        const tex     = this._posterTex(content, false);
        const mat     = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });

        const m = new THREE.Mesh(pGeo.clone(), mat);
        m.position.set(side * (W / 2 - 0.005), 1.9, z);
        m.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
        this._grp.add(m);

        if (idx === anomIdx) {
          this._anomPoster  = m;
          this._anomMatNorm = mat;
          const ac = ANOMALY_POSTERS[Math.abs(idx) % ANOMALY_POSTERS.length];
          this._anomMatAnom = new THREE.MeshStandardMaterial({
            map: this._posterTex(ac, true), roughness: 0.6,
            emissive: 0x330000, emissiveIntensity: 0.3,
          });
        }
        idx++;
      }
    }

    _buildDoors(len, pal) {
      const sp = 15;      // ≈ 1 500 virtual units
      const W  = this.CW;
      const dw = 0.9, dh = 2.4, dd = 0.12;
      const frameMat  = new THREE.MeshStandardMaterial({
        color: darken(pal.wall, 0.45), roughness: 0.8,
      });
      const doorMat   = new THREE.MeshStandardMaterial({
        color: darken(pal.wall, 0.25), roughness: 0.7,
      });
      const handleMat = new THREE.MeshStandardMaterial({
        color: lighten(pal.wall, 0.25), roughness: 0.3, metalness: 0.6,
      });
      const frameGeo  = new THREE.BoxGeometry(dd, dh + 0.05, dw + 0.1);
      const doorGeo   = new THREE.BoxGeometry(dd * 0.5, dh, dw);
      const handleGeo = new THREE.BoxGeometry(0.06, 0.1, 0.04);

      let i = 0;
      for (let z = -sp; z > -len; z -= sp) {
        const side = i % 2 === 0 ? 1 : -1;
        const frame  = new THREE.Mesh(frameGeo, frameMat);
        frame.position.set(side * (W / 2 - dd / 2), dh / 2, z);
        this._grp.add(frame);
        const door   = new THREE.Mesh(doorGeo, doorMat);
        door.position.set(side * (W / 2 - dd / 2), dh / 2, z);
        this._grp.add(door);
        const handle = new THREE.Mesh(handleGeo, handleMat);
        handle.position.set(
          side * (W / 2 - dd - 0.02), dh * 0.45, z + 0.28,
        );
        this._grp.add(handle);
        i++;
      }
    }

    _buildExitSigns(len) {
      const sp   = CFG.POSTER_SPACING * this.S * 2;
      const sGeo = new THREE.BoxGeometry(0.35, 0.14, 0.04);
      const sMat = new THREE.MeshBasicMaterial({ color: 0x40cc70 });
      for (let z = -sp * 1.5; z > -len; z -= sp) {
        const s = new THREE.Mesh(sGeo, sMat);
        s.position.set(0, this.CH - 0.2, z);
        this._grp.add(s);
      }
    }

    _buildHazardStripes(len) {
      const sp   = CFG.PILLAR_SPACING * this.S;
      const W    = this.CW;
      const sGeo = new THREE.PlaneGeometry(0.6, 0.04);
      const sMat = new THREE.MeshBasicMaterial({
        color: 0xb48c14, transparent: true, opacity: 0.5,
      });
      for (let z = 0; z > -len; z -= sp) {
        for (const sx of [-1, 1]) {
          const s = new THREE.Mesh(sGeo, sMat);
          s.rotation.x = -Math.PI / 2;
          s.position.set(sx * (W / 2 - 0.3), 0.005, z);
          this._grp.add(s);
        }
      }
    }

    _buildFigure(level) {
      this._figureMesh = null;
      if (!level.hasAnomaly || level.anomaly.type !== 'stare_figure') return;

      const mat = new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0,
      });

      // Composite humanoid silhouette: head, torso, arms, legs
      const grp = new THREE.Group();

      // Head
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), mat);
      head.position.y = 1.65;
      grp.add(head);

      // Torso
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.6, 0.18), mat);
      torso.position.y = 1.25;
      grp.add(torso);

      // Arms
      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.1), mat);
        arm.position.set(side * 0.22, 1.22, 0);
        grp.add(arm);
      }

      // Legs
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), mat);
        leg.position.set(side * 0.1, 0.55, 0);
        grp.add(leg);
      }

      const trigZ = -level.anomaly.progress * level.length * this.S;
      grp.position.set(0, 0, trigZ - 8);
      grp.visible = false;
      this._figureMesh = grp;
      this._figureMat  = mat;
      this._grp.add(grp);
    }

    _buildShadow(level) {
      this._shadowMesh = null;
      if (!level.hasAnomaly || level.anomaly.type !== 'visual_shadow') return;

      // Human-shaped shadow silhouette on left wall
      const shadowGrp = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0, side: THREE.DoubleSide,
      });

      // Shadow head
      const head = new THREE.Mesh(new THREE.CircleGeometry(0.15, 12), mat);
      head.position.y = 1.7;
      shadowGrp.add(head);

      // Shadow body
      const body = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 1.1), mat);
      body.position.y = 1.0;
      shadowGrp.add(body);

      // Shadow legs
      for (const side of [-0.1, 0.1]) {
        const leg = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.5), mat);
        leg.position.set(side, 0.3, 0);
        shadowGrp.add(leg);
      }

      const trigZ = -level.anomaly.progress * level.length * this.S;
      shadowGrp.rotation.y = Math.PI / 2;
      shadowGrp.position.set(-this.CW / 2 + 0.01, 0, trigZ);
      shadowGrp.visible = false;
      this._shadowMesh  = shadowGrp;
      this._shadowMat   = mat;
      this._shadowBaseY = 0;
      this._grp.add(shadowGrp);
    }

    // ── Per-frame helpers ──────────────────────────────────────

    _updateLights(camZ, now) {
      const sorted = this._fixZs
        .map(fz => ({ z: fz, d: Math.abs(fz - camZ) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this._poolLights.length);
      this._poolLights.forEach((pl, i) => {
        if (i < sorted.length) {
          pl.visible   = true;
          pl.position.z = sorted[i].z;
          // Subtle flicker
          pl.intensity = 1.8 * (0.85 + 0.15 * Math.sin(now * 0.003 + i * 7.3));
        } else {
          pl.visible = false;
        }
      });
    }

    _updateAnomalyPoster(anomSt, now) {
      if (!this._anomPoster) return;
      const active = !!(
        anomSt && anomSt.type === 'visual_poster' && anomSt.active
      );
      if (active !== this._anomActive) {
        this._anomPoster.material =
          active ? this._anomMatAnom : this._anomMatNorm;
        this._anomActive = active;
      }
      // Pulsing emissive when anomaly is active
      if (active && this._anomMatAnom) {
        this._anomMatAnom.emissiveIntensity =
          0.3 + 0.2 * Math.sin(now * 0.005);
      }
    }

    // ── Procedural texture generators ──────────────────────────

    _tileTex(baseHex, lightA, lightB, groutDark) {
      const c = document.createElement('canvas');
      const s = 128;
      c.width = s; c.height = s;
      const x = c.getContext('2d');

      x.fillStyle = darken(baseHex, groutDark);
      x.fillRect(0, 0, s, s);
      const colA = lighten(baseHex, lightA);
      const colB = lighten(baseHex, lightB);
      const tw = s / 4, th = s / 4;
      for (let r = 0; r < 4; r++) {
        for (let col = 0; col < 4; col++) {
          x.fillStyle = (r + col) % 2 === 0 ? colA : colB;
          x.fillRect(col * tw + 1, r * th + 1, tw - 2, th - 2);
        }
      }
      const tex  = new THREE.CanvasTexture(c);
      tex.wrapS  = THREE.RepeatWrapping;
      tex.wrapT  = THREE.RepeatWrapping;
      tex.encoding = THREE.sRGBEncoding;
      return tex;
    }

    _posterTex(content, isAnom) {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 180;
      const x = c.getContext('2d');

      x.fillStyle = isAnom ? '#3a0505' : content.bg;
      x.fillRect(0, 0, 128, 180);
      if (isAnom) {
        x.strokeStyle = '#dc2828';
        x.lineWidth = 3;
        x.strokeRect(2, 2, 124, 176);
      }
      x.fillStyle    = isAnom ? '#ff6060' : 'rgba(255,255,255,0.88)';
      x.font         = "bold 18px 'Courier New', monospace";
      x.textAlign    = 'center';
      x.textBaseline = 'middle';
      const lh = 180 / (content.lines.length + 1);
      content.lines.forEach((line, i) => {
        x.fillText(line, 64, lh * (i + 1));
      });
      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      return tex;
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
        if (e.key === 'ArrowRight' || e.key === 'd') this._onScroll( 12 * CFG.SCROLL_FACTOR);
        if (e.key === 'ArrowLeft'  || e.key === 'a') this._onScroll(-12 * CFG.SCROLL_FACTOR);
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
        // Fade in over 2.5s of being inside the anomaly window
        const elapsed = now - s.enteredAt;
        s.figureAlpha = clamp(elapsed / 2500, 0, 1);
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
      if (this.state.type === 'stare_figure' && this.state.figureAlpha < 0.3) {
        // Figure must be at least partially visible
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
  //  LEADERBOARD  (localStorage-backed)
  // ════════════════════════════════════════════════════════════
  const LB_KEY = 'anomaly_scroller_leaderboard';
  const LB_MAX = 20;

  class Leaderboard {
    constructor() {
      this._entries = this._load();
    }

    _load() {
      try {
        const raw = localStorage.getItem(LB_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    }

    _save() {
      try { localStorage.setItem(LB_KEY, JSON.stringify(this._entries)); }
      catch { /* quota exceeded — silently ignore */ }
    }

    /** Add a new entry. Returns the rank (1-based) or -1 if not added. */
    add(name, timeMs) {
      const entry = {
        name: (name || 'ANONYMOUS').toUpperCase().slice(0, 16),
        time: timeMs,
        date: new Date().toISOString().slice(0, 10),
      };
      this._entries.push(entry);
      this._entries.sort((a, b) => a.time - b.time);
      if (this._entries.length > LB_MAX) this._entries.length = LB_MAX;
      this._save();
      return this._entries.indexOf(entry) + 1;
    }

    getAll() { return this._entries; }

    clear() {
      this._entries = [];
      this._save();
    }

    /** Render into the leaderboard table body */
    render(tbodyEl, emptyEl, highlightIdx) {
      tbodyEl.innerHTML = '';
      if (this._entries.length === 0) {
        emptyEl.classList.remove('hidden');
        return;
      }
      emptyEl.classList.add('hidden');
      this._entries.forEach((e, i) => {
        const tr = document.createElement('tr');
        if (i === highlightIdx) tr.classList.add('highlight');
        tr.innerHTML = `<td>${i + 1}</td><td>${this._esc(e.name)}</td>`
          + `<td>${this._fmtTime(e.time)}</td><td>${e.date}</td>`;
        tbodyEl.appendChild(tr);
      });
    }

    _fmtTime(ms) {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return `${m}:${String(sec).padStart(2, '0')}`;
    }

    _esc(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
  }

  // ════════════════════════════════════════════════════════════
  //  GAME  (main state machine)
  // ════════════════════════════════════════════════════════════
  const STATE = {
    MENU:         'menu',
    PLAYING:      'playing',
    RETURNING:    'returning',
    CLEAR:        'clear',
    GAMEOVER:     'gameover',
    VICTORY:      'victory',
    LEADERBOARD:  'leaderboard',
  };

  class Game {
    constructor() {
      // DOM
      this.$canvas  = document.getElementById('gameCanvas');
      this.$hud     = document.getElementById('hud');
      this.$secNum  = document.getElementById('section-num');
      this.$pfill   = document.getElementById('progress-fill');
      this.$pdot    = document.getElementById('progress-dot');
      this.$timer   = document.getElementById('hud-timer');
      this.$stareRing   = document.getElementById('stare-ring');
      this.$msgBanner   = document.getElementById('msg-banner');
      this.$scrollHint  = document.getElementById('scroll-hint');

      this.$screens = {
        [STATE.MENU]:        document.getElementById('screen-menu'),
        [STATE.GAMEOVER]:    document.getElementById('screen-gameover'),
        [STATE.CLEAR]:       document.getElementById('screen-clear'),
        [STATE.VICTORY]:     document.getElementById('screen-victory'),
        [STATE.LEADERBOARD]: document.getElementById('screen-leaderboard'),
      };

      // Systems
      this.audio    = new AudioSystem();
      this.renderer = new Renderer(this.$canvas);
      this.renderer.initLevel(LEVELS[0]);
      this.anomaly  = new AnomalySystem();
      this.stare    = new StareDetector(() => this._onStareComplete());
      this.input    = new InputController(
        (d) => this._handleScroll(d),
        ()  => this._handleReverse()
      );
      this.leaderboard = new Leaderboard();

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

      // Timer for leaderboard
      this._runStartT    = 0;
      this._lastLBRank   = -1; // highlight index after victory

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

      // Leaderboard
      document.getElementById('btn-leaderboard') .addEventListener('click', () => this._showLeaderboard());
      document.getElementById('btn-lb-victory')  .addEventListener('click', () => this._showLeaderboard());
      document.getElementById('btn-lb-back')     .addEventListener('click', () => this._setState(this._lbReturnState || STATE.MENU));

      // Prevent scroll input from propagating when typing in name field
      document.getElementById('player-name').addEventListener('keydown', (e) => e.stopPropagation());
    }

    // ── Game flow ──────────────────────────────────────────────

    _startGame() {
      this.levelIdx    = 0;
      this.scrollPos   = 0;
      this._runStartT  = performance.now();
      this._playerName = (document.getElementById('player-name').value || '').trim();
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
      this.renderer.initLevel(level);

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
        const elapsed = performance.now() - this._runStartT;
        // Show time on victory screen
        const lb = this.leaderboard;
        document.getElementById('vic-time').textContent =
          `Completion time: ${lb._fmtTime(elapsed)}`;
        // Save to leaderboard
        const rank = lb.add(this._playerName, elapsed);
        this._lastLBRank = rank - 1; // 0-based for highlight
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
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 4200);
    }

    _showLeaderboard() {
      this._lbReturnState = this.state;
      this._renderLeaderboard();
      this._setState(STATE.LEADERBOARD);
    }

    _renderLeaderboard() {
      this.leaderboard.render(
        document.getElementById('lb-body'),
        document.getElementById('lb-empty'),
        this._lastLBRank >= 0 ? this._lastLBRank : -1,
      );
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

      // Timer display
      const elapsed = now - this._runStartT;
      this.$timer.textContent = this.leaderboard._fmtTime(elapsed);
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
