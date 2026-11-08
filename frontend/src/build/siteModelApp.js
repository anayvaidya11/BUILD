import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { DEFAULT_PROMPT, DEFAULT_PLAN, PHASES, RULES, lockupHTML, buildHouse, buildScript, playScript, generate, FURNITURE_STYLES,
  tween, tickTweens, ease, createWalker, planSVG, sqft, fmtFt, roomById, buildFurniture, editLayout,
  planFromResponse, parsePrompt, ruleLabel } from "./core.js";
import { enhanceRenderer, fitSun, createComposer } from "./render.js";
import { createFurnitureDrag } from "./interact.js";
import { addSiteButton } from "./site.js";
import { addPhotorealButton } from "./photoreal.js";
import { createFloatingIsland, createCloudSea, attachParallax, createMist, cameraDive, createMiniStage, roomDiorama } from "./atmosphere.js";


// build — Site model app (design 2), running on the real planner API.
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
let mounted = false;
export function mountSiteModel() {
  if (mounted) return; // React StrictMode mounts effects twice in dev; the scene is a page singleton
  mounted = true;
let KEEP_ARRANGEMENT = null; // furniture the user dragged, carried across edit rebuilds
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s) => document.querySelector(s);
const setState = (s) => (document.body.dataset.state = s);
$("#logo").innerHTML = lockupHTML({ size: 26 });
$("#prompt").value = DEFAULT_PROMPT;

const EXAMPLES = ["2 bed cottage with a big kitchen, 1,100 sq ft", "4 bed family home with a mudroom", "Studio with a home office, 650 sq ft"];
$("#chips").innerHTML = EXAMPLES.map((e) => `<button type="button" class="chip">${e}</button>`).join("");
$("#chips").addEventListener("click", (e) => { if (e.target.matches(".chip")) { $("#prompt").value = e.target.textContent; $("#prompt").focus(); } });

// ---------- scene ----------
const canvas = $("#gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const PAPER = 0xf6f5f1;
// sky: pale blue overhead fading to paper at the horizon (screen-space gradient)
function skyTexture() {
  const c = document.createElement("canvas"); c.width = 2; c.height = 512;
  const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, "#c6daf0"); gr.addColorStop(0.42, "#dde8f3"); gr.addColorStop(0.78, "#eef1f2"); gr.addColorStop(1, "#F6F5F1");
  g.fillStyle = gr; g.fillRect(0, 0, 2, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
scene.background = skyTexture();
// properly rendered miniature: filmic tone mapping, studio environment light, soft shadows
enhanceRenderer(renderer, scene, { exposure: 0.98, envIntensity: 0.38 });
scene.fog = new THREE.Fog(0xe7edf3, 250, 560);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 900);

const hemi = new THREE.HemisphereLight(0xffffff, 0xcfc6b6, 0.7); scene.add(hemi);
const SUN = 2.9;
const sun = new THREE.DirectionalLight(0xfff6ea, SUN);
sun.position.set(-34, 88, 30);
fitSun(sun, DEFAULT_PLAN.layout.footprint.width_ft, DEFAULT_PLAN.layout.footprint.depth_ft, { radius: 5 });
sun.shadow.camera.near = 10; sun.shadow.camera.far = 220; sun.shadow.camera.updateProjectionMatrix();
scene.add(sun);
// GTAO contact shadows are opt-in (?ao=1): the pass darkens the sky gradient and the sprite clouds,
// which have no depth, so the airy look is kept with soft sun shadows + environment light instead.
let post = null;
const AO = new URLSearchParams(location.search).get("ao") === "1";
if (AO && !reduce && innerWidth >= 860) createComposer(renderer, scene, camera, { ao: true }).then((c) => { post = c; post.setSize(innerWidth, innerHeight); }).catch(() => {});

// ---------- the diorama: a floating island in a cloud sea ----------
// `world` holds island + house + furniture so the whole model tilts toward the pointer together.
const world = new THREE.Group(); scene.add(world);
const NARROW = innerWidth < 860, CL = NARROW ? 0.55 : 1;
let island = null;
const ISLAND_LOOK = {
  seed: 4, trees: 10,
  grass: 0xb3cd96, grassEdge: 0x98b77c, dirt: 0xcdb592, rock: 0xb4a593, rockDark: 0x8f8273,
  path: 0xfbfaf7, trunk: 0xb39270, leaf: [0x8fb879, 0xa5c78a, 0x7aa766], shard: 0xfbfaf7,
};
// the island is sized to each generated footprint, so it is rebuilt with the house
function mountIsland(L) {
  const { width_ft: W, depth_ft: D } = L.footprint;
  if (island) { world.remove(island.group); island.group.traverse((n) => n.geometry?.dispose()); }
  island = createFloatingIsland(W, D, { ...ISLAND_LOOK, entrance: [L.entrance.x - W / 2, L.entrance.y - D / 2] });
  island.group.position.y = -0.62; // grass sits just under the floor boards
  island.group.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  // keep trees clear of the walls so they never hide rooms, and a touch smaller (model-scale trees)
  for (const t of [...island.parts.props.children]) {
    if (Math.abs(t.position.x) < W / 2 + 7 && Math.abs(t.position.z) < D / 2 + 7) { island.parts.props.remove(t); continue; }
    if (t.userData.sway !== undefined) t.scale.setScalar(0.72);
  }
  world.add(island.group);
  fitSun(sun, W, D, { radius: 5 }); sun.shadow.camera.near = 10; sun.shadow.camera.far = 220; sun.shadow.camera.updateProjectionMatrix();
}

// clouds: a deep sea below, a loose ring at the island's base, a layer overhead that the camera
// passes through on the way in, and a dense veil only used during that dive
const below = createCloudSea({ count: Math.round(150 * CL), radius: 280, inner: 0, yMin: -118, yMax: -52, size: [36, 84], shadow: 0xc3d3e5, opacity: 0.95, seed: 3, drift: 1 });
const ring = createCloudSea({ count: Math.round(56 * CL), radius: 260, inner: 82, yMin: -46, yMax: -20, size: [22, 46], shadow: 0xcfdcea, opacity: 0.85, seed: 7 });
const above = createCloudSea({ count: Math.round(46 * CL), radius: 240, inner: 64, yMin: 74, yMax: 124, size: [30, 70], shadow: 0xd8e2ee, opacity: 0.78, seed: 13 });
const veil = createCloudSea({ count: 30, radius: 24, yMin: -8, yMax: 10, size: [16, 34], shadow: 0xd4dfeb, opacity: 0.96, seed: 17 });
veil.group.visible = false;
[below, ring, above, veil].forEach((c) => scene.add(c.group));
const clouds = [below, ring, above, veil];
// pointer tilt + idle sway, blended by state (full on landing, gentle on the result, off while dragging/walking)
const tiltProxy = new THREE.Object3D();
const tilt = attachParallax(tiltProxy, { yaw: 0.22, pitch: 0.07, sway: 0.09, swaySpeed: 0.45 });
let tiltW = 0, dragging = false, diving = false, aboveO = 1;
const mist = createMist(document.body, { color: "#fbfcfd", tint: "#e2ebf4", z: 40 });

// ---------- house (rebuildable: edits swap in a new layout) ----------
const FLOOR = { living: 0xe7d8bd, kitchen: 0xe2dfd7, dining: 0xe6d4b6, bedroom: 0xecdfc8, primary_bedroom: 0xe9d7ba, bathroom: 0xd9e2e5, office: 0xe0d1b6, laundry: 0xdde1da, hall: 0xf0e9db, entry: 0xf0e9db, closet: 0xe6e1d6 };
// coloured furniture: the core's lived-in palette with logo blue kept as the model's accent
const STYLE = FURNITURE_STYLES.colorful;
const edgeMat = new THREE.LineBasicMaterial({ color: 0xc8c4bb });
const pieceEdgeMat = new THREE.LineBasicMaterial({ color: 0xb9b3a8 });
let plan = DEFAULT_PLAN, layout = plan.layout, house, furn, walker, glassMat, roomLights = [], furnDrag = null;
const disposeTree = (o) => o.traverse((n) => { n.geometry?.dispose(); });
function mountHouse(L) {
  if (house) { world.remove(house.group); disposeTree(house.group); }
  if (furn) { world.remove(furn.group); disposeTree(furn.group); }
  layout = L;
  house = buildHouse(L, { floorColor: (r) => FLOOR[r.type] ?? 0xe9e6df, wallColor: 0xfbfaf7, frameColor: 0xf1ede5, glassColor: 0xbcd3ea, ceilingColor: 0xf7f4ee });
  world.add(house.group);
  for (const w of house.walls) w.add(new THREE.LineSegments(new THREE.EdgesGeometry(w.geometry), edgeMat));
  for (const f of Object.values(house.floors)) f.userData.base = f.material.color.getHex();
  glassMat = house.windows[0]?.material;
  furn = buildFurniture(L, STYLE, { roundedBox: RoundedBoxGeometry, items: true, arrangement: KEEP_ARRANGEMENT }); KEEP_ARRANGEMENT = null;
  for (const it of furn.items) it.userData.home = it.position.clone();
  world.add(furn.group);
  if (furnDrag) furnDrag.setTarget(furn, L);
  // warm room lights, only on during the walkthrough
  roomLights = L.rooms.map((r) => {
    const l = new THREE.PointLight(0xffd6a0, 0, Math.max(r.w, r.h) + 10, 1.2);
    l.position.copy(house.roomCenter(r.id)).setY(7.2); house.group.add(l); return l;
  });
  walker?.dispose();
  walker = createWalker(camera, canvas, L, { extraBoxes: furn.boxes });
}
function resetHouse() {
  for (const f of Object.values(house.floors)) { f.visible = false; f.position.y = 0; f.rotation.set(0, 0, 0); }
  for (const w of house.walls) { w.visible = false; w.scale.y = 0.001; }
  for (const w of house.windows) w.visible = false;
  if (glassMat) glassMat.opacity = 0;
  for (const d of house.doorFrames) { d.visible = false; }
  for (const g of Object.values(furn.byRoom)) { g.visible = false; g.position.y = 0; }
  if (furnDrag) furnDrag.enabled = false;
}
const T = (ms) => (reduce ? 1 : ms);

// loose foam-board offcuts drifting around the island
const loose = [];
const boardMat = new THREE.MeshStandardMaterial({ color: 0xfbfaf7, roughness: 0.9 });
const woodMat = new THREE.MeshStandardMaterial({ color: 0xe2cfae, roughness: 0.8 });
[[14, 9, 0.4, boardMat], [18, 6, 0.4, boardMat], [9, 9, 0.25, woodMat], [6, 16, 0.4, boardMat], [10, 4, 0.25, woodMat], [12, 1.2, 0.4, boardMat]].forEach(([w, d, h, m], i) => {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.castShadow = true;
  b.add(new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry), edgeMat));
  b.userData.orbit = { a: i * 1.07 + 0.4, d: 50 + (i % 3) * 7, y: [6, -10, 14, -4, -16, 9][i], sp: 0.05 + (i % 4) * 0.012, tum: 0.1 + i * 0.03, on: true };
  world.add(b); loose.push(b);
});
function orbitLoose(dt, t) {
  for (const b of loose) {
    const o = b.userData.orbit; if (!o.on) continue;
    if (!reduce) o.a += o.sp * dt;
    b.position.set(Math.cos(o.a) * o.d, o.y + Math.sin(t * 0.7 + o.a * 3) * 1.4, Math.sin(o.a) * o.d);
    b.rotation.set(Math.sin(t * o.tum) * 0.5, o.a * 1.6, Math.cos(t * o.tum * 0.8) * 0.35);
  }
}

// blue outline pulse for a placed board
function pulse(roomId) {
  const r = roomById(roomId, layout); if (!r) return;
  const line = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(r.w, 0.3, r.h)), new THREE.LineBasicMaterial({ color: 0x2b45f5, transparent: true }));
  line.position.copy(house.roomCenter(roomId)); line.position.y = 0.2; world.add(line);
  tween(T(900), (k) => { line.scale.setScalar(1 + k * 0.08); line.material.opacity = 1 - k; }).then(() => { world.remove(line); line.geometry.dispose(); });
}

// ---------- camera rig ----------
// camera distance scales with the generated footprint (the default 3-bed is ~68 ft wide)
const houseFit = () => Math.max(0.75, Math.min(1.35, Math.hypot(layout.footprint.width_ft, layout.footprint.depth_ft) / 70));
const LANDING = { theta: 0.6, radius: 218, height: 40, spin: 0.05, ty: -38 };
const rig = { theta: LANDING.theta, radius: LANDING.radius, height: LANDING.height, spin: LANDING.spin, target: new THREE.Vector3(0, LANDING.ty, 0) };
// portrait phones: back the camera off so the whole footprint stays in frame
const zoomOut = () => (innerWidth < 860 ? Math.min(1.7, Math.max(1, 1.15 * innerHeight / innerWidth * 0.62)) : 1);
function camPose(theta, radius, height, out = new THREE.Vector3()) {
  const z = zoomOut(); return out.set(Math.sin(theta) * radius * z, height * z, Math.cos(theta) * radius * z);
}
function placeCam() { camPose(rig.theta, rig.radius, rig.height, camera.position); camera.lookAt(rig.target); }
const controls = new OrbitControls(camera, canvas);
controls.enabled = false; controls.enableDamping = true; controls.maxPolarAngle = 1.35; controls.minDistance = 30; controls.maxDistance = 170;
controls.autoRotateSpeed = 0.4;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; post?.setSize(w, h);
  const st = document.body.dataset.state;
  camera.fov = st === "walk" ? 70 : w < 860 ? 46 : 32;
  // on narrow screens the result sheet covers the bottom half: shift the model up
  if (w < 860 && st === "result") camera.setViewOffset(w, h, 0, h * 0.24, w, h);
  else if (w >= 860 && st === "result") camera.setViewOffset(w, h, 180, 0, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
new MutationObserver(resize).observe(document.body, { attributes: true, attributeFilter: ["data-state"] });
addEventListener("resize", resize);
mountIsland(layout); mountHouse(layout); resetHouse(); resize();

let last = performance.now(), clock = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; clock += dt;
  tickTweens(now);
  const st = document.body.dataset.state;
  if (!diving && (st === "landing" || st === "loading")) { if (!reduce) rig.theta += rig.spin * dt; placeCam(); }
  // atmosphere
  if (!reduce) { for (const c of clouds) c.update(dt); island?.update(dt); }
  orbitLoose(dt, clock);
  aboveO += ((st === "landing" || diving ? 1 : 0) - aboveO) * Math.min(1, dt * 1.6);
  above.setOpacity(aboveO); above.group.visible = aboveO > 0.01;
  const still = dragging || furnDrag?.dragging;
  const tw = reduce || st === "walk" ? 0 : st === "landing" ? 1 : st === "loading" ? 0.45 : still ? 0 : 0.5;
  tiltW += (tw - tiltW) * Math.min(1, dt * (still ? 6 : 2.2));
  tilt.update(dt);
  world.rotation.set(tiltProxy.rotation.x * tiltW, tiltProxy.rotation.y * tiltW, 0);
  world.position.y = st === "landing" && !reduce ? Math.sin(clock * 0.8) * 1.1 * tiltW : world.position.y * 0.9;
  if (st === "result") { controls.update(); updateTags(); furnDrag?.update(dt); }
  if (st === "walk") { walker.update(dt); updateMini(); }
  if (st === "loading") $("#timer").textContent = ((now - startedAt) / 1000).toFixed(1) + " s";
  if (post && st !== "walk") post.render(); else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- loading: the build story ----------
let startedAt = 0, run = null, script = [], fixLog = [], promptText = DEFAULT_PROMPT;
const phaseOrder = PHASES.map((p) => p.id);
$("#stepper").innerHTML = PHASES.map((p) => `<li data-id="${p.id}"><i></i><span>${p.label}</span></li>`).join("");
function setPhase(id) {
  const i = phaseOrder.indexOf(id);
  document.querySelectorAll("#stepper li").forEach((li, j) => { li.className = j < i ? "done" : j === i ? "active" : ""; });
}
let typing = 0;
function typeLine(text) {
  const el = $("#thought"); const id = ++typing; let n = 0;
  const step = () => {
    if (id !== typing) return;
    n = Math.min(text.length, n + (reduce ? text.length : 2));
    el.innerHTML = `${text.slice(0, n)}<span class="caret"></span>`;
    if (n < text.length) setTimeout(step, 16);
  };
  step();
}
function addBriefCard(r) {
  const d = document.createElement("div"); d.className = "card"; d.dataset.id = r.id;
  d.innerHTML = `<b>${r.name}</b><span>${r.target_sqft} sq ft</span>`; $("#tray").append(d);
}
function placeRoom(id, reflow) {
  const f = house.floors[id]; if (!f) return;
  const card = document.querySelector(`.card[data-id="${id}"]`); card?.classList.add("placed");
  const home = house.roomCenter(id);
  if (reflow) {
    const fx = f.userData.fromX ?? f.position.x, y0 = f.position.y;
    tween(T(900), (k) => { f.position.x = fx + (home.x - fx) * k; f.position.y = y0 * (1 - k); f.rotation.z = 0.06 * (1 - k); }, ease.spring).then(() => pulse(id));
    return;
  }
  f.visible = true;
  // boards swing in from in front of the model and settle on a spring, a touch of rotation unwinding
  const sx = home.x + (Math.random() - 0.5) * 10, sz = home.z + 14, rot = (Math.random() - 0.5) * 0.8;
  tween(T(1000), (k) => {
    f.position.set(sx + (home.x - sx) * k, 10 * (1 - Math.min(1, k)), sz + (home.z - sz) * k);
    f.rotation.y = rot * (1 - k);
  }, ease.spring).then(() => pulse(id));
}
// the newest rule chip is marked so narrow screens can show just that one
function markLatest(el) { document.querySelectorAll("#rules .latest").forEach((x) => x.classList.remove("latest")); el.classList.add("latest"); }
let ruleTotal = 7;
function updateRuleCount() {
  const done = document.querySelectorAll("#rules .rule:not(.fail)").length;
  $("#ruleCount").textContent = `${done} of ${ruleTotal} rules pass`;
}
function addCheck(e) {
  const label = ruleLabel(e.rule);
  let el = document.querySelector(`.rule[data-rule="${e.rule}"]`);
  if (!el) { el = document.createElement("div"); el.className = "rule"; el.dataset.rule = e.rule; $("#rules").append(el); }
  if (e.fixed || (!plan.response && e.round === 2)) { el.className = "rule fixed"; el.innerHTML = `<span class="ic">✓</span><div>${label}<small>Fixed in round ${e.round}</small></div>`; }
  else {
    el.className = "rule" + (e.pass ? "" : " fail");
    el.innerHTML = `<span class="ic">${e.pass ? "✓" : "!"}</span><div>${label}${e.pass ? "" : `<small>${e.message}</small>`}</div>`;
  }
  markLatest(el); updateRuleCount();
}
function doFix(e) {
  const n = document.createElement("div"); n.className = "fixnote"; n.innerHTML = `<b>Fix round ${e.round}.</b> ${e.note}`; $("#rules").append(n);
  markLatest(n);
  fixLog.push(`<li><b>Fix.</b> ${e.note}</li>`);
  typeLine(e.note);
  // lift the boards this fix touches (the reflow `place` events that follow) and nudge them apart
  const ids = script.filter((x) => x.type === "place" && x.reflow).map((x) => x.roomId);
  ids.forEach((id, i) => {
    const f = house.floors[id]; if (!f) return;
    const x0 = f.position.x, dx = (i % 2 ? 2.5 : -2.5);
    f.userData.fromX = x0 + dx;
    tween(T(650), (k) => { f.position.y = 4 * k; f.position.x = x0 + dx * k; f.rotation.z = 0.06 * k; }, ease.settle);
  });
}
function raiseWalls() {
  // walls rise room by room in plan order, each on a soft spring; stagger keeps it one wave
  const order = layout.rooms.map((r) => r.id), n = Math.max(1, order.length);
  house.walls.forEach((w) => {
    const i = Math.max(0, order.indexOf(w.userData.roomId));
    w.visible = true;
    tween(T(900), (k) => (w.scale.y = Math.max(0.001, k)), ease.spring, T((i / n) * 1500 + Math.random() * 90));
  });
  tween(T(800), (k) => { house.windows.forEach((w) => (w.visible = true)); if (glassMat) glassMat.opacity = 0.45 * k; }, ease.settle, T(1700));
  house.doorFrames.forEach((d, i) => {
    tween(T(650), (k) => { d.visible = true; d.position.y = 7 + 8 * (1 - k); }, ease.drop, T(1900 + i * 50));
  });
  // push in a little, then come closer again while the rooms get furnished
  const r0 = rig.radius, h0 = rig.height;
  tween(T(2600), (k) => { rig.radius = r0 - 10 * k; rig.height = h0 - 2 * k; }, ease.settle);
}
// pieces are set down one by one: big items first, each drops in and bounces to rest
const piecesIn = (id) => (furn.byRoom[id]?.children ?? []).reduce((a, it) => a + it.children.length, 0);
function furnishRoom(id) {
  const g = furn.byRoom[id]; if (!g) return;
  g.visible = true;
  const items = [...g.children].sort((a, b) => (b.userData.collide ? 1 : 0) - (a.userData.collide ? 1 : 0));
  items.forEach((it) => { it.visible = false; });
  items.forEach((it, i) => {
    const home = it.userData.home, dx = (Math.random() - 0.5) * 1.4, dz = (Math.random() - 0.5) * 1.4, r0 = (Math.random() - 0.5) * 0.5;
    tween(T(700), (k) => {
      it.visible = true;
      it.position.set(home.x + dx * (1 - k), 6 * (1 - k), home.z + dz * (1 - k));
      it.rotation.y = r0 * (1 - k);
      it.scale.setScalar(0.75 + 0.25 * Math.min(1, k * 1.4));
    }, ease.drop, T(i * 70)).then(() => { it.position.copy(home); it.rotation.y = 0; it.scale.setScalar(1); });
  });
  const card = document.querySelector(`.card[data-id="${id}"]`);
  const n = piecesIn(id);
  if (card && n) { card.classList.add("furnished"); card.querySelector("span").textContent = `${n} pieces`; }
}
function onEvent(e) {
  switch (e.type) {
    case "phase": setPhase(e.id); if (e.id === "furnish") { const r0 = rig.radius, h0 = rig.height; tween(T(3200), (k) => { rig.radius = r0 - 14 * k; rig.height = h0 + 8 * k; rig.spin = 0.12 - 0.06 * k; }, ease.settle); } break;
    case "thought": typeLine(e.text); break;
    case "room": addBriefCard(e.room); break;
    case "place": placeRoom(e.roomId, e.reflow); break;
    case "check": addCheck(e); if (!e.pass) fixLog.push(`<li><b>Round ${e.round ?? 1}.</b> ${ruleLabel(e.rule)}: ${e.message}</li>`); break;
    case "fix": doFix(e); break;
    case "walls": typeLine("Raising walls, cutting window openings, setting door frames."); raiseWalls(); break;
    case "furnish": furnishRoom(e.roomId); break;
    case "done": finish(e.stats); break;
  }
}

// the real planner: POST /api/generate. Falls back to the built-in offline planner if it can't be reached.
async function requestPlan(prompt) {
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 120000);
    const r = await fetch(`${API}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }), signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`generate ${r.status}`);
    return planFromResponse(prompt, await r.json());
  } catch (err) {
    console.warn("planner unreachable, using the built-in planner", err);
    const p = generate(prompt); p.offline = true; return p;
  }
}
// "reading the brief" while Claude works: real facts from the prompt, then honest progress lines
function waitingLines(prompt) {
  const p = parsePrompt(prompt), pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [
    `“${prompt}”`,
    p.beds ? `${pl(p.beds, "bedroom")}, ${pl(p.baths, "bath")}, about ${p.sqft.toLocaleString()} sq ft.` : `A studio, about ${p.sqft.toLocaleString()} sq ft.`,
    "Asking Claude for a room program: names, sizes, which rooms sit together.",
    "The solver turns that into walls, doors and windows on a 6-inch grid.",
    "Then the checker tests seven layout rules and sends any failures back.",
    "Still working — bigger houses take a little longer.",
  ];
}
let waitTimer = 0;
async function start(prompt) {
  if (diving || run) return;
  promptText = prompt;
  const pending = requestPlan(prompt); // in flight during the dive
  resetHouse(); fixLog = [];
  $("#tray").innerHTML = ""; $("#rules").innerHTML = ""; $("#thought").textContent = ""; $("#ruleCount").textContent = "";
  diving = true; document.body.classList.add("leaving");
  // the loose offcuts fly in to become the model
  loose.forEach((b, i) => {
    b.userData.orbit.on = false; const p0 = b.position.clone(), s0 = b.scale.x;
    tween(T(900), (k) => { b.position.lerpVectors(p0, new THREE.Vector3(0, 3, 0), k); b.scale.setScalar(Math.max(0.001, s0 * (1 - k))); }, ease.inOutCubic, T(i * 70)).then(() => (b.visible = false));
  });
  // dive: up through the overhead cloud layer and down onto the island, a dense veil at the midpoint,
  // and a brief white-out of mist as the camera passes through it
  const fit = houseFit();
  const end = { theta: rig.theta + 0.55, radius: 122 * fit, height: 88 * fit };
  const to = camPose(end.theta, end.radius, end.height);
  veil.group.position.copy(camera.position).lerp(to, 0.5).add(new THREE.Vector3(0, 4, 0));
  veil.group.visible = true;
  let misted = false;
  await cameraDive(camera, {
    to, look: new THREE.Vector3(0, 0, 0), ms: 2400, fovPunch: 12, roll: 0.1,
    onUpdate: (p) => { if (!misted && p > 0.34) { misted = true; mist.cover(380).then(() => mist.reveal(950)); } },
  });
  veil.group.visible = false;
  Object.assign(rig, { theta: end.theta, radius: end.radius, height: end.height, spin: 0.12 }); rig.target.set(0, 0, 0);
  diving = false; document.body.classList.remove("leaving");
  setState("loading");
  startedAt = performance.now();
  document.body.classList.add("waiting");
  setPhase("read");
  const lines = waitingLines(prompt); let li = 0;
  const nextLine = () => { typeLine(lines[Math.min(li, lines.length - 1)]); li++; waitTimer = setTimeout(nextLine, li < lines.length ? 2300 : 6000); };
  nextLine();
  plan = await pending;
  clearTimeout(waitTimer); document.body.classList.remove("waiting");
  // the island grows to the real footprint, the house is built hidden, then the story plays it in
  mountIsland(plan.layout); mountHouse(plan.layout); resetHouse();
  const g = island.group; g.scale.setScalar(0.85); tween(T(1200), (k) => g.scale.setScalar(0.85 + 0.15 * k), ease.spring);
  if (plan.offline) toast("Couldn't reach the planner, so this house comes from the built-in offline planner.");
  else if (plan.response?.cached) toast("The live planner failed, so this is a saved backup generation.");
  ruleTotal = plan.layout.checks?.length || RULES.length;
  script = buildScript(prompt, plan, { skipRead: true });
  scriptStart = performance.now();
  run = playScript(script, onEvent, { speed: reduce ? 3 : 1 });
}
let scriptStart = 0;
$("#skipBtn").addEventListener("click", () => {
  if (!run) return;
  const el = performance.now() - scriptStart; run.cancel();
  const rest = script.filter((e) => e.at > el).map((e) => ({ ...e, at: (e.at - el) / 8 }));
  rest.at(-1).at = Math.max(rest.at(-1).at, 2600);
  run = playScript(rest, onEvent);
});
$("#promptForm").addEventListener("submit", (e) => { e.preventDefault(); start($("#prompt").value.trim() || DEFAULT_PROMPT); });

// ---------- result ----------
let lastStats;
function renderPanel() {
  const s = lastStats;
  const total = layout.rooms.reduce((a, r) => a + r.w * r.h, 0);
  $("#stats").innerHTML = [[layout.rooms.length, "rooms"], [Math.round(total).toLocaleString(), "sq ft"], [`${s.rulesPassed}/${s.rules ?? 7}`, "rules pass"],
    [s.rounds, s.rounds === 1 ? "fix round" : "fix rounds"], [furn.count, "furniture pieces"], [s.seconds + " s", s.live ? "planning time" : "to build"]].map(([b, t]) => `<div><b>${b}</b><span>${t}</span></div>`).join("");
  renderRoomList();
  $("#mini").innerHTML = planSVG(layout, { pad: 1, labels: false }) + `<div class="me" id="me"></div>`;
  lastRoom = undefined;
  buildTags();
  refreshMinis();
}
function renderRoomList(changed = new Set()) {
  $("#roomList").innerHTML = layout.rooms.map((r) => { const n = piecesIn(r.id); return `<li tabindex="0" data-id="${r.id}" class="${changed.has(r.id) ? "changed" : ""}"><div><i class="sw" style="background:#${(FLOOR[r.type] ?? 0xe9e6df).toString(16).padStart(6, "0")}"></i>${r.name}</div><span>${fmtFt(r.w)} × ${fmtFt(r.h)} · ${sqft(r)} sq ft${n ? ` · ${n} pcs` : ""}</span></li>`; }).join("");
}
function titleFor(p) {
  const base = p.beds === 0 ? "studio" : `${p.beds}-bed`;
  return `Your ${base}${p.office ? " with an office" : p.mud ? " with a mudroom" : ""} is ready`;
}
function finish(stats) {
  lastStats = stats; run = null;
  setState("result");
  $("#title").textContent = titleFor(plan.parsed);
  const src = plan.offline ? " Built by the offline planner." : stats.cached ? " This is a saved backup generation." : "";
  $("#lede").textContent = `“${promptText}”. ${plan.summary.zoning}${src} Drag the model to turn it, or pick up any piece of furniture and move it.`;
  const n = stats.rules ?? 7;
  $("#fixSum").textContent = stats.rounds ? `${stats.rulesPassed} of ${n} pass after ${stats.rounds} fix round${stats.rounds === 1 ? "" : "s"}` : `${stats.rulesPassed} of ${n} passed on the first try`;
  $("#fixLog").innerHTML = fixLog.join("") + `<li><b>${stats.rounds ? `Round ${stats.rounds + 1}` : "Round 1"}.</b> All ${n} rules pass.</li>`;
  $("#editMsg").textContent = ""; $("#editMsg").className = "editmsg";
  renderPanel();
  // settle into a high three-quarter view so the furnished rooms read over the walls
  rig.target.set(0, 0, 0); controls.target.set(0, 0, 0);
  const r0 = rig.radius, h0 = rig.height, fit = houseFit();
  controls.maxDistance = 170 * fit;
  tween(T(1400), (k) => { rig.radius = r0 + (112 * fit - r0) * k; rig.height = h0 + (104 * fit - h0) * k; placeCam(); }, ease.settle)
    .then(() => { controls.enabled = true; controls.autoRotate = !reduce; controls.update(); if (furnDrag) furnDrag.enabled = true; });
}
controls.addEventListener("start", () => { controls.autoRotate = false; dragging = true; });
controls.addEventListener("end", () => { dragging = false; });

// hover highlight: the floor turns blue and gets a crisp outline, so it reads on pale boards too
let hot = null, hotLine = null;
function highlight(id) {
  hot = id;
  for (const [rid, f] of Object.entries(house.floors)) {
    f.material.color.setHex(rid === id ? 0x9fb0ff : f.userData.base);
    f.material.emissive.setHex(rid === id ? 0x2b45f5 : 0); f.material.emissiveIntensity = 0.25;
  }
  if (hotLine) { world.remove(hotLine); hotLine.geometry.dispose(); hotLine = null; }
  if (id) {
    const r = roomById(id, layout);
    // a translucent blue volume fills the room so it reads over the walls from any angle
    const box = new THREE.BoxGeometry(r.w - 0.3, 9.4, r.h - 0.3); box.translate(0, 4.7, 0);
    hotLine = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0x2b45f5, transparent: true, opacity: 0.16, depthWrite: false }));
    hotLine.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x2b45f5 })));
    hotLine.position.copy(house.roomCenter(id)); world.add(hotLine);
  }
  document.querySelectorAll(".tag").forEach((t) => t.classList.toggle("hot", t.dataset.id === id));
  document.querySelectorAll("#roomList li").forEach((li) => li.classList.toggle("hot", li.dataset.id === id));
  document.querySelectorAll("#minis .tile").forEach((t) => t.classList.toggle("hot", !!id && t.dataset.id === id));
}
["mouseover", "focusin"].forEach((ev) => $("#roomList").addEventListener(ev, (e) => { const li = e.target.closest("li"); if (li) highlight(li.dataset.id); }));
["mouseleave", "focusout"].forEach((ev) => $("#roomList").addEventListener(ev, () => highlight(null)));

// room tags floating above the model, like pins in a presentation model
const tagEls = [];
function buildTags() {
  $("#tags").innerHTML = ""; tagEls.length = 0;
  for (const r of layout.rooms) {
    if (r.type === "hall" || r.type === "laundry") continue;
    const t = document.createElement("div"); t.className = "tag"; t.dataset.id = r.id; t.textContent = r.name;
    $("#tags").append(t); tagEls.push([t, house.roomCenter(r.id).add(new THREE.Vector3(0, 11, 0))]);
  }
}
const v = new THREE.Vector3();
function updateTags() {
  const narrow = innerWidth < 860;
  for (const [t, p] of tagEls) {
    world.localToWorld(v.copy(p)).project(camera);
    const x = (v.x * 0.5 + 0.5) * innerWidth, y = (-v.y * 0.5 + 0.5) * innerHeight;
    t.style.left = x + "px"; t.style.top = y + "px";
    t.style.opacity = narrow || x > innerWidth - 390 ? 0 : 1;
  }
}

function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 4200); }

// ---------- edit by text: only the named room and its row neighbours move ----------
const touching = (w, rects) => { const s = w.userData.seg, mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2; return rects.some((r) => mx >= r.x - 0.01 && mx <= r.x + r.w + 0.01 && my >= r.y - 0.01 && my <= r.y + r.h + 0.01); };
let editing = false;
async function remoteEdit(instr) {
  if (!plan.response) return null; // offline plans edit locally
  try {
    const r = await fetch(`${API}/api/edit`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ program: plan.program, layout, instruction: instr }) });
    if (!r.ok) throw new Error(`edit ${r.status}`);
    const resp = await r.json();
    const old = new Map(layout.rooms.map((q) => [q.id, q]));
    const now = new Map(resp.layout.rooms.map((q) => [q.id, q]));
    const changed = [...new Set([...resp.layout.rooms.filter((q) => { const o = old.get(q.id); return !o || o.x !== q.x || o.y !== q.y || o.w !== q.w || o.h !== q.h; }).map((q) => q.id),
      ...[...old.keys()].filter((id) => !now.has(id))])];
    const named = changed.map((id) => now.get(id)).filter(Boolean).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const note = changed.length ? `${named ? `${named.name} is now ${fmtFt(named.w)} × ${fmtFt(named.h)} (${sqft(named)} sq ft). ` : ""}${changed.length} room${changed.length === 1 ? "" : "s"} changed; the rest of the house stayed put.` : "The planner kept the layout as it was.";
    return { layout: resp.layout, changed, note, response: resp };
  } catch (err) { console.warn("edit API failed, resizing locally", err); return null; }
}
async function applyEdit(instr) {
  const msg = $("#editMsg");
  editing = true; msg.className = "editmsg"; msg.textContent = plan.response ? "Asking the planner…" : "Rebuilding the changed rooms…";
  const remote = await remoteEdit(instr);
  editing = false;
  // the planner changed something: show it. If it kept the layout (e.g. the backend runs offline without
  // Claude), fall through to the local resize so the request still does what it says.
  if (remote?.changed.length) return animateEdit(remote);
  // core's editLayout matches a room *type* ("bedroom") before a specific name ("bedroom 3");
  // put an exactly named room first so it wins, then restore the original room order.
  const low = instr.toLowerCase();
  const exact = layout.rooms.find((r) => low.includes(r.name.toLowerCase()) || low.includes(r.id.replace("_", " ")));
  const order = layout.rooms.map((r) => r.id);
  const probe = exact ? { ...layout, rooms: [exact, ...layout.rooms.filter((r) => r !== exact)] } : layout;
  const res = editLayout(probe, instr);
  if (res) res.layout.rooms.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  if (!res) {
    msg.className = "editmsg warn";
    msg.innerHTML = `I can resize one room at a time. Try <button type="button" class="ex">Make the kitchen bigger</button> or <button type="button" class="ex">Make bedroom 2 smaller</button>.`;
    return;
  }
  return animateEdit(res);
}
async function animateEdit(res) {
  const msg = $("#editMsg");
  editing = true; highlight(null); controls.autoRotate = false; furnDrag.enabled = false;
  KEEP_ARRANGEMENT = furn?.getArrangement?.() ?? null; // moved furniture survives the edit
  msg.className = "editmsg"; msg.textContent = "Rebuilding the changed rooms…";
  const ids = new Set(res.changed);
  const oldRects = layout.rooms.filter((r) => ids.has(r.id));
  const oldWalls = house.walls.filter((w) => touching(w, oldRects));
  // 1. lift the changed boards (and their furniture) off the model, take their walls down
  await tween(T(550), (k) => {
    for (const id of ids) { if (house.floors[id]) house.floors[id].position.y = 4 * k; if (furn.byRoom[id]) furn.byRoom[id].position.y = 4 * k; }
    oldWalls.forEach((w) => (w.scale.y = Math.max(0.001, 1 - k)));
  }, ease.settle);
  // 2. swap in the edited layout with the changed rooms still lifted
  mountHouse(res.layout);
  const newRects = layout.rooms.filter((r) => ids.has(r.id));
  const newWalls = house.walls.filter((w) => touching(w, newRects));
  for (const id of ids) { if (house.floors[id]) house.floors[id].position.y = 4; if (furn.byRoom[id]) furn.byRoom[id].position.y = 4; }
  newWalls.forEach((w) => (w.scale.y = 0.001));
  if (glassMat) glassMat.opacity = 0.45;
  // 3. settle them back down
  await tween(T(850), (k) => {
    for (const id of ids) { if (house.floors[id]) house.floors[id].position.y = 4 * (1 - k); if (furn.byRoom[id]) furn.byRoom[id].position.y = 4 * (1 - k); }
    newWalls.forEach((w) => (w.scale.y = Math.max(0.001, k)));
  }, ease.drop);
  ids.forEach((id) => house.floors[id] && pulse(id));
  plan = { ...plan, layout, ...(res.response ? { program: res.response.program, response: res.response } : {}) };
  renderPanel(); renderRoomList(ids);
  msg.className = "editmsg ok"; msg.textContent = res.note;
  const chk = layout.checks ?? [], ok = chk.filter((c) => c.pass).length;
  toast(`Updated. ${ids.size} room${ids.size === 1 ? "" : "s"} changed${chk.length ? `, ${ok} of ${chk.length} rules pass` : ", all rules still pass"}.`);
  editing = false; furnDrag.enabled = document.body.dataset.state === "result";
}
$("#editForm").addEventListener("submit", (e) => {
  e.preventDefault(); if (editing) return;
  const instr = $("#editInput").value.trim() || "Make the kitchen bigger";
  $("#editInput").value = "";
  applyEdit(instr);
});
$("#editMsg").addEventListener("click", (e) => { if (e.target.matches(".ex")) { $("#editInput").value = e.target.textContent; $("#editInput").focus(); } });
$("#newBtn").addEventListener("click", async () => {
  if (diving) return;
  await mist.cover(T(600));
  controls.enabled = false; controls.autoRotate = false; highlight(null); resetHouse(); furnDrag.enabled = false;
  loose.forEach((b) => { b.visible = true; b.scale.setScalar(1); b.userData.orbit.on = true; });
  Object.assign(rig, { theta: LANDING.theta, radius: LANDING.radius, height: LANDING.height, spin: LANDING.spin }); rig.target.set(0, LANDING.ty, 0);
  setState("landing"); placeCam(); $("#prompt").focus();
  await mist.reveal(T(1000));
});

// ---------- walk: ceilings on, warm lamps on, furniture collides ----------
let saved = null;
$("#walkBtn").addEventListener("click", () => {
  saved = { pos: camera.position.clone(), q: camera.quaternion.clone() };
  controls.enabled = false; highlight(null); furnDrag.enabled = false; furn.recomputeBoxes();
  tiltW = 0; world.rotation.set(0, 0, 0); world.position.y = 0;
  house.ceilings.visible = true; roomLights.forEach((l) => (l.intensity = 6)); sun.intensity = 0.9;
  setState("walk"); walker.enter(); canvas.focus();
});
function leave() {
  if (document.body.dataset.state !== "walk") return;
  walker.exit(); camera.position.copy(saved.pos); camera.quaternion.copy(saved.q);
  house.ceilings.visible = false; roomLights.forEach((l) => (l.intensity = 0)); sun.intensity = SUN;
  controls.enabled = true; setState("result"); furnDrag.enabled = true;
}
$("#exitWalk").addEventListener("click", leave);
addEventListener("keydown", (e) => { if (e.key === "Escape") leave(); });
let lastRoom = null;
function updateMini() {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const p = walker.planPos();
  const me = $("#me");
  me.style.left = ((p.x + 1) / (W + 2)) * 100 + "%"; me.style.top = ((p.y + 1) / (D + 2)) * 100 + "%";
  me.style.transform = `rotate(${-p.heading}rad)`;
  const r = walker.roomAt();
  if (r?.id !== lastRoom) {
    lastRoom = r?.id; $("#hudRoom").textContent = r ? r.name : "Outside";
    document.querySelectorAll("#mini .p-room").forEach((el) => el.classList.toggle("here", el.dataset.id === lastRoom));
  }
}
// ---------- look inside: DOM-pinned room dioramas with a pill switcher ----------
const stage = createMiniStage({ z: 7 });
// atmosphere.js clears before any mini is added, while the GL clear colour is still opaque black;
// set a transparent clear colour up front so the empty overlay never covers the page
stage.renderer.setClearColor(0x000000, 0);
// grouped by room type, so any generated plan fills them (first three of each)
const GROUPS = [["Bedrooms", ["primary_bedroom", "bedroom"]], ["Living", ["living", "office"]],
  ["Kitchen", ["kitchen", "dining", "laundry"]], ["Baths", ["bathroom", "closet"]]];
const groupIds = (i) => GROUPS[i][1].flatMap((t) => layout.rooms.filter((r) => r.type === t).map((r) => r.id)).slice(0, 3);
let groupIdx = 0, cycle = 0;
const added = new WeakSet();
const tiles = [...document.querySelectorAll("#minis .tile")];
$("#pills").innerHTML = GROUPS.map(([n], i) => `<button type="button" class="pill" data-i="${i}" aria-pressed="${i === 0}">${n}</button>`).join("");
$("#pills").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  groupIdx = +b.dataset.i; cycle = 0;
  document.querySelectorAll(".pill").forEach((p) => p.setAttribute("aria-pressed", p === b));
  refreshMinis();
});
function diorama(id) {
  const g = roomDiorama(house, furn, id);
  // own materials so the stage's fade never touches the main model
  g.traverse((o) => { if (o.material) { o.material = o.material.clone(); if (o.material.emissive) o.material.emissive.setHex(0); } });
  const f = g.children[0]; if (f?.material && house.floors[id]) f.material.color.setHex(house.floors[id].userData.base);
  return g;
}
function refreshMinis() {
  const ids = groupIds(groupIdx).filter((id) => house.floors[id]);
  const shown = innerWidth < 860 ? [ids[cycle % ids.length]] : ids;
  tiles.forEach((tile, i) => {
    const id = shown[i]; tile.hidden = !id; if (!id) return;
    const r = roomById(id, layout); tile.dataset.id = id;
    tile.querySelector("b").textContent = r.name;
    tile.querySelector("span").textContent = `${fmtFt(r.w)} × ${fmtFt(r.h)} · ${sqft(r)} sq ft`;
    const view = tile.querySelector(".view");
    if (!added.has(view)) { stage.add(view, diorama(id), { baseYaw: 0.5 + i * 0.2 }); added.add(view); }
    else setTimeout(() => stage.swap(view, diorama(id)), reduce ? 0 : i * 80);
  });
}
tiles.forEach((tile) => {
  tile.addEventListener("pointerenter", () => tile.dataset.id && highlight(tile.dataset.id));
  tile.addEventListener("pointerleave", () => highlight(null));
  tile.addEventListener("click", () => { if (innerWidth < 860) { cycle++; refreshMinis(); } });
});

// ---------- drag & drop furniture ----------
furnDrag = createFurnitureDrag({
  camera, dom: canvas, furniture: furn, layout, controls,
  onPick: ({ item }) => { document.body.classList.add("dragging-item"); controls.autoRotate = false; highlight(null); },
  onMove: ({ roomId }) => highlight(roomId),
  onDrop: ({ item, from, to, cancelled }) => {
    document.body.classList.remove("dragging-item"); highlight(null);
    if (cancelled) return;
    const name = item.userData.name.replace(/^\w/, (c) => c.toUpperCase());
    const rn = (id) => roomById(id, layout)?.name ?? id;
    toast(from === to ? `${name} moved within ${rn(to)}` : `${name} moved to ${rn(to)}`);
    renderRoomList();
    // walk collision + the room minis for both rooms catch up once it has landed
    setTimeout(() => { furn.recomputeBoxes(); if (shownIds().some((id) => id === from || id === to)) refreshMinis(); }, 750);
  },
});
furnDrag.enabled = false;
const shownIds = () => tiles.filter((t) => !t.hidden).map((t) => t.dataset.id);

// Site view: "On site" button next to Walk through (Google 3D tiles; see core/site.js).
addSiteButton($("#walkBtn"), () => layout);
addPhotorealButton($("#walkBtn"), () => ({ layout: layout, furniture: furn })); // Blender Cycles 360° tour, renders automatically
// dev-only handle for automated checks (stripped from production builds)
if (process.env.NODE_ENV !== "production") window.__build = { THREE, camera, get furn() { return furn; }, get layout() { return layout; }, canvas };
}
