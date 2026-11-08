// build — shared mockup engine.
// Mock data + 3D house builder + "thinking" script + first-person walker.
// Every mockup imports this so all 5 designs show the same house and the same build story.
// Swap LAYOUT / THINKING_SCRIPT for live API data later (GenerateResponse in docs/CONTRACTS.md).
import * as THREE from "three";
import { generate, parsePrompt } from "./planner.js";
export { generate, parsePrompt };

export const BRAND = { blue: "#2B45F5", ink: "#151515", paper: "#F6F5F1" };
export const DEFAULT_PROMPT = "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft";
// The default house comes from the mock planner (core/planner.js); call generate(prompt) for others.
export const DEFAULT_PLAN = generate(DEFAULT_PROMPT);
export const LAYOUT = DEFAULT_PLAN.layout, PROGRAM = DEFAULT_PLAN.program;

// Logo mark (the blue "b") as an SVG path in a 273 x 280 box.
export const MARK_PATH =
  "M0 62 L101 0 L104 93 L273 153 L273 239 L187 280 L48 280 L176 209 L176 153 L104 116 L104 199 L0 262 Z";
export function markSVG(color = BRAND.blue, size = 28) {
  return `<svg viewBox="0 0 273 280" width="${size}" height="${(size * 280) / 273}" aria-hidden="true"><path d="${MARK_PATH}" fill="${color}"/></svg>`;
}
// Full lockup: mark + "uild" set in the page's display face (pass the font family in CSS).
export function lockupHTML({ color = BRAND.blue, ink = BRAND.ink, size = 28 } = {}) {
  return `<span class="build-lockup" style="display:inline-flex;align-items:flex-end;gap:${size * 0.06}px;line-height:1">
    ${markSVG(color, size)}<span style="font-weight:600;font-size:${size * 1.02}px;letter-spacing:-0.03em;color:${ink};margin-bottom:-${size * 0.08}px">uild</span></span>`;
}

// ---------- rules (CONTRACTS.md) ----------
export const RULES = [
  { id: "no_overlap_in_footprint", label: "No rooms overlap, all inside the footprint" },
  { id: "all_rooms_reachable", label: "Every room reachable from the front door" },
  { id: "bedroom_exterior_wall", label: "Every bedroom has a window wall and a door" },
  { id: "public_bathroom", label: "A bathroom guests can reach without a bedroom" },
  { id: "kitchen_adjacent", label: "Kitchen opens onto dining or living" },
  { id: "min_hall_and_door_width", label: "Halls at least 3 ft, doors at least 2'8\"" },
  { id: "sizes_within_10pct", label: "Every room within 10% of its target size" },
];

// ---------- walls (port of frontend/src/lib/walls.ts) ----------
export const GRID = 0.5, WALL_T = 0.33, WALL_H = 9, EYE_H = 5.5;
const k = (n) => Math.round(n / GRID);
export function buildWalls(layout = LAYOUT) {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const H = new Set(), V = new Set();
  for (const r of layout.rooms) {
    const [x0, x1, y0, y1] = [k(r.x), k(r.x + r.w), k(r.y), k(r.y + r.h)];
    for (let c = x0; c < x1; c++) { H.add(`${y0},${c}`); H.add(`${y1},${c}`); }
    for (let rr = y0; rr < y1; rr++) { V.add(`${x0},${rr}`); V.add(`${x1},${rr}`); }
  }
  for (const d of layout.doors) {
    const half = d.width_ft / 2, row = k(d.y), col = Math.floor(d.x / GRID);
    if (H.has(`${row},${col}`) || H.has(`${row},${col - 1}`)) {
      for (let c = k(d.x - half); c < k(d.x + half); c++) H.delete(`${row},${c}`);
    } else {
      const vcol = k(d.x);
      for (let rr = k(d.y - half); rr < k(d.y + half); rr++) V.delete(`${vcol},${rr}`);
    }
  }
  // open-plan pairs (layout.open): no wall on their shared edge
  for (const [a, b] of layout.open ?? []) {
    const A = roomById(a, layout), B = roomById(b, layout); if (!A || !B) continue;
    for (const [P, Q] of [[A, B], [B, A]]) {
      if (Math.abs(P.x + P.w - Q.x) < 0.01) { const y0 = Math.max(P.y, Q.y), y1 = Math.min(P.y + P.h, Q.y + Q.h); for (let rr = k(y0); rr < k(y1); rr++) V.delete(`${k(Q.x)},${rr}`); }
      if (Math.abs(P.y + P.h - Q.y) < 0.01) { const x0 = Math.max(P.x, Q.x), x1 = Math.min(P.x + P.w, Q.x + Q.w); for (let c = k(x0); c < k(x1); c++) H.delete(`${k(Q.y)},${c}`); }
    }
  }
  const segs = [];
  const merge = (set, horizontal) => {
    const lines = new Map();
    for (const key of set) {
      const [line, pos] = key.split(",").map(Number);
      if (!lines.has(line)) lines.set(line, []);
      lines.get(line).push(pos);
    }
    for (const [line, ps] of lines) {
      ps.sort((a, b) => a - b);
      let start = ps[0], prev = ps[0];
      const flush = () => {
        const a = start * GRID, b = (prev + 1) * GRID, l = line * GRID;
        const exterior = horizontal ? l === 0 || l === D : l === 0 || l === W;
        segs.push(horizontal ? { x1: a, y1: l, x2: b, y2: l, exterior } : { x1: l, y1: a, x2: l, y2: b, exterior });
      };
      for (const p of ps.slice(1)) { if (p !== prev + 1) { flush(); start = p; } prev = p; }
      flush();
    }
  };
  merge(H, true); merge(V, false);
  // tag each segment with the room whose edge it lies on (first match) — used for per-room build order
  for (const s of segs) {
    const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
    const r = layout.rooms.find((r) =>
      (Math.abs(mx - r.x) < 0.01 || Math.abs(mx - (r.x + r.w)) < 0.01 ? my >= r.y && my <= r.y + r.h : false) ||
      (Math.abs(my - r.y) < 0.01 || Math.abs(my - (r.y + r.h)) < 0.01 ? mx >= r.x && mx <= r.x + r.w : false));
    s.roomId = r ? r.id : null;
  }
  return segs;
}

export function roomById(id, layout = LAYOUT) { return layout.rooms.find((r) => r.id === id); }
export const sqft = (r) => Math.round(r.w * r.h);
export const fmtFt = (n) => { const f = Math.floor(n), i = Math.round((n - f) * 12); return i ? `${f}'${i}"` : `${f}'`; };

// ---------- 3D house ----------
// Coordinates: plan (x, y) -> three (x, z), centered on the footprint. 1 unit = 1 ft. y is up.
// Wall geometry pivots at the floor so mesh.scale.y = 0..1 "raises" a wall.
export function buildHouse(layout = LAYOUT, opts = {}) {
  const {
    floorColor = (room) => 0xe9e6df, wallColor = 0xffffff, exteriorWallColor = null,
    wallHeight = WALL_H, glassColor = 0x9fc3ff, frameColor = 0x2b45f5, castShadow = true,
  } = opts;
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const ox = -W / 2, oz = -D / 2;
  const group = new THREE.Group();
  group.name = "house";
  const floors = {}, walls = [], windows = [], doorFrames = [];

  for (const r of layout.rooms) {
    const g = new THREE.BoxGeometry(r.w - 0.04, 0.25, r.h - 0.04);
    g.translate(0, -0.125, 0);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: floorColor(r), roughness: 0.85 }));
    m.position.set(ox + r.x + r.w / 2, 0, oz + r.y + r.h / 2);
    m.receiveShadow = true;
    m.userData = { room: r, kind: "floor" };
    floors[r.id] = m; group.add(m);
  }

  const segs = buildWalls(layout);
  const wallMatInt = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.9 });
  const wallMatExt = new THREE.MeshStandardMaterial({ color: exteriorWallColor ?? wallColor, roughness: 0.9 });
  const winLines = windowLines(layout);
  // Each wall segment becomes 1+ pieces: full-height runs, and sill (0–3 ft) + header (7 ft–top)
  // where a window cuts through. Every piece pivots at the floor so scale.y still "raises" it.
  for (const s of segs) {
    const horiz = s.y1 === s.y2;
    const a0 = horiz ? s.x1 : s.y1, b0 = horiz ? s.x2 : s.y2, line = horiz ? s.y1 : s.x1;
    const cuts = winLines
      .filter((w) => w.horiz === horiz && Math.abs(w.line - line) < 0.01 && w.a >= a0 - 0.01 && w.b <= b0 + 0.01)
      .sort((p, q) => p.a - q.a);
    const pieces = []; let cur = a0;
    for (const c of cuts) {
      if (c.a > cur) pieces.push([cur, c.a, 0, wallHeight]);
      pieces.push([c.a, c.b, 0, 3], [c.a, c.b, 7, wallHeight]);
      cur = c.b;
    }
    if (cur < b0) pieces.push([cur, b0, 0, wallHeight]);
    for (const [a, b, y0, y1] of pieces) {
      const ea = a === a0 ? a - WALL_T / 2 : a, eb = b === b0 ? b + WALL_T / 2 : b;
      const len = eb - ea, hh = y1 - y0;
      const g = new THREE.BoxGeometry(horiz ? len : WALL_T, hh, horiz ? WALL_T : len);
      g.translate(0, y0 + hh / 2, 0);
      const m = new THREE.Mesh(g, s.exterior ? wallMatExt : wallMatInt);
      const mid = (ea + eb) / 2;
      m.position.set(ox + (horiz ? mid : line), 0, oz + (horiz ? line : mid));
      m.castShadow = castShadow; m.receiveShadow = true;
      m.userData = { seg: s, kind: "wall", roomId: s.roomId, part: y0 > 0 ? "header" : hh < wallHeight ? "sill" : "full" };
      walls.push(m); group.add(m);
    }
  }

  // ceilings: hidden by default, turn on for first-person (ceilings.visible = true)
  const ceilings = new THREE.Group(); ceilings.visible = false; ceilings.name = "ceilings";
  const ceilMat = new THREE.MeshStandardMaterial({ color: opts.ceilingColor ?? 0xf3f1ec, roughness: 1, side: THREE.DoubleSide });
  for (const r of layout.rooms) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), ceilMat);
    p.rotation.x = Math.PI / 2; p.position.set(ox + r.x + r.w / 2, wallHeight, oz + r.y + r.h / 2);
    ceilings.add(p);
  }
  group.add(ceilings);

  // windows: thin glass pane sitting in the wall opening (3–7 ft)
  const glassMat = new THREE.MeshStandardMaterial({ color: glassColor, transparent: true, opacity: 0.45, roughness: 0.05, metalness: 0.1 });
  for (const w of layout.windows) {
    const r = roomById(w.room, layout);
    let x, z, horiz = w.wall === "north" || w.wall === "south";
    if (w.wall === "north") { x = r.x + w.offset_ft + w.width_ft / 2; z = r.y; }
    if (w.wall === "south") { x = r.x + w.offset_ft + w.width_ft / 2; z = r.y + r.h; }
    if (w.wall === "west") { x = r.x; z = r.y + w.offset_ft + w.width_ft / 2; }
    if (w.wall === "east") { x = r.x + r.w; z = r.y + w.offset_ft + w.width_ft / 2; }
    const g = new THREE.BoxGeometry(horiz ? w.width_ft : 0.08, 4, horiz ? 0.08 : w.width_ft);
    g.translate(0, 2, 0);
    const m = new THREE.Mesh(g, glassMat);
    m.position.set(ox + x, 3, oz + z);
    m.userData = { kind: "window", roomId: w.room };
    windows.push(m); group.add(m);
  }

  // door frames (thin header over each opening)
  const frameMat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.5 });
  for (const d of layout.doors) {
    const horizWall = layout.rooms.some((r) => Math.abs(r.y - d.y) < 0.01 || Math.abs(r.y + r.h - d.y) < 0.01)
      && !layout.rooms.some((r) => Math.abs(r.x - d.x) < 0.01 && d.y > r.y && d.y < r.y + r.h);
    const g = new THREE.BoxGeometry(horizWall ? d.width_ft : WALL_T + 0.06, wallHeight - 7, horizWall ? WALL_T + 0.06 : d.width_ft);
    g.translate(0, (wallHeight - 7) / 2, 0);
    const m = new THREE.Mesh(g, frameMat);
    m.position.set(ox + d.x, 7, oz + d.y);
    m.userData = { kind: "door", door: d, front: d.between.includes("exterior") };
    doorFrames.push(m); group.add(m);
  }

  return {
    group, floors, walls, windows, doorFrames, segs, ceilings,
    toWorld: (x, y) => new THREE.Vector3(ox + x, 0, oz + y),
    size: { W, D },
    roomCenter: (id) => { const r = roomById(id, layout); return new THREE.Vector3(ox + r.x + r.w / 2, 0, oz + r.y + r.h / 2); },
  };
}

// Simple tweens without a library.
export const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};
// Physically based spring curves (mass 1), normalised so t = 0..1 spans the whole settle. Use with tween():
//   ease.spring  — lively, one soft overshoot (placing rooms, popping labels)
//   ease.settle  — gentle, almost no overshoot (camera moves, panels)
//   ease.drop    — falls in and bounces twice before resting (furniture landing, slabs dropping)
export function springEase(stiffness = 170, damping = 18) {
  const N = 240, xs = [0]; let x = 0, v = 0, dt = 1 / 120, steps = 0;
  while (steps < 2000) { const a = -stiffness * (x - 1) - damping * v; v += a * dt; x += v * dt; xs.push(x); steps++; if (steps > 30 && Math.abs(x - 1) < 0.0008 && Math.abs(v) < 0.002) break; }
  const L = xs.length - 1, curve = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) { const f = (i / N) * L, i0 = Math.floor(f), i1 = Math.min(L, i0 + 1); curve[i] = xs[i0] + (xs[i1] - xs[i0]) * (f - i0); }
  curve[N] = 1;
  return (t) => { if (t <= 0) return 0; if (t >= 1) return 1; const f = t * N, i = Math.floor(f); return curve[i] + (curve[i + 1] - curve[i]) * (f - i); };
}
ease.spring = springEase(170, 16);
ease.settle = springEase(110, 21);
ease.drop = springEase(320, 13);
// Frame-rate independent smoothing toward a target (critically damped). Keep `state.v` between frames.
export function smoothDamp(current, target, state, smoothTime, dt) {
  const omega = 2 / Math.max(0.0001, smoothTime), x = omega * dt, exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target, temp = ((state.v ?? 0) + omega * change) * dt;
  state.v = ((state.v ?? 0) - omega * temp) * exp;
  return target + (change + temp) * exp;
}
const tweens = new Set();
export function tween(ms, fn, easing = ease.outCubic, delay = 0) {
  return new Promise((res) => {
    const t = { start: performance.now() + delay, ms, fn, easing, res };
    tweens.add(t);
  });
}
export function tickTweens(now = performance.now()) {
  for (const t of tweens) {
    if (now < t.start) continue;
    const p = Math.min(1, (now - t.start) / t.ms);
    t.fn(t.easing(p), p);
    if (p >= 1) { tweens.delete(t); t.res(); }
  }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the build story (mock of planner -> solver -> checker fix loop) ----------
// Event types: phase | thought | room | place | check | fix | walls | done
// `at` is ms from start at speed 1. Total ~16 s. The fix round mirrors the PRD demo beat.
export const PHASES = [
  { id: "read", label: "Reading your brief" },
  { id: "plan", label: "Planning rooms" },
  { id: "solve", label: "Placing walls" },
  { id: "check", label: "Checking layout rules" },
  { id: "raise", label: "Raising the house" },
  { id: "furnish", label: "Furnishing rooms" },
];
export function buildScript(prompt = DEFAULT_PROMPT, plan = null) {
  plan ??= prompt === DEFAULT_PROMPT ? DEFAULT_PLAN : generate(prompt);
  const { layout, program, parsed: p, summary } = plan;
  const ev = [];
  let t = 0;
  const add = (dt, e) => { t += dt; ev.push({ at: t, ...e }); };
  const has = (id) => layout.rooms.some((r) => r.id === id);
  const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  add(0, { type: "phase", id: "read" });
  add(300, { type: "thought", text: `“${prompt}”` });
  add(900, { type: "thought", text: p.beds ? `${pl(p.beds, "bedroom")}, ${pl(p.baths, "bath")}. The primary gets its own bath and a walk-in closet.` : "No separate bedroom: one open room for living and sleeping." });
  add(800, { type: "thought", text: p.open ? "Open kitchen: no walls between kitchen, dining and living, so it reads as one great room." : "Closed kitchen: separate rooms joined by doors." });
  if (p.office) add(800, { type: "thought", text: "Office goes by the front door, so work calls never cross the bedrooms." });
  if (p.mud) add(700, { type: "thought", text: "Mudroom doubles as the laundry, right off the hall." });
  if (p.bigKitchen) add(700, { type: "thought", text: "Big kitchen: room for an island with seating and a full run of counters." });
  add(700, { type: "phase", id: "plan" });
  for (const r of program.rooms) add(200, { type: "room", room: r });
  add(400, { type: "thought", text: `${pl(program.rooms.length, "room")}, ${program.rooms.reduce((a, r) => a + r.target_sqft, 0)} sq ft before circulation.` });
  add(500, { type: "phase", id: "solve" });
  add(300, { type: "thought", text: summary.zoning });
  add(600, { type: "thought", text: `Footprint ${summary.W} × ${summary.D} ft, front door on the south side.` });
  for (const r of layout.rooms) add(240, { type: "place", roomId: r.id });
  add(500, { type: "phase", id: "check" });
  const fixKD = has("kitchen") && has("dining");
  const firstFail = fixKD ? "kitchen_adjacent" : "sizes_within_10pct";
  for (const rule of RULES.map((r) => r.id)) {
    if (rule === firstFail) add(320, { type: "check", rule, pass: false, message: fixKD
      ? "Kitchen shares 0 ft of wall with Dining (a service room sat between them); it needs at least 3 ft."
      : "Living is 14% under its target size." });
    else add(260, { type: "check", rule, pass: true });
  }
  add(700, { type: "fix", round: 1, note: fixKD ? "Move the service rooms to the end of the north row so Kitchen and Dining share their whole wall, then open it up." : "Grow Living into the slack along the south wall." });
  if (fixKD) { add(900, { type: "place", roomId: "kitchen", reflow: true }); add(200, { type: "place", roomId: "dining", reflow: true }); }
  else add(900, { type: "place", roomId: "living", reflow: true });
  add(400, { type: "check", rule: firstFail, pass: true, round: 2 });
  add(300, { type: "thought", text: "All 7 rules pass after 1 fix round." });
  add(500, { type: "phase", id: "raise" });
  add(200, { type: "walls" });
  add(2400, { type: "phase", id: "furnish" });
  const note = (r) => ({
    primary_bedroom: "Bed against the solid wall, nightstands both sides, the doors stay clear.",
    kitchen: "Counters along the window wall; the island keeps 3.5 ft walkways.",
    dining: "Table runs the long way so chairs clear the kitchen.",
    living: "Sofa faces the media wall, out of the front-door path.",
    office: r.name === "Office" ? "Desk under the window, door swing kept clear." : null,
    laundry: "Washer and dryer side by side, shelving above.",
  })[r.type] ?? null;
  for (const r of layout.rooms) {
    const n = note(r); if (n) add(120, { type: "thought", text: n });
    add(200, { type: "furnish", roomId: r.id });
  }
  const secs = 17 + (prompt.length % 7) + 0.4;
  add(900, { type: "done", stats: { rooms: layout.rooms.length, sqft: summary.sqft, rounds: 1, rulesPassed: 7, seconds: +secs.toFixed(1), pieces: 0 } });
  return ev;
}

// Plays a script; onEvent(e) fires for each event. Returns { cancel }.
export function playScript(script, onEvent, { speed = 1 } = {}) {
  let cancelled = false; const timers = [];
  for (const e of script) timers.push(setTimeout(() => !cancelled && onEvent(e), e.at / speed));
  return { cancel: () => { cancelled = true; timers.forEach(clearTimeout); }, duration: script.at(-1).at / speed };
}

// ---------- first-person walker (WASD + drag/pointer look, AABB collision) ----------
// opts.extraBoxes: world-space {minX,maxX,minZ,maxZ} (e.g. furniture.boxes) to collide with too.
export function createWalker(camera, dom, layout = LAYOUT, opts = {}) {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const ox = -W / 2, oz = -D / 2, t = WALL_T / 2 + 0.9;
  const boxes = buildWalls(layout).map((s) => ({
    minX: ox + Math.min(s.x1, s.x2) - t, maxX: ox + Math.max(s.x1, s.x2) + t,
    minZ: oz + Math.min(s.y1, s.y2) - t, maxZ: oz + Math.max(s.y1, s.y2) + t,
  }));
  for (const b of opts.extraBoxes ?? []) boxes.push({ minX: b.minX - 0.8, maxX: b.maxX + 0.8, minZ: b.minZ - 0.8, maxZ: b.maxZ + 0.8 });
  const hit = (x, z) => boxes.some((b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ);
  const keys = {}; let yaw = 0, pitch = 0, dragging = false, lx = 0, ly = 0, active = false;
  const onKey = (e) => { if (!active) return; keys[e.key.toLowerCase()] = e.type === "keydown"; };
  const onDown = (e) => { if (!active) return; dragging = true; lx = e.clientX; ly = e.clientY; };
  const onUp = () => (dragging = false);
  const onMove = (e) => {
    if (!active || !dragging) return;
    yaw -= (e.clientX - lx) * 0.004; pitch -= (e.clientY - ly) * 0.003;
    pitch = Math.max(-1.1, Math.min(1.1, pitch)); lx = e.clientX; ly = e.clientY;
  };
  addEventListener("keydown", onKey); addEventListener("keyup", onKey);
  dom.addEventListener("pointerdown", onDown); addEventListener("pointerup", onUp); addEventListener("pointermove", onMove);
  const api = {
    get active() { return active; },
    // Drop in at the front door, facing into the house.
    enter() {
      active = true; const e = layout.entrance;
      camera.position.set(ox + e.x, EYE_H, oz + e.y - 2.5); yaw = 0; pitch = 0;
    },
    exit() { active = false; for (const k in keys) keys[k] = false; },
    // where am I, in plan feet — for minimaps
    planPos() { return { x: camera.position.x - ox, y: camera.position.z - oz, heading: yaw }; },
    roomAt() { const p = api.planPos(); return layout.rooms.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h); },
    update(dt) {
      if (!active) return;
      const sp = (keys.shift ? 11 : 6.5) * dt;
      let f = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0);
      let s = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
      const dx = (-Math.sin(yaw) * f + Math.cos(yaw) * s) * sp, dz = (-Math.cos(yaw) * f - Math.sin(yaw) * s) * sp;
      const p = camera.position;
      if (!hit(p.x + dx, p.z)) p.x += dx;
      if (!hit(p.x, p.z + dz)) p.z += dz;
      p.y = EYE_H + Math.sin(performance.now() / 180) * (f || s ? 0.05 : 0);
      camera.rotation.set(pitch, yaw, 0, "YXZ");
    },
    dispose() {
      removeEventListener("keydown", onKey); removeEventListener("keyup", onKey);
      dom.removeEventListener("pointerdown", onDown); removeEventListener("pointerup", onUp); removeEventListener("pointermove", onMove);
    },
  };
  return api;
}

// ---------- 2D plan SVG (shared helper, style via CSS classes) ----------
// Classes: .p-room, .p-room[data-type], .p-wall, .p-wall.ext, .p-door, .p-win, .p-label, .p-dim
export function planSVG(layout = LAYOUT, { pad = 2, labels = true, dims = true } = {}) {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const segs = buildWalls(layout);
  const rooms = layout.rooms.map((r) => `<rect class="p-room" data-id="${r.id}" data-type="${r.type}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`).join("");
  const walls = segs.map((s) => `<line class="p-wall${s.exterior ? " ext" : ""}" data-room="${s.roomId}" x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}"/>`).join("");
  const wins = layout.windows.map((w) => {
    const r = roomById(w.room, layout);
    const [x1, y1, x2, y2] = w.wall === "north" ? [r.x + w.offset_ft, r.y, r.x + w.offset_ft + w.width_ft, r.y]
      : w.wall === "south" ? [r.x + w.offset_ft, r.y + r.h, r.x + w.offset_ft + w.width_ft, r.y + r.h]
      : w.wall === "west" ? [r.x, r.y + w.offset_ft, r.x, r.y + w.offset_ft + w.width_ft]
      : [r.x + r.w, r.y + w.offset_ft, r.x + r.w, r.y + w.offset_ft + w.width_ft];
    return `<line class="p-win" data-room="${w.room}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join("");
  const lbl = labels ? layout.rooms.filter((r) => r.type !== "closet").map((r) => {
    const small = r.w < 6 || r.h < 6; const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const rot = r.w < 6 && r.h > r.w ? ` transform="rotate(-90 ${cx} ${cy})"` : "";
    return `<g class="p-label" data-room="${r.id}"${rot}><text x="${cx}" y="${cy - (dims && !small ? 0.4 : -0.4)}" text-anchor="middle">${r.name}</text>${dims && !small ? `<text class="p-dim" x="${cx}" y="${cy + 1.6}" text-anchor="middle">${fmtFt(r.w)} × ${fmtFt(r.h)}</text>` : ""}</g>`;
  }).join("") : "";
  const e = layout.entrance;
  return `<svg class="plan-svg" viewBox="${-pad} ${-pad} ${W + pad * 2} ${D + pad * 2}" xmlns="http://www.w3.org/2000/svg">
    <g class="p-rooms">${rooms}</g><g class="p-walls">${walls}</g><g class="p-wins">${wins}</g>
    <g class="p-entry"><path class="p-door" d="M${e.x - 1.5} ${e.y + 0.9} L${e.x} ${e.y + 0.2} L${e.x + 1.5} ${e.y + 0.9}"/></g>
    <g class="p-labels">${lbl}</g></svg>`;
}

// ---------- windows as plan lines (used to cut wall openings) ----------
export function windowLines(layout = LAYOUT) {
  return layout.windows.map((w) => {
    const r = roomById(w.room, layout);
    if (w.wall === "north") return { horiz: true, line: r.y, a: r.x + w.offset_ft, b: r.x + w.offset_ft + w.width_ft };
    if (w.wall === "south") return { horiz: true, line: r.y + r.h, a: r.x + w.offset_ft, b: r.x + w.offset_ft + w.width_ft };
    if (w.wall === "west") return { horiz: false, line: r.x, a: r.y + w.offset_ft, b: r.y + w.offset_ft + w.width_ft };
    return { horiz: false, line: r.x + r.w, a: r.y + w.offset_ft, b: r.y + w.offset_ft + w.width_ft };
  });
}

// ---------- furniture ----------
// Low-poly placeholder furniture, placed by rules per room type (PRD: "a few placeholders").
// Each room gets a local frame: v = distance from its "back wall" (the wall facing its door),
// u = position along that wall. Pieces that land in a door's swing zone are dropped.
export const FURNITURE_STYLES = {
  neutral: { wood: 0xc7a27a, fabric: 0xd9d4ca, soft: 0xeeeae2, accent: 0x2b45f5, dark: 0x3a3a3e, white: 0xfbfaf7, rug: 0xcfc6b6, metal: 0xb9bcc2, glow: 0xfff1d6 },
  // Lived-in colour: sage sofa, mustard + clay accents, a different bedding colour per bedroom.
  colorful: {
    wood: 0xb07a4f, fabric: 0x6f8f7b, soft: 0xf1ebe0, accent: 0x2b45f5, accent2: 0xe0a33a, accent3: 0xc8664f,
    dark: 0x2f3138, white: 0xf7f5f0, stone: 0xece8e1, rug: 0xd8c6a6, metal: 0xc3c7cc, glow: 0xffe2b0,
    art: 0x2b45f5, leaf: 0x4f8a4b, pot: 0xb8693f, throw: 0xe0a33a, books: 0x7a4b8c,
    perType: {
      kitchen: { white: 0x7d9a86, wood: 0x8a5a3b, dark: 0x2f3138 },
      dining: { soft: 0x3a3d45, rug: 0xb9a07e },
      bathroom: { accent: 0x4f9a95, rug: 0x9fc5c0, wood: 0x8a5a3b },
      office: { rug: 0x8fa3b8, accent3: 0xe07a3a },
      laundry: { wood: 0xa98463, accent: 0x6fa0c8 },
      closet: { fabric: 0x9a8f86 },
    },
    perRoom: {
      primary_bedroom: { accent: 0x2e4a7a, throw: 0xe0a33a, rug: 0xc9b8a0, art: 0xc8664f },
      bedroom_2: { accent: 0xd99191, throw: 0x6f9c8a, rug: 0xe7d7c3, art: 0x4f9a95 },
      bedroom_3: { accent: 0x4f9a95, throw: 0xf0c75e, rug: 0xd9cbb5, art: 0xe0a33a },
      bedroom_4: { accent: 0x8f78b8, throw: 0xe7a0a0, art: 0x2b45f5 },
      flex: { fabric: 0xc8664f },
    },
  },
};
const COLOR_FALLBACK = { accent2: "accent", accent3: "fabric", stone: "white", art: "accent", throw: "soft", books: "dark" };
const COLOR_DEFAULTS = { leaf: 0x5a8f4e, pot: 0xb5653f };
const doorWall = (r, d) => Math.abs(d.y - r.y) < 0.01 ? "north" : Math.abs(d.y - (r.y + r.h)) < 0.01 ? "south" : Math.abs(d.x - r.x) < 0.01 ? "west" : "east";
const OPP = { north: "south", south: "north", east: "west", west: "east" };
function roomFrame(r, layout) {
  const doors = layout.doors.filter((d) => d.between.includes(r.id));
  const walls = doors.map((d) => doorWall(r, d));
  let back;
  if (r.back) back = r.back;
  else if (!walls.length) back = "north";
  else if (walls.some((w) => walls.includes(OPP[w]))) {
    // doors on opposite walls: use a side wall (prefer exterior)
    const side = walls.includes("north") || walls.includes("south") ? ["east", "west"] : ["north", "south"];
    const { width_ft: W, depth_ft: D } = layout.footprint;
    const ext = { north: r.y === 0, south: Math.abs(r.y + r.h - D) < 0.01, west: r.x === 0, east: Math.abs(r.x + r.w - W) < 0.01 };
    back = ext[side[0]] ? side[0] : side[1];
  } else back = OPP[walls[0]];
  const ns = back === "north" || back === "south";
  const U = ns ? r.w : r.h, V = ns ? r.h : r.w;
  // local (u, v) -> plan (x, y)
  const toPlan = (u, v) => back === "north" ? [r.x + u, r.y + v] : back === "south" ? [r.x + u, r.y + r.h - v]
    : back === "west" ? [r.x + v, r.y + u] : [r.x + r.w - v, r.y + u];
  const doorsUV = doors.map((d) => {
    const ux = ns ? d.x - r.x : d.y - r.y;
    const dw = doorWall(r, d);
    const vv = dw === back ? 0 : dw === OPP[back] ? V : (ns ? (back === "north" ? d.y - r.y : r.y + r.h - d.y) : (back === "west" ? d.x - r.x : r.x + r.w - d.x));
    const along = (dw === "north" || dw === "south") === ns; // door wall parallel to back wall
    const vPerp = back === "north" ? d.y - r.y : back === "south" ? r.y + r.h - d.y : back === "west" ? d.x - r.x : r.x + r.w - d.x;
    return along ? { u: ux, v: vv, w: d.width_ft, along: true } : { u: dw === (ns ? "west" : "north") ? 0 : U, v: vPerp, w: d.width_ft, along: false };
  });
  return { back, ns, U, V, toPlan, doorsUV };
}

// A piece: [u, v, w (along u), d (along v), h, y0, colorKey, opts]. opts.item groups parts that move
// together when furniture is dragged (bed + mattress + pillows...). opts.wall = hangs on the back wall.
function piecesFor(r, U, V) {
  const P = []; const c = U / 2; let n = 0;
  const add = (u, v, w, d, h, y0, col, o = {}) => P.push({ u, v, w, d, h, y0, col, item: o.item ?? `p${n++}`, ...o });
  const plant = (u, v, item = "plant") => {
    add(u, v, 1.2, 1.2, 1.3, 0, "pot", { round: 0.2, item, name: "planter", collide: true });
    add(u, v, 1.7, 1.7, 1.9, 1.3, "leaf", { round: 0.8, item, name: "plant" });
  };
  const t = r.type;
  if (t === "bedroom" || t === "primary_bedroom") {
    const bw = t === "primary_bedroom" ? 6.4 : 5, bd = 6.9, B = { item: "bed", cluster: "bed" };
    add(c, bd / 2 + 0.3, bw + 0.2, bd, 1.1, 0, "wood", { ...B, collide: true, name: "bed" });
    add(c, 0.35, bw + 0.6, 0.3, 3.8, 0, "dark", { ...B, name: "headboard" });
    add(c, bd / 2 + 0.45, bw - 0.1, bd - 0.5, 0.7, 1.1, "white", { ...B, round: 0.25, name: "mattress" });
    add(c, bd / 2 + 1.7, bw + 0.05, bd - 3.4, 0.25, 1.75, "accent", { ...B, round: 0.1, name: "duvet" });
    add(c, bd - 0.6, bw + 0.15, 1.3, 0.14, 1.98, "throw", { ...B, round: 0.06, name: "throw" });
    add(c - bw / 4, 1.4, bw / 2 - 0.4, 1.2, 0.45, 1.8, "soft", { ...B, round: 0.2, name: "pillow" });
    add(c + bw / 4, 1.4, bw / 2 - 0.4, 1.2, 0.45, 1.8, "soft", { ...B, round: 0.2, name: "pillow" });
    add(c, 2.0, bw / 2.4, 0.9, 0.4, 1.85, "accent2", { ...B, round: 0.18, name: "cushion" });
    add(c, 0.05, Math.min(4, bw - 1), 0.08, 2.2, 5.2, "art", { wall: true, item: "art", name: "art", cluster: "bed" });
    const ns = bw / 2 + 1.2;
    for (const [side, key] of [[-1, "ns1"], [1, "ns2"]]) {
      const u = c + side * ns;
      if (u - 0.8 <= 0 || u + 0.8 >= U) continue;
      add(u, 1, 1.6, 1.5, 2, 0, "wood", { item: key, collide: true, name: "nightstand", cluster: "bed" });
      add(u, 1, 0.7, 0.7, 0.9, 2, "glow", { item: key, round: 0.2, name: "lamp", cluster: "bed" });
    }
    add(c, bd / 2 + 1.6, bw + 3, bd + 1, 0.04, 0, "rug", { item: "rug", name: "rug", cluster: "bed" });
    if (V > 11) add(1, bd + 3.8, 1.8, 4, 3, 0, "wood", { item: "dresser", collide: true, name: "dresser" });
    if (V > 12 && U > 9) plant(U - 1.1, V - 3.4);
  } else if (t === "bathroom") {
    add(c, 1.45, U - 0.4, 2.6, 1.8, 0, "white", { item: "tub", round: 0.3, collide: true, name: "tub" });
    add(U - 1.1, 3.9, 1.5, 0.7, 2.6, 0, "white", { item: "toilet", round: 0.15, collide: true, name: "toilet tank" });
    add(U - 1.1, 4.9, 1.2, 1.6, 1.3, 0, "white", { item: "toilet", round: 0.3, name: "toilet" });
    add(1, 7.6, 1.8, 3.2, 2.8, 0, "wood", { item: "vanity", collide: true, name: "vanity" });
    add(1, 7.6, 1.9, 3.3, 0.12, 2.8, "stone", { item: "vanity", name: "counter" });
    add(c, 3.6, Math.min(2.6, U - 2.4), 1.6, 0.05, 0, "rug", { item: "mat", name: "bath mat" });
    add(c, 0.06, Math.min(2, U - 1), 0.1, 1.5, 3.4, "accent", { wall: true, item: "towel", round: 0.04, name: "towel" });
  } else if (t === "office") {
    add(c, 1.2, Math.min(4.8, U - 1), 2.2, 2.5, 0, "wood", { item: "desk", collide: true, name: "desk" });
    add(c + 1.2, 0.9, 0.3, 0.3, 1.2, 2.5, "glow", { item: "desk", name: "desk lamp" });
    add(c - 0.8, 0.8, 1.6, 0.15, 1, 2.5, "dark", { item: "desk", name: "monitor" });
    add(c, 3.4, 1.8, 1.8, 1.5, 0, "accent3", { item: "chair", round: 0.2, name: "chair" });
    add(c, 4.25, 1.8, 0.25, 1.6, 1.5, "accent3", { item: "chair", round: 0.1, name: "chair back" });
    add(0.75, 8.5, 1.3, 4.5, 6.5, 0, "white", { item: "shelf", collide: true, name: "bookshelf" });
    for (const [i, col] of ["books", "accent2", "accent", "accent3"].entries()) add(0.75, 6.9 + i * 1.05, 1.0, 0.8, 0.9, 1.4 + (i % 2) * 2.4, col, { item: "shelf", name: "books" });
    add(c + 0.6, 6.5, U - 2.4, 5, 0.04, 0, "rug", { item: "rug", name: "rug" });
    if (V > 9 && U > 8) plant(U - 1.1, V - 1.3);
  } else if (t === "kitchen") {
    add((U - 3.3) / 2, 1.15, U - 3.3, 2.3, 3, 0, "white", { item: "counters", collide: true, name: "counters" });
    add((U - 3.3) / 2, 1.15, U - 3.3, 2.4, 0.15, 3, "stone", { item: "counters", name: "countertop" });
    add((U - 3.3) / 2, 0.05, U - 3.4, 0.08, 1.6, 3.15, "accent2", { wall: true, item: "counters", name: "backsplash" });
    add(U - 1.6, 1.4, 3, 2.7, 6.6, 0, "metal", { item: "fridge", collide: true, name: "fridge" });
    add(1.15, 6, 2.3, 6, 3, 0, "white", { item: "side counter", collide: true, name: "side counter" });
    add(1.15, 6, 2.4, 6, 0.15, 3, "stone", { item: "side counter", name: "countertop" });
    add(c + 1, 8, 6, 3, 3, 0, "wood", { item: "island", collide: true, name: "island" });
    add(c + 1, 8, 6.4, 3.4, 0.15, 3, "stone", { item: "island", name: "island top" });
    add(c + 2.2, 8, 0.9, 0.9, 0.35, 3.15, "accent3", { item: "island", round: 0.3, name: "fruit bowl" });
    for (const [i, du] of [-1.9, 0, 1.9].entries()) add(c + 1 + du, 10.3, 1.3, 1.3, 2.4, 0, "dark", { item: `stool${i}`, round: 0.2, name: "stool" });
    add(c + 1, 8, 0.6, 0.6, 0.6, 6.4, "glow", { item: "island", name: "pendant" });
  } else if (t === "dining") {
    const tv = V / 2 - 0.5, len = Math.min(7, V - 7), T = { item: "table" };
    add(c, tv, 3.6, len, 2.5, 0, "wood", { ...T, collide: true, name: "table" });
    add(c, tv, 0.8, 0.8, 0.9, 2.5, "accent2", { ...T, round: 0.3, name: "vase" });
    for (const dv of [-len / 3, len / 3, 0]) {
      add(c - 2.5, tv + dv, 1.5, 1.5, 1.5, 0, "soft", { ...T, round: 0.15, name: "chair" });
      add(c - 3.15, tv + dv, 0.2, 1.5, 1.6, 1.5, "soft", { ...T, name: "chair back" });
      add(c + 2.5, tv + dv, 1.5, 1.5, 1.5, 0, "soft", { ...T, round: 0.15, name: "chair" });
      add(c + 3.15, tv + dv, 0.2, 1.5, 1.6, 1.5, "soft", { ...T, name: "chair back" });
    }
    add(c, tv, 2.2, 0.5, 0.5, 6.3, "glow", { ...T, name: "pendant" });
    add(c, tv, U - 1.2, len + 4, 0.04, 0, "rug", { item: "rug", name: "rug" });
    add(c, 0.05, Math.min(4.5, U - 2), 0.08, 2.6, 4.6, "art", { wall: true, item: "art", name: "art" });
  } else if (t === "living") {
    // media wall at the back; seating clustered off-centre so the door-to-door path stays open
    const side = r.w > r.h ? c * 0.55 : c, S = { item: "sofa" };
    add(side, 0.9, 6, 1.6, 2, 0, "dark", { item: "media", collide: true, name: "media console" });
    add(side, 0.35, 5.4, 0.15, 3, 3, "dark", { item: "media", name: "tv" });
    add(side, 4.4, 4.2, 2.2, 1.3, 0, "wood", { item: "coffee", collide: true, name: "coffee table" });
    add(side - 0.8, 4.4, 1.3, 0.9, 0.35, 1.3, "books", { item: "coffee", name: "books" });
    add(side, 7.6, 7.5, 3, 1.6, 0, "fabric", { ...S, round: 0.35, collide: true, name: "sofa" });
    add(side, 8.75, 7.5, 0.7, 1.6, 1.6, "fabric", { ...S, round: 0.3, name: "sofa back" });
    add(side - 4.1, 7.6, 0.7, 3, 2.2, 0, "fabric", { ...S, round: 0.3, name: "arm" });
    add(side + 4.1, 7.6, 0.7, 3, 2.2, 0, "fabric", { ...S, round: 0.3, name: "arm" });
    add(side - 2.4, 8.2, 1.5, 0.5, 1.3, 1.6, "accent2", { ...S, round: 0.2, name: "cushion" });
    add(side + 2.4, 8.2, 1.5, 0.5, 1.3, 1.6, "accent3", { ...S, round: 0.2, name: "cushion" });
    add(side, 4.6, 10.5, 8.6, 0.04, 0, "rug", { item: "rug", name: "rug" });
    if (V > 16) {
      // reading corner on the far side of the door-to-door path
      add(side, V - 3.2, 2.8, 2.8, 1.6, 0, "accent2", { item: "armchair", round: 0.4, collide: true, name: "armchair" });
      add(side + 2.6, V - 2.2, 1.4, 1.4, 1.8, 0, "wood", { item: "side table", name: "side table" });
      add(side - 2.4, V - 1.6, 1, 1, 5, 0, "wood", { item: "floor lamp", name: "floor lamp" });
      add(side - 2.4, V - 1.6, 1.3, 1.3, 1, 5, "glow", { item: "floor lamp", round: 0.3, name: "shade" });
    }
    plant(U - 1.2, 1.2);
  } else if (t === "laundry") {
    const lw = Math.min(2.3, U - 0.5);
    add(c, 1.4, lw, 2.4, 3.2, 0, "white", { item: "washer", round: 0.15, collide: true, name: "washer" });
    add(c, 3.9, lw, 2.4, 3.2, 0, "white", { item: "dryer", round: 0.15, collide: true, name: "dryer" });
    add(c, 6.7, lw, 2.6, 6.5, 0, "wood", { item: "shelving", collide: true, name: "shelving" });
    add(c, 6.7, Math.min(1.6, lw), 1.4, 1, 3.3, "accent", { item: "shelving", round: 0.2, name: "basket" });
  } else if (t === "closet") {
    add(c, 0.9, U - 0.6, 1.7, 7, 0, "wood", { item: "shelves", collide: true, name: "closet shelving" });
    add(c, 1.0, U - 1.4, 1.3, 2.6, 3.4, "fabric", { item: "shelves", name: "hanging clothes" });
  } else if (t === "hall") {
    add(c, V / 2, Math.min(2.6, U - 1), V - 6, 0.04, 0, "rug", { item: "runner", name: "runner" });
  }
  return P;
}

// Returns { group, byRoom: {roomId: Group (positioned at room centre)}, pieces, boxes, count, items }.
// opts.items: wrap each furniture item (a bed with its bedding, a sofa with its cushions...) in its own
//   Group so it can be dragged as one piece; byRoom[id].children are then item groups, not meshes.
// opts.arrangement: output of a previous furniture.getArrangement() — items the user moved keep their
//   spot (and room) when the house is rebuilt after an edit, as long as that room still exists.
export function buildFurniture(layout = LAYOUT, style = FURNITURE_STYLES.neutral, { roundedBox, items: grouped = false, arrangement = null } = {}) {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const ox = -W / 2, oz = -D / 2;
  const group = new THREE.Group(); group.name = "furniture";
  const mats = {};
  const colorOf = (k, r) => style.perRoom?.[r.id]?.[k] ?? style.perType?.[r.type]?.[k] ?? style[k]
    ?? (COLOR_FALLBACK[k] && (style.perRoom?.[r.id]?.[COLOR_FALLBACK[k]] ?? style.perType?.[r.type]?.[COLOR_FALLBACK[k]] ?? style[COLOR_FALLBACK[k]]))
    ?? COLOR_DEFAULTS[k] ?? 0xcccccc;
  const mat = (k, r) => {
    const col = k === "glow" ? (style.glow ?? 0xfff1d6) : colorOf(k, r), key = `${k}|${col}`;
    return mats[key] ??= k === "glow"
      ? new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.2 })
      : new THREE.MeshStandardMaterial({ color: col, roughness: k === "metal" ? 0.35 : k === "stone" ? 0.45 : k === "leaf" ? 0.7 : 0.8, metalness: k === "metal" ? 0.5 : 0 });
  };
  // keep `mats.<key>` lookups (wood, glow...) working for code that tweaks shared materials
  const byRoom = {}, pieces = [], boxes = [], itemList = [];
  for (const r of layout.rooms) {
    const f = roomFrame(r, layout);
    const rg = new THREE.Group(); rg.name = `furniture:${r.id}`;
    const cx = ox + r.x + r.w / 2, cz = oz + r.y + r.h / 2;
    rg.position.set(cx, 0, cz);
    const itemGroups = {};
    const raw = piecesFor(r, f.U, f.V);
    // slide each group (a bed with its nightstands, art and rug moves together) along its wall to clear
    // door swings before anything gets dropped
    const zoneHit = (p, u) => p.h > 0.1 && !(p.wall && p.y0 > 4) && f.doorsUV.some((d) => d.along
      ? Math.abs(u - d.u) < p.w / 2 + d.w / 2 + 0.5 && Math.abs(p.v - d.v) < p.d / 2 + 4
      : Math.abs(p.v - d.v) < p.d / 2 + d.w / 2 + 0.5 && Math.abs(u - d.u) < p.w / 2 + 4);
    const clusters = new Map();
    for (const p of raw) { const k = p.cluster ?? p.item; if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(p); }
    for (const ps of clusters.values()) {
      const cost = (sh) => ps.reduce((a, p) => {
        const u = p.u + sh, out = u - p.w / 2 < 0.2 || u + p.w / 2 > f.U - 0.2;
        return a + ((out || zoneHit(p, u)) ? (p.collide ? 3 : 1) : 0);
      }, 0);
      let best = 0, bestCost = cost(0);
      if (bestCost > 0) for (const sh of [0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.5, -2.5, 3, -3, 4, -4]) {
        const c = cost(sh); if (c < bestCost) { best = sh; bestCost = c; if (!c) break; }
      }
      if (best) for (const p of ps) p.u += best;
    }
    for (const p of raw) {
      // keep inside the room (clamp off the wall faces; drop if it can't fit at all)
      const mg = p.wall ? 0.17 : 0.2;
      if (p.w > f.U - 2 * mg || p.d > f.V - 2 * mg) continue;
      p.u = Math.min(Math.max(p.u, p.w / 2 + mg), f.U - p.w / 2 - mg);
      p.v = Math.min(Math.max(p.v, p.d / 2 + mg), f.V - p.d / 2 - mg);
      // keep door swing zones clear (4 ft deep, door width + 1 ft); wall-hung pieces above 4 ft are fine
      if (p.h > 0.1 && !(p.wall && p.y0 > 4) && f.doorsUV.some((d) => d.along
        ? Math.abs(p.u - d.u) < p.w / 2 + d.w / 2 + 0.5 && Math.abs(p.v - d.v) < p.d / 2 + 4
        : Math.abs(p.v - d.v) < p.d / 2 + d.w / 2 + 0.5 && Math.abs(p.u - d.u) < p.w / 2 + 4)) continue;
      // wall-hung pieces need solid wall behind them: skip if a window on the back wall overlaps
      if (p.wall && layout.windows.some((w) => w.room === r.id && w.wall === f.back
        && p.u + p.w / 2 > w.offset_ft - 0.3 && p.u - p.w / 2 < w.offset_ft + w.width_ft + 0.3)) continue;
      const [px, py] = f.toPlan(p.u, p.v);
      const sx = f.ns ? p.w : p.d, sz = f.ns ? p.d : p.w;
      const geo = p.round && roundedBox ? new roundedBox(sx, p.h, sz, 3, Math.min(p.round, p.h / 2, sx / 2, sz / 2)) : new THREE.BoxGeometry(sx, p.h, sz);
      geo.translate(0, p.h / 2, 0);
      const m = new THREE.Mesh(geo, mat(p.col, r));
      m.castShadow = p.h > 0.1; m.receiveShadow = true;
      m.userData = { kind: "furniture", roomId: r.id, name: p.name, item: p.item, colorKey: p.col };
      pieces.push(m);
      const wx = ox + px - cx, wz = oz + py - cz;
      if (grouped) {
        let ig = itemGroups[p.item];
        if (!ig) {
          ig = itemGroups[p.item] = new THREE.Group();
          ig.position.set(wx, 0, wz);
          ig.userData = { kind: "item", roomId: r.id, homeRoom: r.id, name: p.name, item: p.item, collide: false, wall: !!p.wall, homePos: [wx, wz] };
          rg.add(ig); itemList.push(ig);
        }
        if (p.collide) ig.userData.collide = true;
        m.position.set(wx - ig.position.x, p.y0, wz - ig.position.z);
        ig.add(m);
      } else {
        m.position.set(wx, p.y0, wz);
        rg.add(m);
      }
      if (p.collide) boxes.push({ minX: ox + px - sx / 2, maxX: ox + px + sx / 2, minZ: oz + py - sz / 2, maxZ: oz + py + sz / 2 });
    }
    byRoom[r.id] = rg; group.add(rg);
  }
  for (const [key, m] of Object.entries(mats)) { const k0 = key.split("|")[0]; mats[k0] ??= m; }
  // restore user-moved items (house-space position + rotation), possibly into a different room
  if (grouped && arrangement?.length) {
    for (const a of arrangement) {
      const ig = itemList.find((g) => g.userData.homeRoom === a.home && g.userData.item === a.item); if (!ig) continue;
      const rg = byRoom[a.room]; if (!rg) continue;
      const rr = layout.rooms.find((q) => q.id === a.room), hx = ox + rr.x, hz = oz + rr.y;
      // keep it inside the (possibly resized) room
      const x = Math.min(Math.max(a.x, hx + 0.5), hx + rr.w - 0.5), z = Math.min(Math.max(a.z, hz + 0.5), hz + rr.h - 0.5);
      rg.add(ig); ig.position.set(x - rg.position.x, 0, z - rg.position.z); ig.rotation.y = a.rot; ig.userData.roomId = a.room;
    }
  }
  const api = { group, byRoom, pieces, boxes, count: pieces.length, materials: mats, items: itemList };
  // items the user has moved: [{ home, item, room, x, z, rot }] in house space; pass back via opts.arrangement
  api.getArrangement = () => itemList.filter((g) => g.parent).map((g) => {
    const p = g.position.clone().add(g.parent.position);
    const moved = g.userData.roomId !== g.userData.homeRoom || Math.abs(g.rotation.y) > 0.01
      || Math.hypot(g.position.x - g.userData.homePos[0], g.position.z - g.userData.homePos[1]) > 0.05;
    return moved ? { home: g.userData.homeRoom, item: g.userData.item, room: g.userData.roomId, x: p.x, z: p.z, rot: g.rotation.y } : null;
  }).filter(Boolean);
  // collision boxes in house space from the current item transforms (call after dragging)
  api.recomputeBoxes = () => {
    if (!grouped) return boxes;
    boxes.length = 0;
    group.updateMatrixWorld(true);
    const inv = group.matrixWorld.clone().invert(), bb = new THREE.Box3(), tmp = new THREE.Box3(), mtx = new THREE.Matrix4();
    for (const ig of itemList) {
      if (!ig.userData.collide || !ig.parent) continue;
      bb.makeEmpty();
      ig.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); tmp.copy(o.geometry.boundingBox).applyMatrix4(mtx.multiplyMatrices(inv, o.matrixWorld)); bb.union(tmp); } });
      boxes.push({ minX: bb.min.x, maxX: bb.max.x, minZ: bb.min.z, maxZ: bb.max.z });
    }
    return boxes;
  };
  return api;
}

// ---------- edits (mock of /api/edit: only the named room and its row neighbours change) ----------
// "make the kitchen bigger" / "make bedroom 2 smaller" -> grows/shrinks that room 2 ft along its row,
// taking the space from the largest other room in the row. Returns { layout, changed, note } or null.
export function editLayout(layout, instruction) {
  const s = instruction.toLowerCase();
  const byLen = [...layout.rooms].sort((a, b) => b.name.length - a.name.length);
  // exact name / id first ("bedroom 3"), then fall back to room type ("the bedroom")
  const room = byLen.find((r) => s.includes(r.name.toLowerCase()) || s.includes(r.id.replace("_", " ")))
    ?? byLen.find((r) => s.includes(r.type.replace("_", " ")));
  const sign = /bigger|larger|wider|grow|more space|longer/.test(s) ? 1 : /smaller|narrower|shrink|less|shorter/.test(s) ? -1 : 0;
  if (!room || !sign) return null;
  // try the room's row (rooms sharing y/h, grow along x), then its column (sharing x/w, grow along y)
  for (const ax of [{ pos: "x", size: "w", cross: "y", csize: "h" }, { pos: "y", size: "h", cross: "x", csize: "w" }]) {
    const L = JSON.parse(JSON.stringify(layout));
    const me = L.rooms.find((q) => q.id === room.id);
    const row = L.rooms.filter((r) => r[ax.cross] === me[ax.cross] && r[ax.csize] === me[ax.csize] && r.type !== "hall").sort((a, b) => a[ax.pos] - b[ax.pos]);
    if (row.length < 2) continue;
    const i = row.indexOf(me);
    // donors must stay usable (>= 6 ft) and within 10% of their own target size (the sizes rule)
    const ok = (r) => r && (sign < 0 || (r[ax.size] - 2 >= 6 && (r[ax.size] - 2) * r[ax.csize] >= 0.9 * (r.target_sqft || 0)));
    const bySize = (a, b) => b.w * b.h - a.w * a.h;
    const others = row.filter((r) => r !== me);
    const donor = [row[i - 1], row[i + 1]].filter(ok).sort(bySize)[0] ?? others.filter(ok).sort(bySize)[0] ?? others.sort(bySize)[0];
    if (!donor) continue;
    const d = 2 * sign, j = row.indexOf(donor), P = ax.pos === "x" ? "x" : "y";
    const shift = (r, dv) => { r[ax.pos] += dv; for (const door of L.doors) if (door.between.includes(r.id) && !door.between.includes("exterior")) door[P] += dv; };
    me[ax.size] += d;
    if (j > i) { for (let q = i + 1; q < j; q++) shift(row[q], d); donor[ax.pos] += d; donor[ax.size] -= d; }
    else { me[ax.pos] -= d; for (let q = j + 1; q < i; q++) shift(row[q], -d); donor[ax.size] -= d; }
    // keep doors on their walls and inside their rooms
    for (const door of L.doors) for (const id of door.between) {
      const r = L.rooms.find((q) => q.id === id); if (!r || r.type === "hall") continue;
      if (Math.abs(door.y - r.y) < 0.01 || Math.abs(door.y - r.y - r.h) < 0.01) door.x = Math.min(Math.max(door.x, r.x + 2), r.x + r.w - 2);
      if (Math.abs(door.x - r.x) < 0.01 || Math.abs(door.x - r.x - r.w) < 0.01) door.y = Math.min(Math.max(door.y, r.y + 2), r.y + r.h - 2);
    }
    for (const w of L.windows) { const r = L.rooms.find((q) => q.id === w.room); w.offset_ft = Math.min(w.offset_ft, Math.max(0.5, (w.wall === "north" || w.wall === "south" ? r.w : r.h) - w.width_ft - 0.5)); }
    const changed = [...new Set([me.id, donor.id, ...row.slice(Math.min(i, j), Math.max(i, j) + 1).map((r) => r.id)])];
    return { layout: L, changed, note: `${me.name} is now ${fmtFt(me.w)} × ${fmtFt(me.h)} (${sqft(me)} sq ft); ${donor.name} gave up ${Math.abs(d * donor[ax.csize])} sq ft. ${changed.length > 2 ? `${changed.length - 2} room${changed.length > 3 ? "s" : ""} in between slid over; the` : "The"} rest of the house stayed put.` };
  }
  return null;
}
