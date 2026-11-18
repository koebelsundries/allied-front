import * as THREE from "../vendor/three.module.min.js";

const ALL_GAMES = "https://koebelsundries.github.io/kids-games/";
const $ = (id) => document.getElementById(id);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (n) => Math.floor(Math.random() * n);
const deg = (d) => d * Math.PI / 180;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const DIFF = {
  easy: {
    hp: 200, dmgIn: 0.4, enemySpread: 0.22, enemyRof: 1.15, enemyDmg: 7,
    enemyReact: 1.0, enemyMove: 1.7, packs: 3, ammoMul: 1.5, grace: 4
  },
  normal: {
    hp: 100, dmgIn: 1, enemySpread: 0.085, enemyRof: 0.62, enemyDmg: 14,
    enemyReact: 0.38, enemyMove: 2.3, packs: 1, ammoMul: 1, grace: 2.2
  }
};

const WPN = {
  rifle: {
    id: "rifle", name: "RIFLE", semi: true, dmg: 55, rpm: 280, mag: 8, reserve: 40,
    reload: 2.15, spreadHip: 0.016, spreadAds: 0.0028, range: 90,
    kick: 0.05, adsKick: 0.024, ping: true
  },
  smg: {
    id: "smg", name: "SMG", semi: false, dmg: 22, rpm: 540, mag: 30, reserve: 90,
    reload: 1.7, spreadHip: 0.038, spreadAds: 0.012, range: 55,
    kick: 0.03, adsKick: 0.014, ping: false
  }
};

/* ---------------- Audio (synthesized) ---------------- */
const SFX = {
  ctx: null,
  master: null,
  muted: localStorage.getItem("allied-front-muted") === "1",
  _wind: null,
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(this.ctx.destination);
  },
  resume() {
    this.ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    this.startWind();
  },
  setMuted(m) {
    this.muted = m;
    localStorage.setItem("allied-front-muted", m ? "1" : "0");
    if (this.master) this.master.gain.value = m ? 0 : 0.7;
    updateMuteButtons();
  },
  toggle() { this.setMuted(!this.muted); },
  now() { return this.ctx ? this.ctx.currentTime : 0; },
  noiseBuf(sec) {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * sec);
    const buf = this.ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  },
  envGain(t, a, hold, d, peak = 1) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
    return g;
  },
  filter(type, freq, q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    return f;
  },
  shoot(kind, dist = 0) {
    if (!this.ctx) return;
    const t = this.now();
    const att = dist > 0 ? clamp(1.4 / (1 + dist * 0.12), 0.12, 0.85) : 1;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf(0.25);
    const bp = this.filter("bandpass", kind === "rifle" ? 900 : 1400, 0.7);
    const hp = this.filter("highpass", kind === "rifle" ? 180 : 280);
    const g = this.envGain(t, 0.004, 0.01, kind === "rifle" ? 0.16 : 0.09, att * (kind === "rifle" ? 0.9 : 0.55));
    src.connect(bp); bp.connect(hp); hp.connect(g); g.connect(this.master);
    // low thump
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(kind === "rifle" ? 120 : 160, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const og = this.envGain(t, 0.002, 0.01, 0.12, att * (kind === "rifle" ? 0.7 : 0.35));
    osc.connect(og); og.connect(this.master);
    src.start(t); src.stop(t + 0.25);
    osc.start(t); osc.stop(t + 0.14);
    if (kind === "rifle") {
      const click = this.ctx.createOscillator();
      click.type = "square";
      click.frequency.value = 2200;
      const cg = this.envGain(t, 0.001, 0.004, 0.03, att * 0.12);
      click.connect(cg); cg.connect(this.master);
      click.start(t); click.stop(t + 0.04);
    }
  },
  ping() {
    if (!this.ctx) return;
    const t = this.now();
    [2680, 3120, 3450].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = i === 2 ? "triangle" : "sine";
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.92, t + 0.7);
      const g = this.envGain(t + i * 0.012, 0.002, 0.02, 0.65, 0.18 - i * 0.04);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.012); o.stop(t + 0.85);
    });
  },
  reload() {
    if (!this.ctx) return;
    const t = this.now();
    for (let i = 0; i < 3; i++) {
      const o = this.ctx.createOscillator();
      o.type = "square";
      o.frequency.value = 420 + i * 180 + rand(-30, 30);
      const g = this.envGain(t + 0.08 + i * 0.18, 0.001, 0.01, 0.05, 0.07);
      o.connect(g); g.connect(this.master);
      o.start(t + 0.08 + i * 0.18); o.stop(t + 0.2 + i * 0.18);
    }
  },
  foot(onStone) {
    if (!this.ctx) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf(0.08);
    const lp = this.filter("lowpass", onStone ? 900 : 420, 0.8);
    const g = this.envGain(t, 0.004, 0.01, 0.07, onStone ? 0.12 : 0.16);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.09);
  },
  hit() {
    if (!this.ctx) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf(0.12);
    const lp = this.filter("lowpass", 700);
    const g = this.envGain(t, 0.002, 0.01, 0.1, 0.22);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.12);
  },
  playerHit() {
    if (!this.ctx) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.2);
    const g = this.envGain(t, 0.002, 0.02, 0.25, 0.35);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.28);
  },
  thud() {
    if (!this.ctx) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = this.envGain(t, 0.004, 0.04, 0.22, 0.4);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.3);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf(0.18);
    const lp = this.filter("lowpass", 400);
    const ng = this.envGain(t, 0.005, 0.02, 0.15, 0.2);
    src.connect(lp); lp.connect(ng); ng.connect(this.master);
    src.start(t); src.stop(t + 0.2);
  },
  pickup() {
    if (!this.ctx) return;
    const t = this.now();
    [520, 740, 980].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = this.envGain(t + i * 0.06, 0.005, 0.04, 0.16, 0.12);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.06); o.stop(t + 0.28 + i * 0.06);
    });
  },
  ui() {
    if (!this.ctx) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = 660;
    const g = this.envGain(t, 0.001, 0.01, 0.06, 0.08);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.08);
  },
  win() {
    if (!this.ctx) return;
    const t = this.now();
    [392, 523, 659, 784].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const g = this.envGain(t + i * 0.14, 0.01, 0.08, 0.28, 0.16);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.14); o.stop(t + 0.5 + i * 0.14);
    });
  },
  lose() {
    if (!this.ctx) return;
    const t = this.now();
    [330, 247, 196].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = this.envGain(t + i * 0.22, 0.01, 0.1, 0.3, 0.14);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.22); o.stop(t + 0.5 + i * 0.22);
    });
  },
  startWind() {
    if (!this.ctx || this._wind) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf(3);
    src.loop = true;
    const f = this.filter("bandpass", 280, 0.6);
    const g = this.ctx.createGain();
    g.gain.value = 0.035;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
    this._wind = src;
  }
};

function updateMuteButtons() {
  const label = SFX.muted ? "🔇" : "🔊";
  const a = $("btn-mute"), b = $("btn-mute-hud");
  if (a) a.textContent = label;
  if (b) b.textContent = label;
}

/* ---------------- Three.js core ---------------- */
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setClearColor(0x8a8b80, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x8e8f84, 0.026);
scene.background = new THREE.Color(0x8e8f84);

const camera = new THREE.PerspectiveCamera(72, 2, 0.05, 180);
const menuCam = new THREE.PerspectiveCamera(62, 2, 0.1, 200);

let pixelCap = 1.5;
function fitRenderer() {
  const w = window.innerWidth, h = window.innerHeight;
  const isCoarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  pixelCap = isCoarse ? 1.25 : 1.5;
  const pr = Math.min(window.devicePixelRatio || 1, pixelCap);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  menuCam.aspect = camera.aspect;
  menuCam.updateProjectionMatrix();
}
window.addEventListener("resize", fitRenderer);

/* ---------------- Textures ---------------- */
function makeTex(size, paint, repeatX = 1, repeatY = 1) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}
function rgb(ctx, r, g, b) { ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`; }

function texDirt(ctx, s) {
  rgb(ctx, 94, 78, 54); ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2600; i++) {
    const x = hash2(i, 1) * s, y = hash2(i, 2) * s;
    const n = hash2(i, 3);
    rgb(ctx, 80 + n * 36, 66 + n * 26, 44 + n * 16);
    ctx.fillRect(x, y, 1 + hash2(i, 4) * 2, 1 + hash2(i, 5) * 2);
  }
  for (let i = 0; i < 16; i++) {
    const x = hash2(i, 9) * s, y = hash2(i, 10) * s, r = 8 + hash2(i, 11) * 10;
    ctx.fillStyle = `rgba(70,56,38,${0.10 + hash2(i, 12) * 0.12})`;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.65, hash2(i, 13) * 3, 0, 7); ctx.fill();
  }
}
function texGrass(ctx, s) {
  rgb(ctx, 62, 68, 42); ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 1800; i++) {
    const x = hash2(i, 21) * s, y = hash2(i, 22) * s;
    rgb(ctx, 50 + hash2(i, 23) * 40, 62 + hash2(i, 24) * 46, 30 + hash2(i, 25) * 20);
    ctx.fillRect(x, y, 1, 2 + hash2(i, 26) * 3);
  }
}
function texCobble(ctx, s) {
  rgb(ctx, 62, 60, 54); ctx.fillRect(0, 0, s, s);
  const cols = 5, rows = 5, tw = s / cols, th = s / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const jx = (hash2(i, j + 40) - 0.5) * 4;
      const jy = (hash2(i, j + 41) - 0.5) * 4;
      const n = hash2(i, j + 42);
      rgb(ctx, 88 + n * 40, 84 + n * 36, 74 + n * 28);
      const pad = 2;
      ctx.fillRect(i * tw + pad + jx, j * th + pad + jy, tw - pad * 2, th - pad * 2);
      ctx.strokeStyle = `rgba(40,38,32,0.45)`;
      ctx.strokeRect(i * tw + pad + jx, j * th + pad + jy, tw - pad * 2, th - pad * 2);
    }
  }
}
function texPlaster(ctx, s) {
  rgb(ctx, 168, 156, 132); ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 1600; i++) {
    const n = hash2(i, 60);
    rgb(ctx, 150 + n * 40, 140 + n * 30, 116 + n * 24);
    ctx.fillRect(hash2(i, 61) * s, hash2(i, 62) * s, 2, 2);
  }
  ctx.strokeStyle = "rgba(80,70,50,0.28)";
  ctx.beginPath();
  ctx.moveTo(10, 20); ctx.lineTo(40, 80); ctx.lineTo(70, 90);
  ctx.moveTo(120, 10); ctx.lineTo(90, 200);
  ctx.stroke();
  // dirt stains
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = `rgba(70,55,35,${0.08 + hash2(i, 70) * 0.12})`;
    ctx.beginPath();
    ctx.ellipse(hash2(i, 71) * s, s * 0.7 + hash2(i, 72) * s * 0.3, 18, 10, 0, 0, 7);
    ctx.fill();
  }
}
function texStone(ctx, s) {
  rgb(ctx, 78, 76, 70); ctx.fillRect(0, 0, s, s);
  const cols = 4, rows = 4, tw = s / cols, th = s / rows;
  for (let j = 0; j < rows; j++) {
    const off = (j % 2) * tw * 0.5;
    for (let i = -1; i < cols; i++) {
      const n = hash2(i + 3, j + 80);
      rgb(ctx, 90 + n * 45, 88 + n * 40, 80 + n * 32);
      ctx.fillRect(i * tw + off + 1, j * th + 1, tw - 2, th - 2);
    }
  }
}
function texWood(ctx, s) {
  const plank = s / 4;
  for (let i = 0; i < 4; i++) {
    const n = hash2(i, 90);
    rgb(ctx, 92 + n * 30, 64 + n * 20, 38 + n * 12);
    ctx.fillRect(0, i * plank, s, plank - 1);
    for (let x = 0; x < s; x++) {
      const g = 8 * Math.sin((x + i * 20) * 0.2 + hash2(i, 91));
      rgb(ctx, 80 + g + n * 20, 54 + g * 0.6, 30);
      ctx.fillRect(x, i * plank + 2 + (hash2(x, i) * (plank - 6)), 1, 1);
    }
    ctx.fillStyle = "rgba(30,20,10,0.4)";
    ctx.fillRect(0, (i + 1) * plank - 1, s, 1);
  }
}
function texDarkWood(ctx, s) {
  texWood(ctx, s);
  ctx.fillStyle = "rgba(20,12,6,0.35)";
  ctx.fillRect(0, 0, s, s);
}
function texRoof(ctx, s) {
  rgb(ctx, 58, 44, 36); ctx.fillRect(0, 0, s, s);
  const rows = 8, th = s / rows;
  for (let j = 0; j < rows; j++) {
    const off = (j % 2) * 8;
    for (let i = -1; i < 10; i++) {
      const n = hash2(i, j + 100);
      rgb(ctx, 68 + n * 30, 48 + n * 16, 38 + n * 12);
      ctx.fillRect(i * (s / 8) + off, j * th + 1, s / 8 - 2, th - 2);
    }
  }
}
function texCrate(ctx, s) {
  rgb(ctx, 110, 82, 48); ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "rgba(50,32,16,0.8)";
  ctx.lineWidth = 8;
  ctx.strokeRect(6, 6, s - 12, s - 12);
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(8, 8); ctx.lineTo(s - 8, s - 8); ctx.moveTo(s - 8, 8); ctx.lineTo(8, s - 8); ctx.stroke();
  ctx.lineWidth = 10;
  ctx.strokeRect(2, 2, s - 4, s - 4);
  for (let i = 0; i < 200; i++) {
    const n = hash2(i, 110);
    ctx.fillStyle = `rgba(40,25,10,${n * 0.2})`;
    ctx.fillRect(hash2(i, 111) * s, hash2(i, 112) * s, 2, 2);
  }
}
function texSand(ctx, s) {
  rgb(ctx, 132, 118, 82); ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2000; i++) {
    const n = hash2(i, 120);
    rgb(ctx, 120 + n * 40, 108 + n * 30, 70 + n * 24);
    ctx.fillRect(hash2(i, 121) * s, hash2(i, 122) * s, 2, 2);
  }
  // sack seams
  ctx.strokeStyle = "rgba(60,50,30,0.35)";
  ctx.lineWidth = 2;
  for (let y = 8; y < s; y += 16) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y + 4); ctx.stroke(); }
}
function texMetal(ctx, s) {
  rgb(ctx, 72, 74, 68); ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 800; i++) {
    const n = hash2(i, 130);
    rgb(ctx, 80 + n * 40, 82 + n * 40, 76 + n * 30);
    ctx.fillRect(hash2(i, 131) * s, hash2(i, 132) * s, 1, 2);
  }
  ctx.fillStyle = "rgba(20,20,16,0.25)";
  ctx.fillRect(0, s * 0.45, s, 3);
}
function texBrick(ctx, s) {
  rgb(ctx, 70, 48, 40); ctx.fillRect(0, 0, s, s);
  const rows = 8, cols = 4, tw = s / cols, th = s / rows;
  for (let j = 0; j < rows; j++) {
    const off = (j % 2) * tw * 0.5;
    for (let i = -1; i <= cols; i++) {
      const n = hash2(i, j + 140);
      rgb(ctx, 110 + n * 40, 62 + n * 20, 48 + n * 12);
      ctx.fillRect(i * tw + off + 1, j * th + 1, tw - 2, th - 2);
    }
  }
}
function texShutters(ctx, s) {
  rgb(ctx, 62, 78, 86); ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = "rgba(30,40,46,0.5)";
  for (let x = 6; x < s; x += 10) ctx.fillRect(x, 0, 3, s);
}

const TEX = {};
const MATS = {};
function buildMaterials() {
  TEX.dirt = makeTex(256, texDirt, 1, 1);
  TEX.grass = makeTex(256, texGrass, 1, 1);
  TEX.cobble = makeTex(256, texCobble, 1, 1);
  TEX.plaster = makeTex(256, texPlaster, 1, 1);
  TEX.stone = makeTex(256, texStone, 1, 1);
  TEX.wood = makeTex(256, texWood, 1, 1);
  TEX.darkWood = makeTex(256, texDarkWood, 1, 1);
  TEX.roof = makeTex(256, texRoof, 1, 1);
  TEX.crate = makeTex(128, texCrate, 1, 1);
  TEX.sand = makeTex(128, texSand, 1, 1);
  TEX.metal = makeTex(128, texMetal, 1, 1);
  TEX.brick = makeTex(128, texBrick, 1, 1);
  TEX.shut = makeTex(64, texShutters, 1, 1);

  const l = (map, color, opts = {}) => new THREE.MeshLambertMaterial({ map, color: color ?? 0xffffff, ...opts });
  MATS.dirt = l(TEX.dirt);
  MATS.grass = l(TEX.grass);
  MATS.cobble = l(TEX.cobble);
  MATS.plaster = l(TEX.plaster, 0xe8dcc4);
  MATS.stone = l(TEX.stone);
  MATS.wood = l(TEX.wood);
  MATS.darkWood = l(TEX.darkWood);
  MATS.roof = l(TEX.roof);
  MATS.crate = l(TEX.crate);
  MATS.sand = l(TEX.sand, 0xc8b888);
  MATS.metal = l(TEX.metal, 0x9aa090);
  MATS.brick = l(TEX.brick);
  MATS.shut = l(TEX.shut, 0x6a8894);
  MATS.dark = new THREE.MeshLambertMaterial({ color: 0x1a1814 });
  MATS.glass = new THREE.MeshLambertMaterial({ color: 0x1c1e1c });
  MATS.leaf = new THREE.MeshLambertMaterial({ color: 0x3a4630 });
  MATS.trunk = new THREE.MeshLambertMaterial({ color: 0x3a2a1c });
  MATS.hedge = new THREE.MeshLambertMaterial({ color: 0x3d4a32 });
  MATS.flag = new THREE.MeshLambertMaterial({ color: 0x2a4a7a });
  MATS.star = new THREE.MeshLambertMaterial({ color: 0xe8d48a, emissive: 0x33280a });
  MATS.radioGlow = new THREE.MeshLambertMaterial({ color: 0x4aff6a, emissive: 0x1aee44, emissiveIntensity: 0.8 });
  MATS.uniform = new THREE.MeshLambertMaterial({ color: 0x5c5e54 });
  MATS.helmet = new THREE.MeshLambertMaterial({ color: 0x3a3d36 });
  MATS.skin = new THREE.MeshLambertMaterial({ color: 0xb89a78 });
  MATS.boot = new THREE.MeshLambertMaterial({ color: 0x1c1b17 });
  MATS.gunmetal = new THREE.MeshLambertMaterial({ color: 0x2a2c28 });
  MATS.gunwood = new THREE.MeshLambertMaterial({ color: 0x5a3e28 });
  MATS.flash = new THREE.MeshBasicMaterial({ color: 0xffe08a, toneMapped: false, transparent: true, opacity: 0.95 });
  MATS.tracer = new THREE.MeshBasicMaterial({ color: 0xffd27a, toneMapped: false, transparent: true, opacity: 0.85 });
  MATS.dust = new THREE.MeshBasicMaterial({ color: 0xc8b896, transparent: true, opacity: 0.7 });
  MATS.pack = new THREE.MeshLambertMaterial({ color: 0xd8d0c4 });
  MATS.cross = new THREE.MeshLambertMaterial({ color: 0xb02018 });
}

function matClone(base, rx, ry) {
  const m = base.clone();
  if (base.map) {
    m.map = base.map.clone();
    m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
    m.map.repeat.set(rx, ry);
    m.map.needsUpdate = true;
  }
  return m;
}

/* ---------------- Collision / rays ---------------- */
const colliders = [];
function addCollider(x, y, z, w, h, d) {
  const c = { minx: x - w / 2, maxx: x + w / 2, miny: y, maxy: y + h, minz: z - d / 2, maxz: z + d / 2 };
  colliders.push(c);
  return c;
}
function hitsAABB(px, py, pz, r, h) {
  const minx = px - r, maxx = px + r, miny = py, maxy = py + h, minz = pz - r, maxz = pz + r;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (maxx > c.minx && minx < c.maxx && maxy > c.miny && miny < c.maxy && maxz > c.minz && minz < c.maxz) return c;
  }
  return null;
}
function rayAABB(ox, oy, oz, dx, dy, dz, c, maxT) {
  let tmin = 0, tmax = maxT;
  const min = [c.minx, c.miny, c.minz], max = [c.maxx, c.maxy, c.maxz], o = [ox, oy, oz], d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
    } else {
      const inv = 1 / d[i];
      let t1 = (min[i] - o[i]) * inv, t2 = (max[i] - o[i]) * inv;
      if (t1 > t2) { const k = t1; t1 = t2; t2 = k; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmax < tmin) return null;
    }
  }
  return tmin;
}
function rayWorld(ox, oy, oz, dx, dy, dz, maxT, ignoreBelow = -1) {
  let best = maxT, hit = null;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.maxy <= ignoreBelow) continue;
    const t = rayAABB(ox, oy, oz, dx, dy, dz, c, best);
    if (t != null && t < best) { best = t; hit = c; }
  }
  // ground
  if (dy < -1e-6) {
    const t = (0.02 - oy) / dy;
    if (t > 0 && t < best) { best = t; hit = "ground"; }
  }
  return hit ? { t: best, hit } : null;
}


/* ---------------- Level helpers ---------------- */
const world = new THREE.Group();
scene.add(world);
const coverPts = [];
const pickups = [];
const tracers = [];
const particles = [];
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpRay = new THREE.Raycaster();

function mesh(geo, mat, x, y, z, parent = world) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = false;
  parent.add(m);
  return m;
}
function boxMesh(w, h, d, mat, x, y, z, parent, collide = false) {
  const m = mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent);
  if (collide) addCollider(x, y - h / 2, z, w, h, d);
  return m;
}

function addCover(x, z, yaw = 0) {
  coverPts.push({ x, z, yaw });
}

function pitchedRoof(cx, y, cz, w, d, rh, mat, alongZ = true) {
  const g = new THREE.Group();
  g.position.set(cx, y, cz);
  const lean = Math.atan2(rh, (alongZ ? d : w) / 2);
  const len = Math.hypot(rh, (alongZ ? d : w) / 2) + 0.08;
  const thick = 0.1;
  const overhang = 0.3;
  for (const side of [-1, 1]) {
    const sl = mesh(new THREE.BoxGeometry(alongZ ? w + overhang * 2 : len, thick, alongZ ? len : d + overhang * 2), mat, 0, 0, 0, g);
    if (alongZ) {
      sl.rotation.x = side * lean;
      sl.position.z = side * (d / 4);
      sl.position.y = rh / 2;
    } else {
      sl.rotation.z = -side * lean;
      sl.position.x = side * (w / 4);
      sl.position.y = rh / 2;
    }
  }
  world.add(g);
  return g;
}

function windowPane(x, y, z, w, h, face) {
  const g = new THREE.Group();
  const glass = mesh(new THREE.BoxGeometry(face === "x" ? 0.04 : w, h, face === "x" ? w : 0.04), MATS.glass, 0, 0, 0, g);
  const sw = 0.08, sh = h * 0.85;
  const shutL = mesh(new THREE.BoxGeometry(face === "x" ? 0.05 : sw, sh, face === "x" ? sw : 0.05), MATS.shut, 0, 0, 0, g);
  const shutR = shutL.clone(); g.add(shutR);
  if (face === "x") {
    shutL.position.set(0.02, 0, -w / 2 - sw / 2);
    shutR.position.set(0.02, 0, w / 2 + sw / 2);
  } else {
    shutL.position.set(-w / 2 - sw / 2, 0, 0.02);
    shutR.position.set(w / 2 + sw / 2, 0, 0.02);
  }
  g.position.set(x, y, z);
  world.add(g);
}

function doorRecess(x, y, z, w, h, face) {
  const d = 0.12;
  mesh(
    new THREE.BoxGeometry(face === "x" ? d : w, h, face === "x" ? w : d),
    MATS.dark, x, y, z
  );
}

function solidBuilding(opts) {
  const { x, z, w, d, h, roofH = 1.4, stories = 1, door = "-z", chimney = false, stoneBase = true } = opts;
  const baseH = stoneBase ? Math.min(1.15, h * 0.4) : 0;
  if (baseH > 0) {
    boxMesh(w, baseH, d, matClone(MATS.stone, w / 2, baseH / 1.5), x, baseH / 2, z, world);
    boxMesh(w, h - baseH, d, matClone(MATS.plaster, w / 2.2, (h - baseH) / 2.2), x, baseH + (h - baseH) / 2, z, world);
  } else {
    boxMesh(w, h, d, matClone(MATS.plaster, w / 2.2, h / 2.2), x, h / 2, z, world);
  }
  addCollider(x, 0, z, w, h + 0.2, d);
  pitchedRoof(x, h, z, w, d, roofH, matClone(MATS.roof, w / 2, 1.2), true);
  if (chimney) {
    const cx = x + w * 0.28, cz = z + d * 0.15;
    boxMesh(0.5, 1.5, 0.5, MATS.brick, cx, h + roofH * 0.4, cz, world);
  }
  // windows
  const faces = [
    { face: "z", s: 1, px: x, pz: z + d / 2 + 0.03 },
    { face: "z", s: -1, px: x, pz: z - d / 2 - 0.03 },
    { face: "x", s: 1, px: x + w / 2 + 0.03, pz: z },
    { face: "x", s: -1, px: x - w / 2 - 0.03, pz: z }
  ];
  for (const f of faces) {
    const isDoorFace = (door === "+z" && f.face === "z" && f.s === 1) ||
      (door === "-z" && f.face === "z" && f.s === -1) ||
      (door === "+x" && f.face === "x" && f.s === 1) ||
      (door === "-x" && f.face === "x" && f.s === -1);
    const span = f.face === "z" ? w : d;
    const count = span > 7 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i === 0 ? -span * 0.22 : span * 0.22);
      const wx = f.face === "z" ? f.px + t : f.px;
      const wz = f.face === "x" ? f.pz + t : f.pz;
      windowPane(wx, (stories > 1 ? h * 0.72 : h * 0.58), wz, 0.7, 0.8, f.face);
      if (stories > 1) windowPane(wx, h * 0.32, wz, 0.7, 0.7, f.face);
    }
    if (isDoorFace) {
      const dx = f.face === "z" ? x : f.px + f.s * 0.02;
      const dz = f.face === "x" ? z : f.pz + f.s * 0.02;
      doorRecess(dx, 1.05, dz, 1.05, 2.1, f.face);
    }
  }
}

function wallSeg(x, y, z, w, h, d, mat) {
  boxMesh(w, h, d, mat, x, y + h / 2, z, world);
  addCollider(x, y, z, w, h, d);
}

function enterableHouse(x, z, w, d, h, roofH) {
  const t = 0.32;
  const doorW = 1.45;
  // walls (south has door gap) — south is -z
  // North
  wallSeg(x, 0, z + d / 2 - t / 2, w, h, t, matClone(MATS.plaster, w / 2, h / 2));
  // East / West
  wallSeg(x + w / 2 - t / 2, 0, z, t, h, d, matClone(MATS.plaster, d / 2, h / 2));
  wallSeg(x - w / 2 + t / 2, 0, z, t, h, d, matClone(MATS.plaster, d / 2, h / 2));
  // South split
  const gap = doorW;
  const side = (w - gap) / 2;
  wallSeg(x - w / 2 + side / 2, 0, z - d / 2 + t / 2, side, h, t, matClone(MATS.plaster, 1, h / 2));
  wallSeg(x + w / 2 - side / 2, 0, z - d / 2 + t / 2, side, h, t, matClone(MATS.plaster, 1, h / 2));
  // lintel
  boxMesh(doorW + 0.1, 0.3, t, MATS.stone, x, 2.25, z - d / 2 + t / 2, world);
  // floor
  boxMesh(w - 0.2, 0.06, d - 0.2, matClone(MATS.wood, 3, 3), x, 0.03, z, world);
  // ceiling / roof base
  boxMesh(w, 0.1, d, MATS.darkWood, x, h, z, world);
  pitchedRoof(x, h, z, w, d, roofH, matClone(MATS.roof, w / 2, 1), true);
  // windows on E/W/N
  windowPane(x + w / 2 + 0.02, 1.6, z, 0.7, 0.8, "x");
  windowPane(x - w / 2 - 0.02, 1.6, z, 0.7, 0.8, "x");
  windowPane(x - 1.6, 1.6, z + d / 2 + 0.02, 0.7, 0.8, "z");
  windowPane(x + 1.6, 1.6, z + d / 2 + 0.02, 0.7, 0.8, "z");
}

function crate(x, z, y = 0, stacked = false) {
  const s = 0.62;
  const m = boxMesh(s, s, s, MATS.crate, x, y + s / 2, z, world);
  addCollider(x, y, z, s, s + 0.02, s);
  addCover(x, z - 0.85, 0);
  return m;
}
function crateStack(x, z) {
  crate(x, z, 0);
  crate(x + 0.08, z + 0.05, 0.62);
}
function barrel(x, z) {
  const m = mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.7, 10), MATS.metal, x, 0.35, z);
  addCollider(x, 0, z, 0.6, 0.7, 0.6);
  return m;
}
function sandbagRow(x, z, yaw, count = 4) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  for (let i = 0; i < count; i++) {
    const bag = mesh(new THREE.BoxGeometry(0.55, 0.28, 0.38), MATS.sand, (i - (count - 1) / 2) * 0.5, 0.16, 0, g);
    bag.rotation.y = (hash2(i, 200) - 0.5) * 0.15;
  }
  for (let i = 0; i < count - 1; i++) {
    mesh(new THREE.BoxGeometry(0.55, 0.26, 0.36), MATS.sand, (i - (count - 2) / 2) * 0.5, 0.40, 0.02, g);
  }
  world.add(g);
  const w = count * 0.52, d = 0.5;
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  // approx AABB
  addCollider(x, 0, z, Math.abs(ca) * w + Math.abs(sa) * d + 0.1, 0.62, Math.abs(sa) * w + Math.abs(ca) * d + 0.1);
  addCover(x - Math.sin(yaw) * 0.9, z - Math.cos(yaw) * 0.9, yaw);
}

function well(x, z) {
  mesh(new THREE.CylinderGeometry(0.7, 0.78, 0.7, 12), MATS.stone, x, 0.35, z);
  addCollider(x, 0, z, 1.5, 0.85, 1.5);
  // posts + roof
  boxMesh(0.1, 1.2, 0.1, MATS.wood, x - 0.55, 1.15, z, world);
  boxMesh(0.1, 1.2, 0.1, MATS.wood, x + 0.55, 1.15, z, world);
  boxMesh(1.4, 0.08, 0.9, MATS.darkWood, x, 1.78, z, world);
}

function cart(x, z, yaw) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  // tipped
  g.rotation.z = 0.35;
  boxMesh(1.8, 0.18, 0.9, MATS.wood, 0, 0.55, 0, g);
  boxMesh(0.1, 0.5, 0.9, MATS.wood, -0.85, 0.7, 0, g);
  mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 10), MATS.darkWood, 0.55, 0.28, 0.5, g).rotation.x = Math.PI / 2;
  mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 10), MATS.darkWood, 0.55, 0.28, -0.5, g).rotation.x = Math.PI / 2;
  world.add(g);
  addCollider(x, 0, z, 2.0, 0.9, 1.2);
}

function tree(x, z, scale = 1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.6, 6), MATS.trunk, 0, 0.8, 0, g);
  mesh(new THREE.SphereGeometry(0.9, 6, 5), MATS.leaf, 0, 2.0, 0, g).scale.set(1, 0.85, 1);
  mesh(new THREE.SphereGeometry(0.65, 6, 5), MATS.leaf, 0.4, 2.15, -0.15, g);
  world.add(g);
  addCollider(x, 0, z, 0.5, 1.4, 0.5);
}

function hedge(x, z, w, d, h = 1.1) {
  boxMesh(w, h, d, MATS.hedge, x, h / 2, z, world);
  addCollider(x, 0, z, w, h, d);
}

function stoneWall(x, z, w, d, h = 1.15, yaw = 0) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  boxMesh(w, h, d, matClone(MATS.stone, w / 1.2, h / 1.1), 0, h / 2, 0, g);
  world.add(g);
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  addCollider(x, 0, z, Math.abs(ca) * w + Math.abs(sa) * d, h, Math.abs(sa) * w + Math.abs(ca) * d);
}

function rubble(x, z) {
  const rng = mulberry32((x * 13 + z * 7) | 0);
  for (let i = 0; i < 7; i++) {
    const sx = 0.2 + rng() * 0.5, sy = 0.12 + rng() * 0.28, sz = 0.2 + rng() * 0.45;
    const m = boxMesh(sx, sy, sz, MATS.stone, x + (rng() - 0.5) * 1.4, sy / 2, z + (rng() - 0.5) * 1.2, world);
    m.rotation.y = rng() * 2;
  }
  addCollider(x, 0, z, 1.6, 0.4, 1.4);
}

function church(x, z) {
  boxMesh(5.5, 5.5, 7.5, matClone(MATS.stone, 3, 3), x, 2.75, z, world);
  pitchedRoof(x, 5.5, z, 5.8, 7.8, 2.2, matClone(MATS.roof, 2, 2), true);
  // tower
  boxMesh(2.2, 8.5, 2.2, matClone(MATS.stone, 1.2, 4), x, 4.25, z - 3.2, world);
  // spire
  const spire = mesh(new THREE.ConeGeometry(1.15, 3.2, 8), MATS.roof, x, 10.1, z - 3.2);
  addCollider(x, 0, z, 5.5, 6, 7.5);
}

function hill(x, y, z, sx, sy, sz) {
  const m = mesh(new THREE.SphereGeometry(1, 8, 6), MATS.grass, x, y, z);
  m.scale.set(sx, sy, sz);
}

function radioProp(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  boxMesh(1.2, 0.08, 0.7, MATS.wood, 0, 0.04, 0, g); // table already separate
  const body = boxMesh(0.46, 0.26, 0.28, MATS.metal, 0, 0.22, 0, g);
  mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8), MATS.dark, -0.1, 0.38, 0.05, g);
  mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8), MATS.dark, 0.08, 0.38, 0.05, g);
  const lamp = mesh(new THREE.SphereGeometry(0.035, 8, 6), MATS.radioGlow, 0.18, 0.32, 0.1, g);
  lamp.name = "radioLamp";
  const ant = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.9, 6), MATS.metal, -0.18, 0.7, -0.05, g);
  // small flag
  boxMesh(0.06, 1.05, 0.06, MATS.wood, 0.55, 0.52, 0, g);
  const flag = boxMesh(0.42, 0.28, 0.02, MATS.flag, 0.76, 0.9, 0, g);
  mesh(new THREE.CircleGeometry(0.055, 5), MATS.star, 0.76, 0.9, 0.012, g);
  world.add(g);
  return g;
}

const radioPos = new THREE.Vector3(0, 0, 27.2);

function buildSky() {
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vP;
      void main(){
        vP = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vP;
      void main(){
        float h = vP.y;
        vec3 horizon = vec3(0.64, 0.63, 0.56);
        vec3 zenith = vec3(0.42, 0.45, 0.48);
        vec3 ground = vec3(0.32, 0.30, 0.24);
        vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.9, h));
        col = mix(ground, col, smoothstep(-0.2, 0.06, h));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(140, 16, 12), skyMat);
  scene.add(sky);
}

function buildLights() {
  const hemi = new THREE.HemisphereLight(0xb8bcae, 0x4a4030, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xddd4c0, 0.9);
  sun.position.set(-18, 28, 10);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x8a9aaa, 0.18);
  fill.position.set(12, 8, -8);
  scene.add(fill);
  // warm lamp near radio
  const lamp = new THREE.PointLight(0xffcc88, 2.4, 9, 1.6);
  lamp.position.set(0, 1.8, 28.2);
  scene.add(lamp);
  const lamp2 = new THREE.PointLight(0xc8d0e0, 0.8, 8, 2);
  lamp2.position.set(0, 2.2, 26.2);
  scene.add(lamp2);
}

function buildLevel() {
  colliders.length = 0;
  coverPts.length = 0;
  // clear world children except we'll rebuild from scratch once at boot
  while (world.children.length) world.remove(world.children[0]);

  buildSky();
  buildLights();

  // Ground
  const ground = mesh(new THREE.PlaneGeometry(160, 160), matClone(MATS.dirt, 40, 40), 0, 0, 0);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  // grass patches
  for (const [x, z, w, d] of [[-18, -8, 16, 40], [18, 0, 16, 50], [-16, 20, 14, 20], [0, -28, 24, 10]]) {
    const p = mesh(new THREE.PlaneGeometry(w, d), matClone(MATS.grass, w / 3, d / 3), x, 0.01, z);
    p.rotation.x = -Math.PI / 2;
  }
  // cobble lane
  const lane = mesh(new THREE.PlaneGeometry(4.4, 52), matClone(MATS.cobble, 3, 28), 0, 0.02, 6);
  lane.rotation.x = -Math.PI / 2;
  // dirt road south
  const road = mesh(new THREE.PlaneGeometry(5.2, 22), matClone(MATS.dirt, 4, 10), 0, 0.015, -28);
  road.rotation.x = -Math.PI / 2;

  // Bounds (invisible)
  addCollider(0, 0, -48, 80, 6, 2);
  addCollider(0, 0, 62, 80, 6, 2);
  addCollider(-36, 0, 0, 2, 6, 120);
  addCollider(36, 0, 0, 2, 6, 120);

  // Village buildings
  solidBuilding({ x: -12, z: -6, w: 8.2, d: 7.2, h: 5.2, roofH: 1.7, stories: 2, door: "+x", chimney: true, stoneBase: true });
  solidBuilding({ x: 11.2, z: -2.5, w: 6.4, d: 6.0, h: 3.4, roofH: 1.35, stories: 1, door: "-x", chimney: true });
  solidBuilding({ x: -13.5, z: 12, w: 10, d: 7, h: 4.0, roofH: 1.8, stories: 1, door: "+x", stoneBase: true });
  solidBuilding({ x: 11.5, z: 13.5, w: 6.2, d: 6.2, h: 3.6, roofH: 1.4, stories: 1, door: "-x", chimney: true });
  enterableHouse(0, 28.2, 7.2, 6.2, 3.3, 1.4);

  // Radio table + set, inside house (north wall)
  boxMesh(1.3, 0.72, 0.7, MATS.wood, 0, 0.36, 29.6, world, true);
  radioProp(0, 0.72, 29.6);
  radioPos.set(0, 0, 29.6);

  // Walls / cover along the lane
  stoneWall(-5.2, -10, 8, 0.4, 1.15, 0);
  stoneWall(5.2, -8, 6, 0.4, 1.15, 0);
  stoneWall(-5.4, 2, 7, 0.4, 1.2, 0);
  stoneWall(5.6, 6, 5, 0.4, 1.15, 0);
  stoneWall(-6.2, 18, 6, 0.4, 1.2, Math.PI / 2 * 0.15);

  sandbagRow(-3.4, 6.2, 0, 5);
  sandbagRow(3.3, 16.0, 0.05, 4);
  sandbagRow(-2.6, 21.4, 0, 5);

  crateStack(-6.8, -8.2);
  crate(-6.2, -7.2);
  barrel(-5.5, -8.6);
  crate(6.2, 0.2);
  crate(6.8, 0.6);
  barrel(-7.2, 10.2);
  crateStack(-7.6, 9.4);
  crate(3.4, 23.2);
  crate(4.0, 23.8);
  barrel(3.8, 24.5);

  well(2.0, 2.2);
  cart(4.6, -12.5, -0.6);
  rubble(-4.5, -14.5);
  rubble(6.5, 8.5);
  rubble(-5.8, 24.5);

  // Hedges at spawn
  hedge(-8.5, -30, 8, 1.0, 1.2);
  hedge(8.5, -30, 8, 1.0, 1.2);
  hedge(-9.5, -22, 1.1, 10, 1.15);
  hedge(9.5, -22, 1.1, 10, 1.15);
  stoneWall(0, -38, 14, 0.45, 1.0, 0);

  // Trees (sides, not in the lane)
  const rng = mulberry32(1944);
  const treeSpots = [
    [-18, -20], [-16, -8], [-20, 4], [-18, 16], [-16, 28],
    [18, -18], [16, -6], [19, 6], [17, 18], [16, 30],
    [-14, -28], [14, -32], [-22, 22], [22, 10]
  ];
  for (const [tx, tz] of treeSpots) tree(tx, tz, 0.85 + rng() * 0.4);

  // Distant hills + church silhouette
  hill(-30, -4, 50, 28, 10, 16);
  hill(24, -5, 54, 26, 12, 18);
  hill(0, -6, 70, 40, 14, 20);
  church(6, 56);

  // A few more low fences
  for (let i = 0; i < 6; i++) {
    boxMesh(1.2, 0.9, 0.08, MATS.wood, 8.2, 0.45, -16 + i * 1.25, world);
  }
  addCollider(8.2, 0, -13, 1.2, 0.9, 8);

  // Pickup spawn markers stored; actual pickups placed on start
  levelReady = true;
}

let levelReady = false;

/* ---------------- Pickups ---------------- */
function makeHealthPack() {
  const g = new THREE.Group();
  boxMesh(0.36, 0.22, 0.28, MATS.pack, 0, 0.12, 0, g);
  boxMesh(0.22, 0.06, 0.06, MATS.cross, 0, 0.24, 0, g);
  boxMesh(0.06, 0.06, 0.22, MATS.cross, 0, 0.24, 0, g);
  return g;
}
function makeAmmoPack() {
  const g = new THREE.Group();
  boxMesh(0.4, 0.2, 0.28, MATS.crate, 0, 0.1, 0, g);
  boxMesh(0.12, 0.08, 0.08, MATS.metal, 0, 0.24, 0, g);
  return g;
}
function placePickups(diff) {
  for (const p of pickups) {
    if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
  }
  pickups.length = 0;
  const spots = diff === "easy" ? [[0, -22], [-6.0, 3.8], [5.2, 18.2]] : [[0, 8.5]];
  for (const [x, z] of spots) {
    const meshG = makeHealthPack();
    meshG.position.set(x, 0, z);
    world.add(meshG);
    pickups.push({ type: "health", x, z, mesh: meshG, taken: false, amount: diff === "easy" ? 50 : 30 });
  }
  const ammo = makeAmmoPack();
  ammo.position.set(6.4, 0, 9.6);
  world.add(ammo);
  pickups.push({ type: "ammo", x: 6.4, z: 9.6, mesh: ammo, taken: false });
}


/* ---------------- Player & weapons ---------------- */
const player = {
  pos: new THREE.Vector3(0, 0, -36),
  yaw: 0,
  pitch: 0,
  vel: new THREE.Vector3(),
  hp: 100,
  maxHp: 100,
  radius: 0.38,
  height: 1.78,
  eye: 1.65,
  onStone: false,
  invuln: 0,
  footT: 0,
  sprinting: false,
  ads: 0,
  wantAds: false,
  firing: false,
  fireHeld: false,
  fireClicked: false,
  lastShot: 0,
  reloading: 0,
  weapon: "rifle",
  mags: { rifle: 8, smg: 30 },
  reserve: { rifle: 40, smg: 90 }
};

const camRig = new THREE.Group();
scene.add(camRig);
camRig.add(camera);

const viewRoot = new THREE.Group();
camera.add(viewRoot);
let rifleVM, smgVM, muzzleFlash, vmBob = 0, kickP = 0, kickY = 0, kickRec = 0;

function armMesh(parent, handed) {
  const g = new THREE.Group();
  const u = mesh(new THREE.BoxGeometry(0.08, 0.08, 0.28), MATS.uniform, 0, 0, 0, g);
  const hand = mesh(new THREE.BoxGeometry(0.07, 0.07, 0.08), MATS.skin, 0, -0.01, -0.16, g);
  g.position.set(handed * 0.12, -0.12, -0.15);
  parent.add(g);
  return g;
}

function buildRifleVM() {
  const g = new THREE.Group();
  mesh(new THREE.BoxGeometry(0.045, 0.05, 0.58), MATS.gunwood, 0, -0.004, -0.14, g);
  mesh(new THREE.BoxGeometry(0.05, 0.08, 0.16), MATS.gunwood, 0, -0.02, 0.22, g);
  mesh(new THREE.BoxGeometry(0.038, 0.04, 0.18), MATS.gunmetal, 0, 0.028, 0.02, g);
  const barrel = mesh(new THREE.CylinderGeometry(0.009, 0.01, 0.44, 7), MATS.gunmetal, 0, 0.02, -0.52, g);
  barrel.rotation.x = Math.PI / 2;
  mesh(new THREE.BoxGeometry(0.007, 0.028, 0.01), MATS.gunmetal, 0, 0.042, -0.72, g);
  mesh(new THREE.BoxGeometry(0.024, 0.014, 0.012), MATS.gunmetal, 0, 0.042, -0.06, g);
  mesh(new THREE.BoxGeometry(0.006, 0.02, 0.01), MATS.gunmetal, -0.01, 0.054, -0.06, g);
  mesh(new THREE.BoxGeometry(0.006, 0.02, 0.01), MATS.gunmetal, 0.01, 0.054, -0.06, g);
  mesh(new THREE.BoxGeometry(0.018, 0.032, 0.04), MATS.gunmetal, 0, -0.032, 0.05, g);
  mesh(new THREE.BoxGeometry(0.055, 0.05, 0.07), MATS.skin, 0.035, -0.045, 0.04, g);
  mesh(new THREE.BoxGeometry(0.06, 0.2, 0.06), MATS.uniform, 0.07, -0.13, 0.12, g);
  mesh(new THREE.BoxGeometry(0.055, 0.05, 0.07), MATS.skin, -0.02, -0.038, -0.30, g);
  mesh(new THREE.BoxGeometry(0.06, 0.18, 0.06), MATS.uniform, -0.035, -0.12, -0.18, g);
  g.visible = true;
  return g;
}
function buildSmgVM() {
  const g = new THREE.Group();
  mesh(new THREE.BoxGeometry(0.042, 0.055, 0.22), MATS.gunmetal, 0, 0.01, -0.04, g);
  mesh(new THREE.BoxGeometry(0.04, 0.05, 0.14), MATS.gunwood, 0, -0.005, 0.14, g);
  const barrel = mesh(new THREE.CylinderGeometry(0.011, 0.012, 0.26, 7), MATS.gunmetal, 0, 0.02, -0.26, g);
  barrel.rotation.x = Math.PI / 2;
  mesh(new THREE.BoxGeometry(0.028, 0.028, 0.16), MATS.gunmetal, 0, 0.036, -0.2, g);
  mesh(new THREE.BoxGeometry(0.03, 0.2, 0.06), MATS.gunmetal, 0, -0.11, -0.02, g);
  mesh(new THREE.BoxGeometry(0.008, 0.024, 0.01), MATS.gunmetal, 0, 0.045, -0.38, g);
  mesh(new THREE.BoxGeometry(0.055, 0.05, 0.07), MATS.skin, 0.035, -0.04, 0.02, g);
  mesh(new THREE.BoxGeometry(0.06, 0.18, 0.06), MATS.uniform, 0.07, -0.12, 0.1, g);
  mesh(new THREE.BoxGeometry(0.055, 0.05, 0.07), MATS.skin, -0.015, -0.035, -0.16, g);
  mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), MATS.uniform, -0.03, -0.11, -0.08, g);
  g.visible = false;
  return g;
}

function buildViewmodel() {
  rifleVM = buildRifleVM();
  smgVM = buildSmgVM();
  viewRoot.add(rifleVM);
  viewRoot.add(smgVM);
  muzzleFlash = mesh(new THREE.PlaneGeometry(0.1, 0.1), MATS.flash, 0, 0.025, -0.76, viewRoot);
  const flash2 = mesh(new THREE.PlaneGeometry(0.1, 0.1), MATS.flash, 0, 0.025, -0.76, viewRoot);
  flash2.rotation.y = Math.PI / 2;
  muzzleFlash.userData.pair = flash2;
  muzzleFlash.visible = flash2.visible = false;
  viewRoot.position.set(0.22, -0.26, -0.50);
}

function currentWpn() { return WPN[player.weapon]; }
function showWeapon() {
  if (rifleVM) rifleVM.visible = player.weapon === "rifle";
  if (smgVM) smgVM.visible = player.weapon === "smg";
  updateAmmoHUD();
}

function resetLoadout(diff) {
  const mul = DIFF[diff].ammoMul;
  player.weapon = "rifle";
  player.mags.rifle = WPN.rifle.mag;
  player.mags.smg = WPN.smg.mag;
  player.reserve.rifle = Math.round(WPN.rifle.reserve * mul);
  player.reserve.smg = Math.round(WPN.smg.reserve * mul);
  player.reloading = 0;
  player.ads = 0;
  player.wantAds = false;
  showWeapon();
}

function canFire() {
  return game.mode === "play" && player.reloading <= 0 && player.mags[player.weapon] > 0 && player.hp > 0;
}

function tryReload(auto = false) {
  if (game.mode !== "play" && game.mode !== "count") return;
  if (player.reloading > 0) return;
  const w = currentWpn();
  const need = w.mag - player.mags[w.id];
  if (need <= 0) return;
  if (player.reserve[w.id] <= 0) {
    if (!auto) showHint("No reserve ammo");
    return;
  }
  player.reloading = w.reload;
  player.wantAds = false;
  SFX.reload();
}

function finishReload() {
  const w = currentWpn();
  const need = w.mag - player.mags[w.id];
  const take = Math.min(need, player.reserve[w.id]);
  player.mags[w.id] += take;
  player.reserve[w.id] -= take;
  player.reloading = 0;
  updateAmmoHUD();
}

function switchWeapon(id) {
  if (player.weapon === id) return;
  if (player.reloading > 0) return;
  player.weapon = id;
  showWeapon();
  SFX.ui();
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _look = new THREE.Vector3();

function fireWeapon() {
  if (!canFire()) {
    if (player.reloading <= 0 && player.mags[player.weapon] <= 0) tryReload(true);
    return false;
  }
  const w = currentWpn();
  const now = game.clock;
  const interval = w.semi ? 60 / Math.max(180, w.rpm) : 60 / w.rpm;
  if (!player.forceFire && now - player.lastShot < interval) return false;
  player.forceFire = false;
  player.lastShot = now;
  player.mags[w.id]--;
  game.shots++;
  SFX.shoot(w.id, 0);
  if (w.ping && player.mags[w.id] === 0) SFX.ping();

  const ads = player.ads;
  const spread = lerp(w.spreadHip, w.spreadAds, ads) * (player.sprinting ? 1.6 : 1);
  camera.getWorldDirection(_look);
  _look.x += rand(-1, 1) * spread;
  _look.y += rand(-1, 1) * spread * 0.7;
  _look.z += rand(-1, 1) * spread;
  _look.normalize();
  const origin = camera.getWorldPosition(tmpV);

  const result = hitscan(origin.x, origin.y, origin.z, _look.x, _look.y, _look.z, w.range, true);
  game.lastShot = result ? { t: result.t, enemy: !!result.enemy, wall: !!result.wall, missed: !!result.missed, x: result.point.x, y: result.point.y, z: result.point.z } : null;
  if (result && result.enemy) {
    hurtEnemy(result.enemy, w.dmg, result.point);
    game.hits++;
    flashCrosshairHit();
  } else if (result) {
    spawnDust(result.point, 4);
  }
  spawnTracer(origin, result ? result.point : origin.clone().addScaledVector(_look, w.range * 0.6), 0.05);

  const kick = lerp(w.kick, w.adsKick, ads);
  kickP += kick;
  kickY += rand(-0.4, 0.4) * kick;
  kickRec = 1;
  showMuzzle(w.id);
  updateAmmoHUD();
  if (player.mags[w.id] <= 0) tryReload(true);
  return true;
}

function showMuzzle(kind) {
  const z = kind === "rifle" ? -0.76 : -0.42;
  muzzleFlash.position.z = z;
  muzzleFlash.userData.pair.position.z = z;
  muzzleFlash.visible = muzzleFlash.userData.pair.visible = true;
  muzzleFlash.userData.t = 0.045;
}

function hitscan(ox, oy, oz, dx, dy, dz, range, fromPlayer) {
  const worldHit = rayWorld(ox, oy, oz, dx, dy, dz, range, fromPlayer ? -1 : -1);
  let bestT = worldHit ? worldHit.t : range;
  let enemyHit = null;
  if (fromPlayer) {
    for (const e of enemies) {
      if (e.hp <= 0) continue;
      const c = enemyAABB(e);
      const t = rayAABB(ox, oy, oz, dx, dy, dz, c, bestT);
      if (t != null && t < bestT) { bestT = t; enemyHit = e; }
    }
  } else {
    // against player
    const c = {
      minx: player.pos.x - player.radius, maxx: player.pos.x + player.radius,
      miny: player.pos.y, maxy: player.pos.y + player.height,
      minz: player.pos.z - player.radius, maxz: player.pos.z + player.radius
    };
    const t = rayAABB(ox, oy, oz, dx, dy, dz, c, bestT);
    if (t != null && t < bestT) { bestT = t; enemyHit = "player"; }
  }
  const point = new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
  if (enemyHit === "player") return { t: bestT, point, player: true, wall: worldHit && worldHit.t <= bestT + 0.001 };
  if (enemyHit) return { t: bestT, point, enemy: enemyHit };
  if (worldHit) return { t: bestT, point, wall: worldHit };
  return { t: range, point, missed: true };
}

function spawnTracer(from, to, life) {
  const dir = tmpV2.subVectors(to, from);
  const len = dir.length();
  if (len < 0.2) return;
  const m = mesh(new THREE.BoxGeometry(0.02, 0.02, 1), MATS.tracer.clone(), 0, 0, 0, scene);
  m.position.copy(from).add(dir.clone().multiplyScalar(0.5));
  m.scale.z = len;
  m.lookAt(to);
  tracers.push({ mesh: m, life, max: life });
}
function spawnDust(p, n) {
  for (let i = 0; i < n; i++) {
    const m = mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), MATS.dust.clone(), p.x, p.y, p.z, scene);
    particles.push({
      mesh: m,
      vel: new THREE.Vector3(rand(-1, 1), rand(0.4, 1.8), rand(-1, 1)),
      life: rand(0.2, 0.45)
    });
  }
}

function updateViewmodel(dt, moving) {
  vmBob += dt * (player.sprinting ? 12 : 8) * (moving ? 1 : 0);
  const bobAmt = moving ? (player.sprinting ? 0.022 : 0.014) : 0.004;
  const bobX = Math.sin(vmBob) * bobAmt;
  const bobY = Math.abs(Math.cos(vmBob)) * bobAmt * 0.7;
  const ads = player.ads;
  const hip = { x: 0.22, y: -0.26, z: -0.50 };
  const iron = player.weapon === "rifle" ? { x: 0.0, y: -0.155, z: -0.34 } : { x: 0.0, y: -0.16, z: -0.36 };
  const rx = player.reloading > 0 ? -0.35 * Math.sin((1 - player.reloading / currentWpn().reload) * Math.PI) : 0;
  viewRoot.position.set(
    lerp(hip.x, iron.x, ads) + bobX,
    lerp(hip.y, iron.y, ads) + bobY + rx * 0.15,
    lerp(hip.z, iron.z, ads) + kickRec * -0.05
  );
  const hipYaw = lerp(-0.12, 0, ads);
  viewRoot.rotation.set(kickP + rx + 0.04, kickY + hipYaw, 0.02 * (1 - ads));
  kickP = lerp(kickP, 0, 1 - Math.pow(0.001, dt));
  kickY = lerp(kickY, 0, 1 - Math.pow(0.001, dt));
  kickRec = lerp(kickRec, 0, 1 - Math.pow(0.0008, dt));
  if (muzzleFlash.userData.t > 0) {
    muzzleFlash.userData.t -= dt;
    if (muzzleFlash.userData.t <= 0) muzzleFlash.visible = muzzleFlash.userData.pair.visible = false;
  }
}

function applyLook(dx, dy, sens) {
  player.yaw -= dx * sens;
  player.pitch -= dy * sens;
  const lim = Math.PI / 2 * 0.92;
  player.pitch = clamp(player.pitch, -lim, lim);
}

function setCameraFromPlayer() {
  camRig.position.set(player.pos.x, player.pos.y + player.eye, player.pos.z);
  camRig.rotation.y = player.yaw;
  camera.rotation.x = player.pitch;
}

function movePlayer(dt, ix, iz, sprint) {
  const speed = (sprint ? 6.6 : 4.15) * (player.wantAds || player.ads > 0.6 ? 0.55 : 1);
  player.sprinting = sprint && (ix || iz) && player.ads < 0.5;
  const ca = Math.cos(player.yaw), sa = Math.sin(player.yaw);
  // yaw 0 looks +z? With camRig.rotation.y = yaw, default camera looks down -Z in Three.js!
  // IMPORTANT: Three.js camera looks down -Z. So yaw=0 looks toward -Z (south).
  // I want spawn looking north (+Z). So initial yaw should be Math.PI.
  // Movement: forward should be camera forward (look direction).
  const fwdX = -Math.sin(player.yaw);
  const fwdZ = -Math.cos(player.yaw);
  const rgtX = Math.cos(player.yaw);
  const rgtZ = -Math.sin(player.yaw);
  let dx = (fwdX * iz + rgtX * ix) * speed * dt;
  let dz = (fwdZ * iz + rgtZ * ix) * speed * dt;

  const r = player.radius, h = player.height, y = player.pos.y;
  if (!hitsAABB(player.pos.x + dx, y, player.pos.z, r, h)) player.pos.x += dx;
  else if (!hitsAABB(player.pos.x + dx * 0.4, y, player.pos.z, r, h)) player.pos.x += dx * 0.4;
  if (!hitsAABB(player.pos.x, y, player.pos.z + dz, r, h)) player.pos.z += dz;
  else if (!hitsAABB(player.pos.x, y, player.pos.z + dz * 0.4, r, h)) player.pos.z += dz * 0.4;

  // stay on ground
  player.pos.y = 0;
  if (player.pos.y < -1) player.pos.set(0, 0, -36);

  // stone check (cobble lane roughly)
  player.onStone = Math.abs(player.pos.x) < 2.4 && player.pos.z > -16 && player.pos.z < 34;

  if (ix || iz) {
    player.footT += dt;
    const step = player.sprinting ? 0.32 : 0.44;
    if (player.footT > step) {
      player.footT = 0;
      SFX.foot(player.onStone);
    }
  } else player.footT = 0.2;
}

function hurtPlayer(dmg) {
  if (player.invuln > 0 || game.mode !== "play" || player.hp <= 0) return;
  const applied = dmg * DIFF[game.diff].dmgIn;
  player.hp = Math.max(0, player.hp - applied);
  player.invuln = 0.28;
  SFX.playerHit();
  $("hurt").classList.add("on");
  setTimeout(() => $("hurt").classList.remove("on"), 140);
  updateHealthHUD();
  // camera kick
  kickP -= 0.04;
  kickY += rand(-0.03, 0.03);
  if (player.hp <= 0) onLose();
}

/* ---------------- Enemies ---------------- */
const enemies = [];

function makeSoldier() {
  const g = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  g.add(hips);
  const torso = mesh(new THREE.BoxGeometry(0.38, 0.5, 0.24), MATS.uniform, 0, 0.26, 0, hips);
  const belt = mesh(new THREE.BoxGeometry(0.4, 0.06, 0.26), MATS.gunwood, 0, 0.02, 0, hips);
  const head = mesh(new THREE.BoxGeometry(0.16, 0.18, 0.16), MATS.skin, 0, 0.62, 0, hips);
  const helm = mesh(new THREE.SphereGeometry(0.13, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), MATS.helmet, 0, 0.66, 0, hips);
  helm.scale.set(1.15, 0.7, 1.2);
  mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.03, 10), MATS.helmet, 0, 0.66, 0, hips);

  function limb(w, h, d, mat, px, py, pz, parent) {
    const L = new THREE.Group();
    L.position.set(px, py, pz);
    mesh(new THREE.BoxGeometry(w, h, d), mat, 0, -h / 2, 0, L);
    parent.add(L);
    return L;
  }
  const armL = limb(0.1, 0.46, 0.1, MATS.uniform, -0.24, 0.44, 0, hips);
  const armR = limb(0.1, 0.46, 0.1, MATS.uniform, 0.24, 0.44, 0, hips);
  const legL = limb(0.12, 0.9, 0.14, MATS.uniform, -0.1, 0, 0, g);
  legL.position.y = 0.92;
  const legR = limb(0.12, 0.9, 0.14, MATS.uniform, 0.1, 0, 0, g);
  legR.position.y = 0.92;
  mesh(new THREE.BoxGeometry(0.13, 0.16, 0.2), MATS.boot, 0, -0.9, 0.02, legL);
  mesh(new THREE.BoxGeometry(0.13, 0.16, 0.2), MATS.boot, 0, -0.9, 0.02, legR);

  const gun = new THREE.Group();
  gun.position.set(0.12, -0.05, -0.28);
  armR.add(gun);
  mesh(new THREE.BoxGeometry(0.04, 0.05, 0.55), MATS.gunmetal, 0, 0, 0, gun);
  mesh(new THREE.BoxGeometry(0.04, 0.05, 0.16), MATS.gunwood, 0, -0.01, 0.22, gun);
  const flash = mesh(new THREE.PlaneGeometry(0.12, 0.12), MATS.flash, 0, 0, -0.32, gun);
  flash.visible = false;

  g.userData.parts = { hips, torso, head, armL, armR, legL, legR, gun, flash };
  return g;
}

function enemyAABB(e) {
  return {
    minx: e.pos.x - 0.32, maxx: e.pos.x + 0.32,
    miny: e.pos.y, maxy: e.pos.y + (e.hp > 0 ? 1.75 : 0.4),
    minz: e.pos.z - 0.32, maxz: e.pos.z + 0.32
  };
}

function spawnEnemies() {
  for (const e of enemies) {
    if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
  }
  enemies.length = 0;
  const spots = [
    { x: -8.0, z: -9.0, patrol: [-8, -9, -7.5, -3.2], cover: true },
    { x: -10.2, z: -2.4, patrol: null, cover: true },
    { x: -3.4, z: 5.1, patrol: null, cover: true },
    { x: 7.6, z: -0.8, patrol: [7.6, -0.8, 7.2, 2.5], cover: true },
    { x: -8.2, z: 12.2, patrol: [-8.2, 12.2, -8.0, 8.5], cover: true },
    { x: 3.3, z: 15.0, patrol: null, cover: true },
    { x: -2.6, z: 20.5, patrol: null, cover: true },
    { x: 0.8, z: 24.6, patrol: [0.8, 24.6, -2.0, 24.2], cover: true }
  ];
  for (const s of spots) {
    const meshG = makeSoldier();
    meshG.position.set(s.x, 0, s.z);
    world.add(meshG);
    enemies.push({
      mesh: meshG,
      pos: new THREE.Vector3(s.x, 0, s.z),
      yaw: Math.PI, // face south (toward player). mesh forward is +Z? group default +Z. We'll set rotation.y = yaw where we want them to face.
      hp: 100,
      state: "patrol",
      patrol: s.patrol,
      patrolI: 0,
      react: 0,
      shootT: rand(0.2, 0.8),
      alert: 0,
      walkT: rand(0, 10),
      deadT: 0,
      flashT: 0,
      coverGoal: null,
      pathWait: 0
    });
  }
}

function nearestCover(e) {
  let best = null, bestD = 8;
  for (const c of coverPts) {
    const d = Math.hypot(c.x - e.pos.x, c.z - e.pos.z);
    // prefer cover closer to enemy than to running into the player
    const toP = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
    if (d < bestD && toP > 3.5) { bestD = d; best = c; }
  }
  return best;
}

function canSeePlayer(e) {
  const eye = { x: e.pos.x, y: e.pos.y + 1.5, z: e.pos.z };
  const tgt = { x: player.pos.x, y: player.pos.y + 1.3, z: player.pos.z };
  const dx = tgt.x - eye.x, dy = tgt.y - eye.y, dz = tgt.z - eye.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > 38) return null;
  // FOV: idle 110°, alerted 200°
  const fov = e.alert > 0 ? 2.2 : 1.1;
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw); // facing
  const ndx = dx / dist, ndz = dz / dist;
  const dot = fx * ndx + fz * ndz;
  if (e.alert <= 0 && dot < Math.cos(fov / 2)) {
    // also hear nearby shots / close range
    if (dist > 9) return null;
  }
  const hit = rayWorld(eye.x, eye.y, eye.z, dx / dist, dy / dist, dz / dist, dist - 0.4);
  if (hit) return null;
  return dist;
}

function hurtEnemy(e, dmg, point) {
  if (e.hp <= 0) return;
  e.hp -= dmg;
  e.alert = 8;
  e.state = e.hp <= 0 ? "dead" : "attack";
  spawnDust(point || e.pos.clone().setY(1.2), 5);
  SFX.hit();
  if (e.hp <= 0) {
    e.hp = 0;
    e.deadT = 0;
    e.state = "dead";
    SFX.thud();
  }
}

function enemyMoveToward(e, tx, tz, speed, dt) {
  const dx = tx - e.pos.x, dz = tz - e.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.15) return dist;
  const vx = (dx / dist) * speed * dt, vz = (dz / dist) * speed * dt;
  const r = 0.3, h = 1.7;
  if (!hitsAABB(e.pos.x + vx, 0, e.pos.z, r, h)) e.pos.x += vx;
  if (!hitsAABB(e.pos.x, 0, e.pos.z + vz, r, h)) e.pos.z += vz;
  e.yaw = Math.atan2(dx, dz);
  e.walkT += dt * (speed / 1.6);
  return dist;
}

function updateEnemies(dt) {
  const cfg = DIFF[game.diff];
  const combatOn = game.mode === "play" && game.clock > game.graceUntil;
  for (const e of enemies) {
    const p = e.mesh.userData.parts;
    if (e.state === "dead" || e.hp <= 0) {
      e.deadT += dt;
      const k = Math.min(1, e.deadT / 0.4);
      e.mesh.rotation.x = k * Math.PI / 2;
      e.mesh.position.set(e.pos.x, Math.sin(k * Math.PI) * 0.2, e.pos.z);
      e.mesh.rotation.y = e.yaw;
      continue;
    }
    e.mesh.rotation.x = 0;
    if (e.flashT > 0) {
      e.flashT -= dt;
      if (e.flashT <= 0 && p.flash) p.flash.visible = false;
    }

    let seen = null;
    if (combatOn && player.hp > 0) seen = canSeePlayer(e);
    if (seen != null) {
      e.alert = 6;
      e.react += dt;
    } else {
      e.react = Math.max(0, e.react - dt * 0.3);
      e.alert = Math.max(0, e.alert - dt);
    }

    if (combatOn && e.alert > 0 && e.react >= cfg.enemyReact) {
      e.state = "attack";
      // go to cover if far and exposed
      if (!e.coverGoal && seen != null && seen > 9) e.coverGoal = nearestCover(e);
      if (e.coverGoal) {
        const cd = enemyMoveToward(e, e.coverGoal.x, e.coverGoal.z, cfg.enemyMove * 1.15, dt);
        if (cd < 0.4) e.coverGoal = null;
      } else if (seen != null && seen > 14) {
        enemyMoveToward(e, player.pos.x, player.pos.z, cfg.enemyMove * 0.6, dt);
      } else {
        // face player and maybe strafe
        e.yaw = Math.atan2(player.pos.x - e.pos.x, player.pos.z - e.pos.z);
        e.walkT += dt * 0.5;
      }
      // shoot
      e.shootT -= dt;
      if (e.shootT <= 0 && seen != null) {
        e.shootT = cfg.enemyRof + rand(0, 0.25);
        enemyShoot(e, cfg);
      }
    } else {
      e.state = "patrol";
      e.coverGoal = null;
      if (e.patrol) {
        const i = e.patrolI;
        const tx = e.patrol[i * 2], tz = e.patrol[i * 2 + 1];
        const d = enemyMoveToward(e, tx, tz, 0.85, dt);
        if (d < 0.25) e.patrolI = (e.patrolI + 1) % 2;
      } else {
        e.walkT += dt * 0.2;
        // idle look
        e.yaw += Math.sin(game.clock * 0.3 + e.walkT) * dt * 0.2;
      }
    }

    // animate
    const walk = (e.state === "patrol" || e.coverGoal) ? 1 : 0.15;
    const sw = Math.sin(e.walkT * 6) * 0.55 * walk;
    p.legL.rotation.x = sw;
    p.legR.rotation.x = -sw;
    p.armL.rotation.x = -sw * 0.5;
    if (e.state === "attack") {
      p.armR.rotation.x = -1.15;
      p.armR.rotation.y = 0.15;
    } else {
      p.armR.rotation.x = sw * 0.4;
      p.armR.rotation.y = 0;
    }
    e.mesh.position.set(e.pos.x, 0, e.pos.z);
    e.mesh.rotation.y = e.yaw;
  }
}

function enemyShoot(e, cfg) {
  const origin = new THREE.Vector3(e.pos.x, e.pos.y + 1.38, e.pos.z);
  const tgt = new THREE.Vector3(player.pos.x, player.pos.y + 1.25, player.pos.z);
  const dir = tgt.clone().sub(origin);
  const dist = dir.length();
  dir.normalize();
  const spr = cfg.enemySpread * (1 + dist * 0.015);
  dir.x += rand(-1, 1) * spr;
  dir.y += rand(-1, 1) * spr * 0.6;
  dir.z += rand(-1, 1) * spr;
  dir.normalize();
  const res = hitscan(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 50, false);
  spawnTracer(origin, res ? res.point : origin.clone().addScaledVector(dir, 20), 0.06);
  SFX.shoot("rifle", dist);
  const p = e.mesh.userData.parts;
  if (p.flash) { p.flash.visible = true; e.flashT = 0.05; }
  if (res && res.player) hurtPlayer(cfg.enemyDmg);
  else if (res && res.point) spawnDust(res.point, 2);
}

function enemiesAlive() {
  let n = 0;
  for (const e of enemies) if (e.hp > 0) n++;
  return n;
}


/* ---------------- Game state & UI ---------------- */
const game = {
  mode: "menu",
  diff: "easy",
  clock: 0,
  playTime: 0,
  shots: 0,
  hits: 0,
  graceUntil: 0,
  ready: false,
  countT: 0,
  hintT: 0,
  radioBlink: 0
};

const keys = Object.create(null);
const input = {
  lookX: 0, lookY: 0,
  stickX: 0, stickZ: 0,
  fire: false,
  firePress: false,
  aim: false,
  sprint: false
};

function showScreen(which) {
  for (const id of ["menu", "help", "pause", "end"]) {
    $(id).style.display = which === id ? "flex" : "none";
  }
  const mission = which === "play" || which === "count" || which === "pause";
  $("hud").classList.toggle("on", mission);
  $("countdown").style.display = which === "count" ? "flex" : "none";
  document.body.classList.toggle("in-mission", which === "play" || which === "count");
}

function showHint(msg, t = 1.6) {
  const el = $("hint");
  el.textContent = msg;
  el.classList.add("on");
  game.hintT = t;
}

function updateHealthHUD() {
  const f = $("healthFill");
  const r = player.hp / player.maxHp;
  f.style.transform = `scaleX(${clamp(r, 0, 1)})`;
  f.classList.toggle("mid", r < 0.5 && r >= 0.28);
  f.classList.toggle("low", r < 0.28);
}
function updateAmmoHUD() {
  const w = currentWpn();
  $("wname").textContent = w.name;
  $("amag").textContent = String(player.mags[w.id]);
  $("ares").textContent = "/ " + player.reserve[w.id];
}
function updateObjectiveHUD() {
  const n = enemiesAlive();
  const dx = radioPos.x - player.pos.x, dz = radioPos.z - player.pos.z;
  const dist = Math.hypot(dx, dz);
  const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw);
  const rgtX = Math.cos(player.yaw), rgtZ = -Math.sin(player.yaw);
  const fx = (dx * rgtX + dz * rgtZ);
  const fz = (dx * fwdX + dz * fwdZ);
  const ang = Math.atan2(fx, fz);
  const arrow = "▲";
  $("compass").textContent = `RADIO  ${arrow}  ${Math.round(dist)} m`;
  $("compass").style.transform = `translateX(-50%)`;
  // rotate a prefix? keep simple text + relative hint
  const dir =
    Math.cos(ang) > 0.5 ? "ahead" :
    Math.cos(ang) < -0.5 ? "behind" :
    Math.sin(ang) > 0 ? "right" : "left";
  $("compass").textContent = `RADIO  ${Math.round(dist)} m  ${dir}`;
  if (n > 0) $("obj").textContent = `Clear the village  ·  ${n} left`;
  else $("obj").textContent = "Village is clear  ·  reach the radio";
}

function flashCrosshairHit() {
  const c = $("crosshair");
  c.classList.add("hit");
  setTimeout(() => c.classList.remove("hit"), 90);
}

function setDiff(d) {
  game.diff = d;
  $("chip-easy").classList.toggle("on", d === "easy");
  $("chip-normal").classList.toggle("on", d === "normal");
}

function loadBests() {
  const e = localStorage.getItem("allied-front-best-easy");
  const n = localStorage.getItem("allied-front-best-normal");
  const bits = [];
  if (e) bits.push("Easy best: " + formatTime(+e));
  if (n) bits.push("Normal best: " + formatTime(+n));
  $("bestLine").textContent = bits.join("   ·   ");
}
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return m + ":" + s;
}

function resetMission() {
  const d = DIFF[game.diff];
  player.pos.set(0, 0, -36);
  player.yaw = Math.PI; // look north (+Z)
  player.pitch = 0;
  player.hp = d.hp;
  player.maxHp = d.hp;
  player.invuln = 0;
  player.fireHeld = false;
  player.firing = false;
  player.fireClicked = false;
  kickP = kickY = kickRec = 0;
  resetLoadout(game.diff);
  spawnEnemies();
  placePickups(game.diff);
  game.clock = 0;
  game.playTime = 0;
  game.shots = 0;
  game.hits = 0;
  updateHealthHUD();
  updateAmmoHUD();
  setCameraFromPlayer();
}

function startGame(diff) {
  if (diff) setDiff(diff);
  SFX.resume();
  SFX.ui();
  resetMission();
  game.mode = "count";
  game.countT = 3.2;
  game.graceUntil = 0;
  showScreen("count");
  $("hud").classList.add("on");
  $("countdown").textContent = "3";
  tryPointerLock();
}

function beginPlay() {
  game.mode = "play";
  game.graceUntil = game.clock + DIFF[game.diff].grace;
  $("countdown").style.display = "none";
  showHint("Clear the village and reach the radio", 2.4);
}

function pauseGame() {
  if (game.mode !== "play" && game.mode !== "count") return;
  game.mode = "pause";
  player.fireHeld = false;
  showScreen("pause");
  $("hud").classList.add("on");
  document.exitPointerLock && document.exitPointerLock();
}
function resumeGame() {
  if (game.mode !== "pause") return;
  game.mode = "play";
  showScreen("play");
  $("hud").classList.add("on");
  $("pause").style.display = "none";
  tryPointerLock();
}
function toMenu() {
  game.mode = "menu";
  player.fireHeld = false;
  document.exitPointerLock && document.exitPointerLock();
  showScreen("menu");
  loadBests();
}
function restartGame() {
  startGame();
}

function onWin() {
  if (game.mode !== "play") return;
  game.mode = "win";
  SFX.win();
  document.exitPointerLock && document.exitPointerLock();
  const acc = game.shots ? Math.round(100 * game.hits / game.shots) : 0;
  const t = game.playTime;
  const key = "allied-front-best-" + game.diff;
  const prev = localStorage.getItem(key);
  let bestNote = "";
  if (!prev || t < +prev) {
    localStorage.setItem(key, String(t));
    bestNote = "  ·  New best time!";
  }
  $("endTitle").textContent = "Village secure!";
  $("endStats").innerHTML =
    `Time  ${formatTime(t)}<br>Accuracy  ${acc}%  (${game.hits}/${game.shots})<br>Difficulty  ${game.diff}${bestNote}`;
  showScreen("end");
  loadBests();
}
function onLose() {
  if (game.mode !== "play") return;
  game.mode = "lose";
  SFX.lose();
  document.exitPointerLock && document.exitPointerLock();
  $("endTitle").textContent = "You were hit too many times";
  $("endStats").innerHTML = `The village is still waiting.<br>Time  ${formatTime(game.playTime)}`;
  showScreen("end");
}

function tryPointerLock() {
  if (isTouchMode()) return;
  const el = canvas;
  if (document.pointerLockElement === el) return;
  const req = el.requestPointerLock || el.mozRequestPointerLock;
  if (req) {
    try {
      const p = req.call(el);
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
}

function isTouchMode() {
  return document.body.classList.contains("show-touch");
}

/* ---------------- Input ---------------- */
window.addEventListener("keydown", (e) => {
  if (e.code === "Escape") {
    if (game.mode === "play" || game.mode === "count") pauseGame();
    else if (game.mode === "pause") resumeGame();
    return;
  }
  keys[e.code] = true;
  if (e.repeat) return;
  if (e.code === "KeyR") tryReload(false);
  if (e.code === "Digit1" || e.code === "Numpad1") switchWeapon("rifle");
  if (e.code === "Digit2" || e.code === "Numpad2") switchWeapon("smg");
  if (e.code === "KeyM") SFX.toggle();
  if (["KeyW","KeyA","KeyS","KeyD","Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => { keys[e.code] = false; });

canvas.addEventListener("click", () => {
  if (game.mode === "play" || game.mode === "count") tryPointerLock();
});
document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement && game.mode === "play" && !isTouchMode()) {
    // don't auto-pause on every lock failure; only if we had lock
  }
});
document.addEventListener("mousemove", (e) => {
  if (game.mode !== "play" && game.mode !== "count") return;
  if (document.pointerLockElement === canvas) {
    const sens = (player.ads > 0.5 ? 0.00115 : 0.0022);
    applyLook(e.movementX, e.movementY, sens);
  }
});
document.addEventListener("mousedown", (e) => {
  if (game.mode !== "play" && game.mode !== "count") return;
  if (e.button === 0) {
    player.fireHeld = true;
    player.fireClicked = true;
  }
  if (e.button === 2) { player.wantAds = true; e.preventDefault(); }
});
document.addEventListener("mouseup", (e) => {
  if (e.button === 0) player.fireHeld = false;
  if (e.button === 2) player.wantAds = false;
});
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("wheel", (e) => {
  if (game.mode !== "play" && game.mode !== "count") return;
  if (e.deltaY > 0) switchWeapon(player.weapon === "rifle" ? "smg" : "rifle");
  else switchWeapon(player.weapon === "smg" ? "rifle" : "smg");
}, { passive: true });

// Touch
const pointers = new Map();
let orientDismissed = false;

function enableTouchUI() {
  document.body.classList.add("show-touch");
  updateOrient();
}
function updateOrient() {
  const touch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  const portrait = window.innerHeight > window.innerWidth * 1.05;
  document.body.classList.toggle("portrait-touch", touch && portrait && !orientDismissed && document.body.classList.contains("show-touch"));
}
window.addEventListener("resize", updateOrient);
window.addEventListener("orientationchange", updateOrient);
$("btn-orient-dismiss").addEventListener("click", () => { orientDismissed = true; updateOrient(); });

if ((navigator.maxTouchPoints || 0) > 0 || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches)) {
  enableTouchUI();
}
window.addEventListener("touchstart", () => enableTouchUI(), { once: true, passive: true });

function roleForTouch(x, y, target) {
  if (target && target.closest) {
    if (target.closest("#btn-fire-r")) return "fireR";
    if (target.closest("#btn-fire-l")) return "fireL";
    if (target.closest("#btn-aim")) return "aim";
    if (target.closest("#btn-reload")) return "reload";
    if (target.closest("#btn-pause") || target.closest("#btn-mute-hud") || target.closest("#hudBtns") || target.closest("#orient")) return "ui";
  }
  const w = window.innerWidth;
  if (x < w * 0.42) return "stick";
  return "look";
}

const stickEl = $("stick"), knobEl = $("knob");
function setKnob(nx, ny) {
  const r = 36;
  knobEl.style.transform = `translate(${nx * r}px, ${ny * r}px)`;
}

function onPtrDown(e) {
  if (game.mode === "menu" || game.mode === "help" || game.mode === "end" || game.mode === "win" || game.mode === "lose") return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (e.pointerType === "touch" || e.pointerType === "pen") enableTouchUI();
  const role = roleForTouch(e.clientX, e.clientY, e.target);
  if (role === "ui") return;
  pointers.set(e.pointerId, { role, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY });
  if (role === "fireR" || role === "fireL") {
    player.fireHeld = true;
    player.fireClicked = true;
    $(role === "fireR" ? "btn-fire-r" : "btn-fire-l").classList.add("held");
  }
  if (role === "aim") { player.wantAds = true; $("btn-aim").classList.add("held"); }
  if (role === "reload") tryReload(false);
  if (e.target.setPointerCapture) {
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
  }
  e.preventDefault();
}
function onPtrMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.lx, dy = e.clientY - p.ly;
  p.lx = e.clientX; p.ly = e.clientY;
  if (p.role === "look") {
    const sens = (player.ads > 0.5 ? 0.0018 : 0.0032);
    if (game.mode === "play" || game.mode === "count") applyLook(dx, dy, sens);
  }
  if (p.role === "stick") {
    const rect = stickEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    let sx = (e.clientX - cx) / (rect.width * 0.5);
    let sy = (e.clientY - cy) / (rect.height * 0.5);
    const mag = Math.hypot(sx, sy);
    if (mag > 1) { sx /= mag; sy /= mag; }
    input.stickX = sx;
    input.stickZ = -sy; // up is forward
    input.sprint = mag > 0.85;
    setKnob(sx, sy);
  }
  e.preventDefault();
}
function onPtrUp(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  pointers.delete(e.pointerId);
  if (p.role === "fireR" || p.role === "fireL") {
    $("btn-fire-r").classList.remove("held");
    $("btn-fire-l").classList.remove("held");
    let still = false;
    pointers.forEach((q) => { if (q.role === "fireR" || q.role === "fireL") still = true; });
    if (!still) player.fireHeld = false;
  }
  if (p.role === "aim") {
    // check other aim pointers
    let still = false;
    pointers.forEach((q) => { if (q.role === "aim") still = true; });
    if (!still) { player.wantAds = false; $("btn-aim").classList.remove("held"); }
  }
  if (p.role === "stick") {
    let still = false;
    pointers.forEach((q) => { if (q.role === "stick") still = true; });
    if (!still) { input.stickX = 0; input.stickZ = 0; input.sprint = false; setKnob(0, 0); }
  }
}
const touchRoot = $("touch");
for (const ev of ["pointerdown"]) touchRoot.addEventListener(ev, onPtrDown);
window.addEventListener("pointermove", onPtrMove);
window.addEventListener("pointerup", onPtrUp);
window.addEventListener("pointercancel", onPtrUp);
window.addEventListener("pointerdown", (e) => {
  // also capture look on the canvas / hud empty areas when not hitting a menu
  if (!document.body.classList.contains("show-touch")) return;
  if (e.target === canvas || e.target === $("hud") || e.target === $("lookZone") || e.target === $("crosshair") || e.target.id === "hurt") {
    onPtrDown(e);
  }
}, { capture: true });

document.addEventListener("visibilitychange", () => {
  if (document.hidden && game.mode === "play") pauseGame();
});

/* ---------------- Menu buttons ---------------- */
$("chip-easy").addEventListener("click", () => { setDiff("easy"); SFX.resume(); SFX.ui(); });
$("chip-normal").addEventListener("click", () => { setDiff("normal"); SFX.resume(); SFX.ui(); });
$("btn-play").addEventListener("click", () => startGame());
$("btn-controls").addEventListener("click", () => { SFX.resume(); SFX.ui(); showScreen("help"); });
$("btn-help-back").addEventListener("click", () => { SFX.ui(); showScreen("menu"); });
$("btn-pause").addEventListener("click", () => pauseGame());
$("btn-resume").addEventListener("click", () => { SFX.ui(); resumeGame(); });
$("btn-restart").addEventListener("click", () => restartGame());
$("btn-menu").addEventListener("click", () => { SFX.ui(); toMenu(); });
$("btn-again").addEventListener("click", () => restartGame());
$("btn-end-menu").addEventListener("click", () => { SFX.ui(); toMenu(); });
$("btn-mute").addEventListener("click", () => { SFX.resume(); SFX.toggle(); });
$("btn-mute-hud").addEventListener("click", () => { SFX.resume(); SFX.toggle(); });

function goAllGames(ev) {
  ev.preventDefault();
  window.location.href = ALL_GAMES;
}
$("menuHome").addEventListener("click", goAllGames);
$("btn-pause-home").addEventListener("click", goAllGames);
$("btn-end-home").addEventListener("click", goAllGames);

/* ---------------- Pickups / win check ---------------- */
function updatePickups() {
  for (const p of pickups) {
    if (p.taken) continue;
    p.mesh.rotation.y += 0.02;
    p.mesh.position.y = 0.05 + Math.sin(game.clock * 2.4 + p.x) * 0.05;
    if (Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < 1.1) {
      p.taken = true;
      p.mesh.visible = false;
      SFX.pickup();
      if (p.type === "health") {
        player.hp = Math.min(player.maxHp, player.hp + p.amount);
        updateHealthHUD();
        showHint("+" + p.amount + " health");
      } else {
        player.reserve.rifle += WPN.rifle.mag * 2;
        player.reserve.smg += WPN.smg.mag;
        updateAmmoHUD();
        showHint("Ammo resupply");
      }
    }
  }
}

function checkObjective() {
  if (game.mode !== "play") return;
  const dist = Math.hypot(radioPos.x - player.pos.x, radioPos.z - player.pos.z);
  if (dist < 2.6) {
    if (enemiesAlive() === 0) onWin();
    else showHint("Clear the remaining soldiers first");
  }
}

/* ---------------- Menu camera + fx ---------------- */
function updateMenuCam(t) {
  const ang = t * 0.08;
  const x = 14 + Math.sin(ang) * 3;
  const z = -18 + Math.cos(ang * 0.7) * 2;
  menuCam.position.set(x, 3.4, z);
  menuCam.lookAt(0, 1.2, 6);
}

function updateFx(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.life -= dt;
    tr.mesh.material.opacity = 0.85 * (tr.life / tr.max);
    if (tr.life <= 0) {
      scene.remove(tr.mesh);
      tracers.splice(i, 1);
    }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.vel.y -= 6 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    if (p.mesh.material.opacity != null) p.mesh.material.opacity = Math.max(0, p.life * 2);
    if (p.life <= 0) {
      scene.remove(p.mesh);
      particles.splice(i, 1);
    }
  }
  // blink radio lamp
  const lamp = world.getObjectByName("radioLamp");
  if (lamp) lamp.material.emissiveIntensity = 0.4 + 0.6 * (Math.sin(game.clock * 6) * 0.5 + 0.5);
}

/* ---------------- Main loop ---------------- */
let lastT = 0;
function frame(ms) {
  requestAnimationFrame(frame);
  const t = ms * 0.001;
  let dt = lastT ? t - lastT : 0.016;
  lastT = t;
  if (dt > 0.05) dt = 0.05;
  game.clock += dt;

  if (game.mode === "menu" || game.mode === "help") {
    updateEnemies(0); // freeze in place visually? still pose
    // actually let them idle slightly
    updateMenuCam(game.clock);
    updateFx(dt);
    renderer.render(scene, menuCam);
    return;
  }

  const inControl = game.mode === "play" || game.mode === "count";

  if (inControl) {
    let ix = 0, iz = 0;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (keys.KeyW || keys.ArrowUp) iz += 1;
    if (keys.KeyS || keys.ArrowDown) iz -= 1;
    if (isTouchMode()) {
      ix += input.stickX;
      iz += input.stickZ;
    }
    const mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; }
    const sprint = !!(keys.ShiftLeft || keys.ShiftRight || input.sprint);
    movePlayer(dt, ix, iz, sprint);

    const want = player.wantAds && player.reloading <= 0 && !player.sprinting;
    player.ads = lerp(player.ads, want ? 1 : 0, 1 - Math.pow(0.0002, dt));
    camera.fov = lerp(72, 48, player.ads);
    camera.updateProjectionMatrix();
    $("crosshair").classList.toggle("ads", player.ads > 0.6);

    if (player.reloading > 0) {
      player.reloading -= dt;
      if (player.reloading <= 0) finishReload();
    }

    if (game.mode === "play") {
      if (currentWpn().semi) {
        if (player.fireClicked) fireWeapon();
      } else if (player.fireHeld) {
        fireWeapon();
      }
    }
    player.fireClicked = false;

    setCameraFromPlayer();
    updateViewmodel(dt, mag > 0.1);
    updatePickups();
    updateObjectiveHUD();
    if (game.hintT > 0) {
      game.hintT -= dt;
      if (game.hintT <= 0) $("hint").classList.remove("on");
    }
  }

  if (game.mode === "count") {
    game.countT -= dt;
    const n = Math.ceil(game.countT);
    $("countdown").textContent = n > 0 ? String(n) : "GO";
    if (game.countT <= 0) beginPlay();
    updateEnemies(0);
  } else if (game.mode === "play") {
    game.playTime += dt;
    if (player.invuln > 0) player.invuln -= dt;
    updateEnemies(dt);
    checkObjective();
  } else if (game.mode === "pause") {
    updateEnemies(0);
  } else {
    updateEnemies(dt * 0.3);
  }

  updateFx(dt);
  renderer.render(scene, camera);
}

/* ---------------- Debug API (tests + troubleshooting) ---------------- */
function snapshot() {
  return {
    mode: game.mode,
    diff: game.diff,
    time: game.playTime,
    shots: game.shots,
    hits: game.hits,
    player: {
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      yaw: player.yaw, pitch: player.pitch,
      hp: player.hp, maxHp: player.maxHp,
      weapon: player.weapon,
      mag: player.mags[player.weapon],
      reserve: player.reserve[player.weapon]
    },
    enemies: enemies.map((e, i) => ({ i, hp: e.hp, alive: e.hp > 0, x: e.pos.x, z: e.pos.z, state: e.state })),
    alive: enemiesAlive()
  };
}

window.__AF = {
  ready: false,
  get state() { return snapshot(); },
  start(diff) { startGame(diff || "easy"); },
  beginPlay() { if (game.mode === "count") { game.countT = 0; beginPlay(); } },
  pause() { pauseGame(); },
  resume() { resumeGame(); },
  restart() { restartGame(); },
  toMenu() { toMenu(); },
  setKey(code, down) { keys[code] = !!down; },
  look(dx, dy) { applyLook(dx, dy, 0.0022); },
  lookAt(x, y, z) {
    const dx = x - player.pos.x, dy = y - (player.pos.y + player.eye), dz = z - player.pos.z;
    // camera looks (-sin yaw, -cos yaw)
    player.yaw = Math.atan2(-dx, -dz);
    const dist = Math.hypot(dx, dz);
    player.pitch = Math.atan2(dy, dist);
    setCameraFromPlayer();
  },
  fire() { player.forceFire = true; player.fireClicked = true; player.fireHeld = true; fireWeapon(); player.fireHeld = false; return game.lastShot; },
  get lastShot() { return game.lastShot; },
  holdFire(v) { player.fireHeld = !!v; if (v) player.fireClicked = true; },
  aim(v) { player.wantAds = !!v; },
  reload() { tryReload(false); },
  switchWeapon,
  teleport(x, y, z) { player.pos.set(x, y || 0, z); setCameraFromPlayer(); },
  damagePlayer(n) { player.invuln = 0; const old = DIFF[game.diff].dmgIn; DIFF[game.diff].dmgIn = 1; hurtPlayer(n); DIFF[game.diff].dmgIn = old; },
  setHp(n) { player.hp = n; updateHealthHUD(); if (n <= 0) onLose(); },
  killEnemy(i) { if (enemies[i]) hurtEnemy(enemies[i], 999, enemies[i].pos.clone().setY(1.2)); },
  killAll() { for (const e of enemies) if (e.hp > 0) hurtEnemy(e, 999, e.pos.clone().setY(1.2)); },
  win() { onWin(); },
  lose() { player.hp = 0; updateHealthHUD(); onLose(); }
};

/* ---------------- Boot ---------------- */
function boot() {
  try {
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) throw new Error("no webgl");
  } catch (e) {
    $("nowebgl").style.display = "flex";
    $("menu").style.display = "none";
    return;
  }
  fitRenderer();
  buildMaterials();
  buildViewmodel();
  buildLevel();
  // park some soldiers in the village for the menu vista
  spawnEnemies();
  placePickups("easy");
  player.yaw = Math.PI;
  setCameraFromPlayer();
  updateMuteButtons();
  loadBests();
  showScreen("menu");
  game.ready = true;
  window.__AF.ready = true;
  requestAnimationFrame(frame);
}

if (renderer && renderer.getContext()) boot();
else {
  $("nowebgl").style.display = "flex";
  $("menu").style.display = "none";
}
