// build — atmosphere kit: floating-island diorama, cloud sea, mouse parallax, mist transitions,
// and DOM-pinned mini 3D viewers. Techniques inspired by scroll-driven 3D marketing sites
// (floating diorama in clouds, camera dives through cloud layers, products pinned to DOM rects).
// All procedural — no external assets.
import * as THREE from "three";

// ---------- deterministic noise ----------
function rng(seed = 7) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---------- cloud puff texture ----------
let _puff;
export function cloudTexture() {
  if (_puff) return _puff;
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d"), r = rng(11);
  for (let i = 0; i < 26; i++) {
    const x = 128 + (r() - 0.5) * 120, y = 140 + (r() - 0.5) * 70, rad = 38 + r() * 52;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, "rgba(255,255,255,0.55)"); gr.addColorStop(0.6, "rgba(255,255,255,0.22)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  _puff = new THREE.CanvasTexture(c); _puff.colorSpace = THREE.SRGBColorSpace;
  return _puff;
}

// ---------- cloud sea ----------
// A field of billboarded puffs in layers. update(dt) drifts them; setOpacity(0..1) fades the whole sea.
// Puffs are lit by a fake gradient: `color` on top, `shadow` underneath (vertex-colour trick via two layers).
export function createCloudSea({
  count = 160, radius = 140, inner = 0, yMin = -40, yMax = 6, size = [26, 60],
  color = 0xffffff, shadow = 0xc9d6e8, opacity = 0.9, drift = 1.2, seed = 3, depthWrite = false,
} = {}) {
  const group = new THREE.Group(); group.name = "cloud-sea";
  const tex = cloudTexture(), r = rng(seed), puffs = [];
  const top = new THREE.Color(color), bot = new THREE.Color(shadow);
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2, d = inner + Math.sqrt(r()) * (radius - inner);
    const y = yMin + Math.pow(r(), 1.6) * (yMax - yMin);
    const t = (y - yMin) / (yMax - yMin || 1);
    const mat = new THREE.SpriteMaterial({ map: tex, color: bot.clone().lerp(top, 0.35 + t * 0.65), transparent: true, opacity, depthWrite, fog: true });
    const s = new THREE.Sprite(mat);
    const k = size[0] + r() * (size[1] - size[0]);
    s.scale.set(k * (1.3 + r() * 0.6), k, 1);
    s.position.set(Math.cos(a) * d, y, Math.sin(a) * d);
    s.userData = { base: opacity, speed: (0.3 + r()) * drift, phase: r() * 10, ang: a, dist: d };
    s.material.rotation = (r() - 0.5) * 0.3;
    group.add(s); puffs.push(s);
  }
  let master = 1, t = 0;
  return {
    group, puffs,
    update(dt) {
      t += dt;
      for (const p of puffs) {
        const u = p.userData; u.ang += (u.speed * dt) / Math.max(30, u.dist) * 0.25;
        p.position.x = Math.cos(u.ang) * u.dist; p.position.z = Math.sin(u.ang) * u.dist;
        p.position.y += Math.sin(t * 0.3 + u.phase) * 0.004;
        p.material.opacity = u.base * master;
      }
    },
    setOpacity(o) { master = o; },
    get opacity() { return master; },
  };
}

// ---------- floating island ----------
// A chunk of land the house sits on: irregular grassy top, layered rock underside tapering to a point,
// a stone path to the front door, low-poly trees, bushes and a few orbiting rock shards.
// W, D = house footprint in ft. Returns { group, update(dt), top (y of grass), parts }.
// The grass cap's bevel tops out at ~+0.5 ft: place the island ~0.55–0.6 ft below the floor slabs.
export function createFloatingIsland(W = 50, D = 36, opts = {}) {
  const {
    grass = 0x8cbf6a, grassEdge = 0x6fa352, dirt = 0x9a7350, rock = 0x7d6a5c, rockDark = 0x5b4c43,
    path = 0xe9e1d2, trunk = 0x7a5537, leaf = [0x5e9e4a, 0x77b35a, 0x4c8a3f], shard = 0x8a7565,
    pad = 14, depth = 46, seed = 5, trees = 9, flat = true, entrance = null, wire = false,
  } = opts;
  const r = rng(seed), group = new THREE.Group(); group.name = "island";
  const rx = W / 2 + pad, rz = D / 2 + pad;
  // outline: noisy ellipse
  const N = 64, pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, n = 0.88 + vnoise(Math.cos(a) * 2 + seed, Math.sin(a) * 2) * 0.22;
    pts.push(new THREE.Vector2(Math.cos(a) * rx * n, Math.sin(a) * rz * n));
  }
  const shape = new THREE.Shape(pts);
  const M = (c, o = {}) => wire ? new THREE.MeshBasicMaterial({ color: c, wireframe: true, transparent: true, opacity: 0.5, ...o })
    : new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, flatShading: flat, ...o });
  // grass cap
  const capGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.6, bevelEnabled: true, bevelThickness: 0.8, bevelSize: 1.2, bevelSegments: 2, steps: 1 });
  capGeo.rotateX(Math.PI / 2); capGeo.translate(0, -0.3, 0);
  const cap = new THREE.Mesh(capGeo, M(grass)); cap.receiveShadow = true; group.add(cap);
  // underside: lathe-like cone built from the outline, rings shrinking downward with noise + strata colours
  const rings = 9, pos = [], col = [], idx = [];
  const cA = new THREE.Color(dirt), cB = new THREE.Color(rock), cC = new THREE.Color(rockDark);
  for (let k = 0; k <= rings; k++) {
    const t = k / rings, y = -2.2 - Math.pow(t, 1.15) * depth;
    const shrink = Math.pow(1 - t, 0.85) * (1 - 0.06 * t) + 0.02;
    const c = t < 0.18 ? cA : t < 0.6 ? cA.clone().lerp(cB, (t - 0.18) / 0.42) : cB.clone().lerp(cC, (t - 0.6) / 0.4);
    for (let i = 0; i < N; i++) {
      const p = pts[i], j = 1 + (vnoise(i * 0.35, k * 0.9 + seed) - 0.5) * 0.35 * Math.min(1, t * 3);
      pos.push(p.x * shrink * j, y + (vnoise(i, k) - 0.5) * 2.5 * t, p.y * shrink * j);
      const band = (k % 2 ? 0.94 : 1.04);
      col.push(c.r * band, c.g * band, c.b * band);
    }
  }
  pos.push(0, -2.2 - depth - 6, 0); col.push(cC.r, cC.g, cC.b);
  for (let k = 0; k < rings; k++) for (let i = 0; i < N; i++) {
    const a = k * N + i, b = k * N + ((i + 1) % N), c = a + N, d = b + N;
    idx.push(a, c, b, b, c, d);
  }
  const tip = (rings + 1) * N;
  for (let i = 0; i < N; i++) idx.push(rings * N + i, tip, rings * N + ((i + 1) % N));
  const ug = new THREE.BufferGeometry();
  ug.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  ug.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  ug.setIndex(idx); ug.computeVertexNormals();
  const under = new THREE.Mesh(ug, wire ? M(rock) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  group.add(under);
  // grass lip
  const lip = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 4, 64), M(grassEdge));
  lip.scale.set(rx * 0.98, rz * 0.98, 6); lip.rotation.x = Math.PI / 2; lip.position.y = -1.6; group.add(lip);

  // path from front door to the island edge
  if (entrance) {
    const [ex, ez] = entrance; // world coords of the front door (house centred at origin)
    const len = rz - Math.abs(ez) + 2;
    for (let i = 0; i < Math.floor(len / 2.2); i++) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.9 + r() * 0.3, 1, 0.18, 7), M(path));
      s.position.set(ex + Math.sin(i * 0.7) * 0.8, 0.6, ez + Math.sign(ez || 1) * (1.6 + i * 2.2));
      s.receiveShadow = true; group.add(s);
    }
  }
  // trees + bushes in the ring outside the footprint
  const keepOut = (x, z) => Math.abs(x) < W / 2 + 2.5 && Math.abs(z) < D / 2 + 2.5;
  const inIsland = (x, z) => (x * x) / (rx * rx * 0.72) + (z * z) / (rz * rz * 0.72) < 1;
  const props = new THREE.Group(); props.name = "island-props"; group.add(props);
  let placed = 0, guard = 0;
  while (placed < trees && guard++ < 400) {
    const x = (r() - 0.5) * rx * 2, z = (r() - 0.5) * rz * 2;
    if (!inIsland(x, z) || keepOut(x, z)) continue;
    if (entrance && Math.abs(x - entrance[0]) < 4 && Math.sign(z) === Math.sign(entrance[1])) continue;
    const t = new THREE.Group(), h = 7 + r() * 7;
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, h * 0.45, 6), M(trunk)); tr.position.y = h * 0.22; t.add(tr);
    const lc = leaf[Math.floor(r() * leaf.length)];
    if (r() > 0.45) {
      for (let k = 0; k < 3; k++) { const c = new THREE.Mesh(new THREE.ConeGeometry(h * (0.32 - k * 0.07), h * 0.42, 7), M(lc)); c.position.y = h * (0.45 + k * 0.17); c.castShadow = true; t.add(c); }
    } else {
      const c = new THREE.Mesh(new THREE.IcosahedronGeometry(h * 0.3, 0), M(lc)); c.position.y = h * 0.62; c.castShadow = true; t.add(c);
    }
    t.position.set(x, 0, z); t.rotation.y = r() * 6; t.userData.sway = r() * 6;
    props.add(t); placed++;
  }
  for (let i = 0; i < trees * 2; i++) {
    const x = (r() - 0.5) * rx * 2, z = (r() - 0.5) * rz * 2;
    if (!inIsland(x, z) || keepOut(x, z)) continue;
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + r() * 1.1, 0), M(leaf[i % leaf.length]));
    b.position.set(x, 0.5, z); b.scale.y = 0.7; b.castShadow = true; props.add(b);
  }
  // orbiting rock shards under the rim
  const shards = [];
  for (let i = 0; i < 7; i++) {
    const s = new THREE.Mesh(new THREE.DodecahedronGeometry(1.2 + r() * 2.4, 0), M(shard));
    const a = r() * Math.PI * 2, d = Math.max(rx, rz) * (0.9 + r() * 0.35);
    s.userData = { a, d, y: -6 - r() * 22, sp: 0.05 + r() * 0.08, bob: r() * 6 };
    s.scale.y = 1.4; shards.push(s); group.add(s);
  }
  let t = 0;
  return {
    group, top: 0, rx, rz, parts: { cap, under, props, shards },
    update(dt) {
      t += dt;
      for (const s of shards) { const u = s.userData; u.a += u.sp * dt; s.position.set(Math.cos(u.a) * u.d, u.y + Math.sin(t * 0.8 + u.bob) * 1.2, Math.sin(u.a) * u.d); s.rotation.x += dt * 0.2; s.rotation.y += dt * 0.3; }
      for (const tr of props.children) if (tr.userData.sway !== undefined) tr.rotation.z = Math.sin(t * 0.9 + tr.userData.sway) * 0.025;
    },
  };
}

// ---------- mouse parallax + idle sway (DOM-agnostic) ----------
// Smoothly tilts `obj` toward the pointer and adds a slow sine sway, like a product on a shelf.
export function attachParallax(obj, { yaw = 0.28, pitch = 0.08, sway = 0.12, swaySpeed = 0.5, bob = 0, base = null } = {}) {
  const m = { x: 0, y: 0 }, s = { x: 0, y: 0 }; let t = 0, enabled = true;
  const b = base ?? { x: obj.rotation.x, y: obj.rotation.y, py: obj.position.y };
  const onMove = (e) => { m.x = (e.clientX / innerWidth) * 2 - 1; m.y = -(e.clientY / innerHeight) * 2 + 1; };
  addEventListener("pointermove", onMove, { passive: true });
  return {
    update(dt) {
      if (!enabled) return; t += dt;
      const k = Math.min(dt * 3, 0.09); s.x += (m.x - s.x) * k; s.y += (m.y - s.y) * k;
      obj.rotation.y = b.y + Math.sin(t * swaySpeed) * sway + s.x * yaw;
      obj.rotation.x = b.x - s.y * pitch;
      if (bob) obj.position.y = b.py + Math.sin(t * 0.9) * bob;
    },
    set enabled(v) { enabled = v; }, get enabled() { return enabled; },
    dispose() { removeEventListener("pointermove", onMove); },
  };
}

// ---------- mist transition (2D canvas overlay) ----------
// cover(): soft puffs billow up from the bottom until the screen is mist; reveal(): they part and drift away.
export function createMist(parent = document.body, { color = "#ffffff", tint = "#dfe8f3", z = 50 } = {}) {
  const c = document.createElement("canvas");
  Object.assign(c.style, { position: "fixed", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: z, opacity: "0" });
  c.setAttribute("aria-hidden", "true"); parent.appendChild(c);
  const g = c.getContext("2d"), r = rng(21);
  let puffs = [], raf = 0, level = 0, target = 0, dpr = Math.min(2, devicePixelRatio || 1);
  const size = () => { c.width = innerWidth * dpr; c.height = innerHeight * dpr; };
  size(); addEventListener("resize", size);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const seed = () => {
    puffs = [];
    for (let i = 0; i < 70; i++) puffs.push({ x: r(), y: r(), r: 0.12 + r() * 0.22, ph: r() * 6, sx: (r() - 0.5) * 0.4 });
  };
  seed();
  const draw = (now) => {
    const W = c.width, H = c.height, L = level;
    g.clearRect(0, 0, W, H);
    if (L <= 0.001) { c.style.opacity = "0"; return; }
    c.style.opacity = "1";
    g.fillStyle = color; g.globalAlpha = Math.max(0, (L - 0.55) / 0.45); g.fillRect(0, 0, W, H); g.globalAlpha = 1;
    for (const p of puffs) {
      // rise from below as level grows, spread sideways on reveal
      const y = H * (1.25 - L * (1.35 - p.y * 0.6)) + Math.sin(now / 1400 + p.ph) * 8 * dpr;
      const x = W * (p.x + p.sx * (1 - L) * (target < level ? 1 : 0.2)) + Math.cos(now / 1700 + p.ph) * 10 * dpr;
      const rad = Math.max(W, H) * p.r * (0.6 + L * 0.7);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, color); gr.addColorStop(0.55, tint + "cc"); gr.addColorStop(1, tint + "00");
      g.globalAlpha = Math.min(1, L * 1.6); g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  };
  const run = (to, ms) => new Promise((res) => {
    cancelAnimationFrame(raf); target = to;
    const from = level, t0 = performance.now(), dur = reduce ? Math.min(ms, 200) : ms;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      level = from + (to - from) * e; draw(now);
      if (p < 1) raf = requestAnimationFrame(step); else res();
    };
    raf = requestAnimationFrame(step);
  });
  return {
    canvas: c,
    cover: (ms = 900) => run(1, ms),
    reveal: (ms = 1100) => run(0, ms),
    // cover, run fn while hidden, reveal
    async through(fn, { cover = 800, hold = 120, reveal = 1100 } = {}) { await run(1, cover); await fn?.(); await new Promise((r) => setTimeout(r, hold)); await run(0, reveal); },
    setColors(col, tn) { color = col; tint = tn; },
  };
}

// ---------- camera dive through clouds ----------
// Animates camera from its current pose down/through to `to` (position) looking at `look`, with a slight
// banking roll and FOV punch — the "fall through the clouds" move. Returns a promise.
export function cameraDive(camera, { to, look = new THREE.Vector3(), ms = 2200, fovPunch = 14, roll = 0.12, onUpdate } = {}) {
  const from = camera.position.clone(), fov0 = camera.fov ?? 0;
  const lookFrom = new THREE.Vector3(); camera.getWorldDirection(lookFrom); lookFrom.multiplyScalar(40).add(from);
  const t0 = performance.now(), L = new THREE.Vector3();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  return new Promise((res) => {
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / (reduce ? 300 : ms));
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      camera.position.lerpVectors(from, to, e);
      camera.position.y += Math.sin(p * Math.PI) * -6; // dip as it passes through the layer
      L.lerpVectors(lookFrom, look, Math.min(1, e * 1.4)); camera.lookAt(L);
      camera.rotation.z += Math.sin(p * Math.PI) * roll;
      if (camera.isPerspectiveCamera) { camera.fov = fov0 + Math.sin(p * Math.PI) * fovPunch; camera.updateProjectionMatrix(); }
      onUpdate?.(p);
      if (p < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}

// centre an object at the origin and scale it to fit a unit box (scale applied before offset)
function fit(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const k = 1 / Math.max(size.x, size.z, size.y * 1.6, 1e-3);
  object.scale.multiplyScalar(k);
  object.position.sub(c).multiplyScalar(k);
}

// ---------- DOM-pinned mini viewers ----------
// One transparent full-screen canvas renders many small scenes, each glued to a DOM element's rect
// (scissor per element). Each mini tilts toward the pointer and sways. Use for room preview cards.
export function createMiniStage({ z = 5, pixelRatio = Math.min(2, devicePixelRatio || 1), light = 0xffffff } = {}) {
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: z });
  canvas.setAttribute("aria-hidden", "true"); document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(pixelRatio); renderer.setScissorTest(true);
  renderer.setClearColor(0x000000, 0); // transparent: an empty stage must not paint the page black
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const items = new Map();
  const m = { x: 0, y: 0 }, s = { x: 0, y: 0 };
  addEventListener("pointermove", (e) => { m.x = (e.clientX / innerWidth) * 2 - 1; m.y = -(e.clientY / innerHeight) * 2 + 1; }, { passive: true });
  let t = 0, last = performance.now(), running = true;
  const resize = () => renderer.setSize(innerWidth, innerHeight, false);
  resize(); addEventListener("resize", resize);
  const loop = () => {
    if (!running) return;
    requestAnimationFrame(loop);
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    const k = Math.min(dt * 3, 0.09); s.x += (m.x - s.x) * k; s.y += (m.y - s.y) * k;
    renderer.setScissor(0, 0, innerWidth, innerHeight); renderer.setViewport(0, 0, innerWidth, innerHeight); renderer.clear();
    for (const [el, it] of items) {
      const b = el.getBoundingClientRect();
      if (!el.isConnected) { items.delete(el); continue; }
      if (b.bottom < 0 || b.top > innerHeight || b.width < 2 || getComputedStyle(el).visibility === "hidden") continue;
      const y = innerHeight - b.bottom;
      renderer.setViewport(b.left, y, b.width, b.height); renderer.setScissor(b.left, y, b.width, b.height);
      it.camera.aspect = b.width / b.height; it.camera.updateProjectionMatrix();
      const hover = it.hover ? 1 : 0; it.h += (hover - it.h) * Math.min(1, dt * 6);
      it.pivot.rotation.y = it.baseYaw + (still ? 0 : Math.sin(t * 0.5 + it.ph) * 0.16 + s.x * 0.35);
      it.pivot.rotation.x = still ? 0 : -s.y * 0.1;
      it.pivot.scale.setScalar(1 + it.h * 0.08);
      it.swap += (it.swapTo - it.swap) * Math.min(1, dt * 8);
      it.pivot.position.y = (1 - it.swap) * -0.4;
      it.pivot.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity = it.swap * (o.userData.baseOpacity ?? 1); } });
      renderer.render(it.scene, it.camera);
    }
  };
  loop();
  return {
    renderer, canvas,
    // object is normalised to fit a unit box; view = "iso" | "front"
    add(el, object, { view = "iso", baseYaw = 0.6, bg = null } = {}) {
      const scene = new THREE.Scene(); if (bg) scene.background = new THREE.Color(bg);
      scene.add(new THREE.HemisphereLight(light, 0x8a8a8a, 1.4));
      const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(3, 5, 2); scene.add(d);
      const pivot = new THREE.Group(); fit(object); pivot.add(object); scene.add(pivot);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
      if (view === "iso") camera.position.set(0, 1.25, 1.55); else camera.position.set(0, 0.35, 2.1);
      camera.lookAt(0, -0.02, 0);
      object.traverse((o) => { if (o.material) o.userData.baseOpacity = o.material.opacity ?? 1; });
      const it = { scene, camera, pivot, baseYaw, ph: Math.random() * 6, hover: false, h: 0, swap: 0, swapTo: 1 };
      el.addEventListener("pointerenter", () => (it.hover = true)); el.addEventListener("pointerleave", () => (it.hover = false));
      items.set(el, it); return it;
    },
    // fade/drop the current object out, put a new one in (like a product switcher)
    async swap(el, object) {
      const it = items.get(el); if (!it) return;
      it.swapTo = 0; await new Promise((r) => setTimeout(r, 220));
      it.pivot.clear(); fit(object);
      object.traverse((o) => { if (o.material) o.userData.baseOpacity = o.material.opacity ?? 1; });
      it.pivot.add(object); it.swapTo = 1;
    },
    remove(el) { items.delete(el); },
    clear() { items.clear(); },
    dispose() { running = false; renderer.dispose(); canvas.remove(); },
  };
}

// ---------- room diorama for minis ----------
// Clone a room's floor, its furniture group and cut-down walls into a standalone object (centred).
export function roomDiorama(house, furniture, roomId, { wallHeight = 3.2 } = {}) {
  const g = new THREE.Group();
  const floor = house.floors[roomId]; if (!floor) return g;
  const c = floor.position.clone();
  const f = floor.clone(); f.material = floor.material.clone(); f.position.sub(c); g.add(f);
  const r = floor.userData.room;
  for (const w of house.walls) {
    const s = w.userData.seg; if (!s) continue;
    const onRoom = (s.y1 === s.y2 && (Math.abs(s.y1 - r.y) < 0.01 || Math.abs(s.y1 - r.y - r.h) < 0.01) && s.x1 < r.x + r.w - 0.01 && s.x2 > r.x + 0.01)
      || (s.x1 === s.x2 && (Math.abs(s.x1 - r.x) < 0.01 || Math.abs(s.x1 - r.x - r.w) < 0.01) && s.y1 < r.y + r.h - 0.01 && s.y2 > r.y + 0.01);
    if (!onRoom || w.userData.part === "header") continue;
    const m = w.clone(); m.material = w.material.clone(); m.position.sub(c);
    m.scale.y = Math.min(1, wallHeight / 9); g.add(m);
  }
  const fg = furniture?.byRoom?.[roomId];
  if (fg) {
    const k = fg.clone(true);
    // copy at full size even if the source is mid-animation (pieces grow via scale)
    k.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.opacity = 1; } if (o.isMesh) o.scale.set(1, 1, 1); o.visible = true; });
    k.scale.set(1, 1, 1); k.position.sub(c); g.add(k);
  }
  // clip walls that run past the room (shared long walls) by scaling into the room's bounds
  const half = new THREE.Vector3(r.w / 2 + 0.3, 50, r.h / 2 + 0.3);
  g.children.forEach((m) => {
    if (!m.geometry || m === f) return;
    const b = new THREE.Box3().setFromObject(m);
    if (b.min.x < -half.x || b.max.x > half.x || b.min.z < -half.z || b.max.z > half.z) {
      const sx = Math.min(1, (half.x * 2) / (b.max.x - b.min.x)), sz = Math.min(1, (half.z * 2) / (b.max.z - b.min.z));
      const cx = (b.max.x + b.min.x) / 2, cz = (b.max.z + b.min.z) / 2;
      m.scale.x *= sx; m.scale.z *= sz;
      m.position.x = THREE.MathUtils.clamp(cx, -half.x, half.x) - (cx - m.position.x) * sx;
      m.position.z = THREE.MathUtils.clamp(cz, -half.z, half.z) - (cz - m.position.z) * sz;
    }
  });
  return g;
}
