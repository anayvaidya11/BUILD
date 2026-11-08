import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { DEFAULT_PROMPT, DEFAULT_PLAN, PHASES, RULES, lockupHTML, buildHouse, buildScript, playScript, generate, FURNITURE_STYLES,
  tween, tickTweens, ease, createWalker, planSVG, sqft, fmtFt, roomById, buildFurniture, editLayout,
  planFromResponse, parsePrompt, ruleLabel, smoothDamp } from "./core.js";
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
  // dev-only: ?raf=timer drives animation with timers so automated checks run in a hidden browser pane
  if (process.env.NODE_ENV !== "production" && new URLSearchParams(location.search).get("raf") === "timer") {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  }
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

// ---------- builder agent: a small drone that flies room to room, sets each board down and furnishes it ----------
const agent = (() => {
  const g = new THREE.Group(); g.visible = false; g.name = "builder-agent";
  const shell = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x2b45f5, emissive: 0x2b45f5, emissiveIntensity: 0.6 });
  const body = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.9, 2.2, 3, 0.4), shell); body.castShadow = true;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.12, 8, 48), blue); ring.rotation.x = Math.PI / 2;
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), new THREE.MeshStandardMaterial({ color: 0x2b45f5, emissive: 0x7d93ff, emissiveIntensity: 1.6 }));
  eye.position.y = -0.4;
  const beamGeo = new THREE.ConeGeometry(3.4, 10, 32, 1, true); beamGeo.translate(0, -5, 0);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0x7d93ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  const glow = new THREE.PointLight(0x9fb0ff, 0, 34, 1.6); glow.position.y = -1;
  g.add(body, ring, eye, beam, glow);
  world.add(g);
  const pos = g.position, target = new THREE.Vector3(0, 34, 0), vx = {}, vy = {}, vz = {}, wp = new THREE.Vector3();
  const tagEl = $("#agentTag");
  let on = false, beamK = 0, beamTarget = 0;
  return {
    show() {
      if (on) return; on = true; g.visible = true; tagEl.hidden = false;
      pos.set(0, 46, 0); target.set(0, 30, 0); g.scale.setScalar(0.01);
      tween(T(500), (k) => g.scale.setScalar(Math.max(0.01, k)), ease.spring);
    },
    hide(ms = 450) {
      if (!on) return; on = false; beamTarget = 0; target.y += 18;
      tween(T(ms), (k) => g.scale.setScalar(Math.max(0.01, 1 - k)), ease.settle).then(() => { if (!on) { g.visible = false; tagEl.hidden = true; } });
    },
    goTo(roomId, height, text) { const c = house.roomCenter(roomId); target.set(c.x, height, c.z); if (text) this.say(text); },
    goAbove(height, text) { target.set(0, height, 0); if (text) this.say(text); },
    say(t) { tagEl.querySelector("span").textContent = t; },
    beam(v) { beamTarget = v; },
    // where furniture leaves the drone, in world-group coordinates
    origin() { return pos.clone().add(new THREE.Vector3(0, -1.2, 0)); },
    get on() { return on; },
    update(dt, t) {
      if (!g.visible) return;
      const st = reduce ? 0.05 : 0.42;
      pos.x = smoothDamp(pos.x, target.x, vx, st, dt);
      pos.y = smoothDamp(pos.y, target.y + Math.sin(t * 2.2) * 0.35, vy, st, dt);
      pos.z = smoothDamp(pos.z, target.z, vz, st, dt);
      ring.rotation.z += dt * 2.4;
      g.rotation.z = THREE.MathUtils.clamp(-(vx.v ?? 0) * 0.02, -0.3, 0.3);
      g.rotation.x = THREE.MathUtils.clamp((vz.v ?? 0) * 0.02, -0.3, 0.3);
      beamK += (beamTarget - beamK) * Math.min(1, dt * 6);
      beam.material.opacity = 0.17 * beamK; beam.visible = beamK > 0.01; glow.intensity = 45 * beamK;
      beam.scale.set(1, Math.max(0.01, pos.y / 10), 1); // the beam always reaches the floor
      g.getWorldPosition(wp).project(camera);
      tagEl.style.left = (wp.x * 0.5 + 0.5) * innerWidth + "px"; tagEl.style.top = (-wp.y * 0.5 + 0.5) * innerHeight + "px";
    },
  };
})();
const roomName = (id) => roomById(id, layout)?.name ?? id;

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
  agent.update(dt, clock);
  if (st === "result") { controls.update(); updateTags(); updateDimTags(); furnDrag?.update(dt); }
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
function furnishRoom(id, delay = 0) {
  const g = furn.byRoom[id]; if (!g) return;
  g.visible = true;
  const items = [...g.children].sort((a, b) => (b.userData.collide ? 1 : 0) - (a.userData.collide ? 1 : 0));
  items.forEach((it) => { it.visible = false; });
  // the drone is the source: each piece leaves it, arcs down and lands with a small bounce
  const src = new THREE.Vector3();
  items.forEach((it, i) => {
    const home = it.userData.home, r0 = (Math.random() - 0.5) * 0.6;
    let from = null;
    tween(T(720), (k) => {
      if (!from) { world.localToWorld(src.copy(agent.on ? agent.origin() : new THREE.Vector3(home.x, 8, home.z))); from = g.worldToLocal(src.clone()); }
      it.visible = true;
      const arc = Math.sin(Math.PI * Math.min(1, k)) * 2.2;
      it.position.set(from.x + (home.x - from.x) * k, Math.max(0, from.y * (1 - k) + arc * (1 - k)), from.z + (home.z - from.z) * k);
      it.rotation.y = r0 * (1 - k);
      it.scale.setScalar(0.35 + 0.65 * Math.min(1, k * 1.3));
    }, ease.drop, T(delay + i * 85)).then(() => { it.position.copy(home); it.rotation.y = 0; it.scale.setScalar(1); });
  });
  const card = document.querySelector(`.card[data-id="${id}"]`);
  const n = piecesIn(id);
  if (card && n) { card.classList.add("furnished"); card.querySelector("span").textContent = `${n} pieces`; }
}
function agentPhase(id) {
  if (id === "plan") { agent.show(); agent.goAbove(30 * houseFit(), "Reading the room program"); agent.beam(0); }
  if (id === "solve") agent.say("Laying out rooms");
  if (id === "check") { agent.goAbove(28 * houseFit(), "Checking layout rules"); agent.beam(0.2); }
}
function onEvent(e) {
  switch (e.type) {
    case "phase": setPhase(e.id); agentPhase(e.id); if (e.id === "furnish") { const r0 = rig.radius, h0 = rig.height; tween(T(3200), (k) => { rig.radius = r0 - 14 * k; rig.height = h0 + 8 * k; rig.spin = 0.12 - 0.06 * k; }, ease.settle); } break;
    case "thought": typeLine(e.text); break;
    case "room": addBriefCard(e.room); break;
    case "place": agent.show(); agent.goTo(e.roomId, 13, `${e.reflow ? "Moving" : "Placing"} ${roomName(e.roomId)}`); agent.beam(1); placeRoom(e.roomId, e.reflow); break;
    case "check": agent.say(`Checking: ${ruleLabel(e.rule).toLowerCase()}`); addCheck(e); if (!e.pass) fixLog.push(`<li><b>Round ${e.round ?? 1}.</b> ${ruleLabel(e.rule)}: ${e.message}</li>`); break;
    case "fix": doFix(e); break;
    case "walls": typeLine("Raising walls, cutting window openings, setting door frames."); agent.goAbove(34 * houseFit(), "Raising walls and setting windows"); agent.beam(0.4); raiseWalls(); break;
    case "furnish": {
      const n = (furn.byRoom[e.roomId]?.children ?? []).length;
      agent.goTo(e.roomId, 10.5, n ? `Furnishing ${roomName(e.roomId)} · ${n} pieces` : `Checking ${roomName(e.roomId)}`); agent.beam(n ? 1 : 0.3);
      furnishRoom(e.roomId, 380); break;
    }
    case "done": agent.say("Done — your house is ready"); agent.beam(0); setTimeout(() => agent.hide(), T(700)); finish(e.stats); break;
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
$("#promptForm").addEventListener("submit", (e) => { e.preventDefault(); briefTurn($("#prompt").value.trim() || DEFAULT_PROMPT); });

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
  buildMeasure3d(); syncTools();
  if (tools.view === "plan") renderPlan();
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
  openChat(stats);
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
    const t = document.createElement("div"); t.className = "tag"; t.dataset.id = r.id; t.innerHTML = `${r.name}<small>${fmtFt(r.w)} × ${fmtFt(r.h)} · ${sqft(r)} sq ft</small>`;
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
  const focus = res.changed.find((id) => house.floors[id]);
  if (focus) { agent.show(); agent.goTo(focus, 14, `Rebuilding ${roomName(focus)}`); agent.beam(1); }
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
  // re-furnish the changed rooms from the drone, then it leaves
  for (const id of ids) if (furn.byRoom[id]) { agent.goTo(id, 10.5, `Furnishing ${roomName(id)}`); furnishRoom(id, 200); await new Promise((r) => setTimeout(r, T(700))); }
  agent.beam(0); agent.hide();
  plan = { ...plan, layout, ...(res.response ? { program: res.response.program, response: res.response } : {}) };
  renderPanel(); renderRoomList(ids);
  msg.className = "editmsg ok"; msg.textContent = res.note;
  const chk = layout.checks ?? [], ok = chk.filter((c) => c.pass).length;
  toast(`Updated. ${ids.size} room${ids.size === 1 ? "" : "s"} changed${chk.length ? `, ${ok} of ${chk.length} rules pass` : ", all rules still pass"}.`);
  editing = false; furnDrag.enabled = document.body.dataset.state === "result";
}
async function goLanding() {
  if (diving) return;
  await mist.cover(T(600));
  tools.view = "3d"; tools.measure = false; syncTools();
  controls.enabled = false; controls.autoRotate = false; highlight(null); resetHouse(); furnDrag.enabled = false;
  loose.forEach((b) => { b.visible = true; b.scale.setScalar(1); b.userData.orbit.on = true; });
  Object.assign(rig, { theta: LANDING.theta, radius: LANDING.radius, height: LANDING.height, spin: LANDING.spin }); rig.target.set(0, LANDING.ty, 0);
  setState("landing"); placeCam(); $("#prompt").focus();
  await mist.reveal(T(1000));
}
$("#newBtn").addEventListener("click", async () => { convo.length = 0; $("#clarify").hidden = true; await goLanding(); });

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
// ---------- design chat: an iterative loop with the agent (POST /api/chat; local fallback) ----------
const convo = []; // the whole conversation, from the first brief through every refinement
let chatBusy = false;
const msgsEl = $("#msgs"), optsEl = $("#opts");
function addMsg(role, text, { ask = false, meta = "" } = {}) {
  const li = document.createElement("li");
  li.className = `msg ${role}${ask ? " ask" : ""}`;
  li.textContent = text;
  if (meta) { const m = document.createElement("span"); m.className = "meta"; m.textContent = meta; li.append(m); }
  msgsEl.append(li); msgsEl.scrollTop = msgsEl.scrollHeight;
  return li;
}
function setOptions(list, kind = "ask") {
  optsEl.className = "opts" + (kind === "suggest" ? " suggest" : "");
  optsEl.innerHTML = "";
  for (const t of (list ?? []).slice(0, 4)) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = t;
    b.addEventListener("click", () => sendChat(t)); optsEl.append(b);
  }
}
let typingEl = null;
function showTyping(on) {
  typingEl?.remove(); typingEl = null;
  if (on) { typingEl = document.createElement("li"); typingEl.className = "msg agent typing"; typingEl.innerHTML = "<i></i><i></i><i></i>"; msgsEl.append(typingEl); msgsEl.scrollTop = msgsEl.scrollHeight; }
}
function suggestions() {
  const rs = layout.rooms.filter((r) => !["hall", "closet", "entry"].includes(r.type));
  const kitchen = rs.find((r) => r.type === "kitchen"), bed = rs.find((r) => r.type === "bedroom"), primary = rs.find((r) => r.type === "primary_bedroom");
  const office = rs.find((r) => r.type === "office"), living = rs.find((r) => r.type === "living");
  return [kitchen && "Make the kitchen bigger", primary && `How big is the ${primary.name.toLowerCase()}?`, bed && `Make ${bed.name.toLowerCase()} smaller`,
    office ? "Why is the office where it is?" : living && "How big is the whole house?"].filter(Boolean);
}
const vagueBrief = (t) => !/\d/.test(t) && !/\b(studio|one|two|three|four|five|six)\b[\s-]*(bed|br\b|bedroom)/i.test(t);
// offline fallback when the API is unreachable: same contract as /api/chat, decided locally
function localChat(messages, withHouse) {
  const users = messages.filter((m) => m.role === "user").map((m) => m.content);
  // a bare answer ("Kitchen") to a "which room?" question carries the direction of the request before it
  const last = users.at(-1), low = (/bigger|larger|wider|smaller|narrower|shrink|grow/i.test(last) ? last : users.slice(-2).join(" ")).toLowerCase();
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join(", ");
  if (!withHouse) {
    const asked = messages.filter((m) => m.role === "assistant").length;
    if (vagueBrief(userText) && asked === 0) return { action: "ask", reply: "Happy to. How many bedrooms should it have?", options: ["1 bedroom", "2 bedrooms", "3 bedrooms", "4 bedrooms"] };
    if (!/\d[\d,.]*\s*(k\b|sq|sf|square)/i.test(userText) && asked === 1 && !/\d{3}/.test(userText)) return { action: "ask", reply: "And roughly how big overall?", options: ["About 1,000 sq ft", "About 1,600 sq ft", "About 2,200 sq ft", "You choose"] };
    return { action: "generate", reply: "Got it — planning it now.", brief: userText.replace(/,?\s*you choose/i, ""), options: [] };
  }
  if (/\b(start over|new house|instead|from scratch)\b/.test(low)) return { action: "generate", reply: "Starting a fresh plan.", brief: last, options: [] };
  const room = [...layout.rooms].sort((a, b) => b.name.length - a.name.length).find((r) => low.includes(r.name.toLowerCase()) || low.includes(r.type.replace("_", " ")));
  if (/how (big|large|wide|long)|sq ?ft|square feet|size|dimension/.test(low)) {
    if (room) return { action: "answer", reply: `${room.name} is ${fmtFt(room.w)} × ${fmtFt(room.h)}, ${sqft(room)} sq ft.`, options: [] };
    const total = Math.round(layout.rooms.reduce((a, r) => a + r.w * r.h, 0));
    return { action: "answer", reply: `The house is ${fmtFt(layout.footprint.width_ft)} × ${fmtFt(layout.footprint.depth_ft)} outside, ${total.toLocaleString()} sq ft of rooms.`, options: [] };
  }
  if (/bigger|larger|wider|smaller|narrower|shrink|grow|more space/.test(low)) {
    if (!room) {
      const big = [...layout.rooms].filter((r) => r.type !== "hall").sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 4);
      const dir = /smaller|narrower|shrink/.test(low) ? "smaller" : "bigger";
      return { action: "ask", reply: `Which room should get ${dir}?`, options: big.map((r) => `Make the ${r.name.toLowerCase()} ${dir}`) };
    }
    const res = editLayout(layout, low);
    if (res) return { action: "edit", reply: res.note, options: [], local: res };
    return { action: "answer", reply: `I couldn't resize ${room.name} without breaking a neighbouring room. Try a different room, or ask for a new plan.`, options: [] };
  }
  return { action: "answer", reply: "I can resize rooms (\"make the kitchen bigger\"), tell you sizes, or start a new plan. What would you like to change?", options: suggestions() };
}
async function callChat(messages, withHouse) {
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 120000);
    const r = await fetch(`${API}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ messages, program: withHouse ? plan.program : null, layout: withHouse ? layout : null }) });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`chat ${r.status}`);
    return await r.json();
  } catch (err) { console.warn("chat API unavailable, answering locally", err); return localChat(messages, withHouse); }
}
function editFromResponse(resp) {
  const old = new Map(layout.rooms.map((q) => [q.id, q]));
  const now = new Map(resp.layout.rooms.map((q) => [q.id, q]));
  const changed = [...new Set([...resp.layout.rooms.filter((q) => { const o = old.get(q.id); return !o || o.x !== q.x || o.y !== q.y || o.w !== q.w || o.h !== q.h; }).map((q) => q.id),
    ...[...old.keys()].filter((id) => !now.has(id))])];
  const named = changed.map((id) => now.get(id)).filter(Boolean).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const note = changed.length ? `${named ? `${named.name} is now ${fmtFt(named.w)} × ${fmtFt(named.h)} (${sqft(named)} sq ft). ` : ""}${changed.length} room${changed.length === 1 ? "" : "s"} changed; the rest of the house stayed put.` : "The planner kept the layout as it was.";
  return { layout: resp.layout, changed, note, response: resp };
}
async function sendChat(text) {
  text = (text ?? "").trim();
  if (!text || chatBusy || editing || document.body.dataset.state !== "result") return;
  chatBusy = true; $("#chatForm .send").disabled = true; setOptions([]);
  addMsg("user", text); convo.push({ role: "user", content: text });
  showTyping(true);
  const res = await callChat(convo, true);
  showTyping(false);
  convo.push({ role: "assistant", content: res.reply });
  if (res.action === "generate") {
    addMsg("agent", res.reply);
    chatBusy = false; $("#chatForm .send").disabled = false;
    await goLanding(); $("#prompt").value = res.brief || text; start(res.brief || text);
    return;
  }
  if (res.action === "edit") {
    addMsg("agent", res.reply);
    let r = res.local ?? (res.result ? editFromResponse(res.result) : null);
    // the planner kept the layout (e.g. offline backend): resize locally so the request still lands
    // (a tapped answer like "Kitchen" is read together with the request it answers: "make it bigger")
    if (r && !r.changed.length) {
      const intent = convo.filter((m) => m.role === "user").slice(-2).map((m) => m.content).join(" ");
      const loc = editLayout(layout, text) ?? editLayout(layout, intent);
      if (loc) { r = loc; addMsg("note", `Resized locally while the live planner is offline: ${loc.note}`); }
    }
    if (r?.changed.length) await animateEdit(r);
    setOptions(res.options?.length ? res.options : suggestions(), "suggest");
  } else {
    addMsg("agent", res.reply, { ask: res.action === "ask" });
    setOptions(res.options?.length ? res.options : res.action === "ask" ? [] : suggestions(), res.action === "ask" ? "ask" : "suggest");
  }
  chatBusy = false; $("#chatForm .send").disabled = false;
}
$("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#chatInput").value; $("#chatInput").value = ""; autosize(); sendChat(v); });
const autosize = () => { const t = $("#chatInput"); t.style.height = "auto"; t.style.height = Math.min(120, t.scrollHeight) + "px"; };
$("#chatInput").addEventListener("input", autosize);
$("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chatForm").requestSubmit(); } });
// the house is ready: the agent opens the conversation
function openChat(stats) {
  msgsEl.innerHTML = "";
  for (const m of convo) addMsg(m.role === "user" ? "user" : "agent", m.content);
  const total = Math.round(layout.rooms.reduce((a, r) => a + r.w * r.h, 0));
  const intro = `I planned ${layout.rooms.length} rooms, ${total.toLocaleString()} sq ft on a ${fmtFt(layout.footprint.width_ft)} × ${fmtFt(layout.footprint.depth_ft)} footprint`
    + `${stats.rounds ? `, and fixed ${stats.rounds} rule failure round${stats.rounds === 1 ? "" : "s"} on the way` : ""}. What would you like to change? I'll re-check every rule after each change.`;
  addMsg("agent", intro, { meta: `${stats.rulesPassed} of ${stats.rules ?? 7} layout rules pass` });
  convo.push({ role: "assistant", content: intro });
  setOptions(suggestions(), "suggest");
}
// panel tabs
document.querySelectorAll(".ptabs [role=tab]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".ptabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", t === tab));
  $("#paneChat").hidden = tab.dataset.tab !== "chat"; $("#paneInfo").hidden = tab.dataset.tab !== "info";
  if (tab.dataset.tab === "info") refreshMinis();
}));

// ---------- landing: ask clarifying questions only when the brief is too vague to plan ----------
let briefBusy = false;
async function briefTurn(text) {
  if (diving || run || briefBusy) return;
  const firstTurn = !convo.length || $("#clarify").hidden;
  if (firstTurn) convo.length = 0;
  convo.push({ role: "user", content: text });
  const userText = convo.filter((m) => m.role === "user").map((m) => m.content).join(", ");
  // clear briefs go straight to the planner (no extra model call)
  if (firstTurn && !vagueBrief(text)) { $("#clarify").hidden = true; start(text); return; }
  briefBusy = true; const btn = $("#buildBtn"); btn.disabled = true; btn.textContent = "Thinking…";
  const res = await callChat(convo, false);
  briefBusy = false; btn.disabled = false; btn.textContent = "Build it";
  convo.push({ role: "assistant", content: res.reply });
  if (res.action === "ask") {
    $("#clarifyQ").textContent = res.reply;
    $("#clarifyOpts").innerHTML = (res.options ?? []).slice(0, 4).map((o) => `<button type="button" class="chip">${o}</button>`).join("");
    $("#clarify").hidden = false; $("#prompt").value = ""; $("#prompt").placeholder = "Type an answer, or pick one below"; $("#prompt").focus();
    return;
  }
  $("#clarify").hidden = true; $("#prompt").placeholder = "";
  start(res.brief || userText);
}
$("#clarifyOpts").addEventListener("click", (e) => { if (e.target.matches(".chip")) briefTurn(e.target.textContent); });

// ---------- measurements: 3D grid + dimension lines; plan view with grid, rulers, scale bar, tape measure ----------
const tools = { view: "3d", grid: false, dims: false, measure: false };
let grid3d = null, dims3d = null; const dimTagEls = [];
function buildMeasure3d() {
  for (const o of [grid3d, dims3d]) if (o) { world.remove(o); o.traverse((n) => { n.geometry?.dispose(); n.material?.dispose?.(); }); }
  const { width_ft: W, depth_ft: D } = layout.footprint;
  // foot grid aligned to the house corner; every 5th line stronger
  const S = Math.ceil((Math.max(W, D) + 30) / 10) * 10;
  grid3d = new THREE.Group(); grid3d.visible = tools.grid;
  const mk = (div, color, op) => { const g = new THREE.GridHelper(S, div, color, color); g.material.transparent = true; g.material.opacity = op; g.material.depthWrite = false; return g; };
  const minor = mk(S, 0x6f7f9c, 0.28), major = mk(S / 5, 0x2b45f5, 0.38);
  const off = (step) => (((-W / 2 + S / 2) % step) + step) % step, offz = (step) => (((-D / 2 + S / 2) % step) + step) % step;
  minor.position.set(off(1), 0.05, offz(1)); major.position.set(off(5), 0.06, offz(5));
  grid3d.add(minor, major); world.add(grid3d);
  // overall dimension strings outside the walls (north and west), with end ticks
  dims3d = new THREE.Group(); dims3d.visible = tools.dims;
  const pts = [], o = 5, t = 1;
  const seg = (a, b) => pts.push(a, b);
  const x0 = -W / 2, x1 = W / 2, z0 = -D / 2, z1 = D / 2, y = 0.3;
  seg(new THREE.Vector3(x0, y, z0 - o), new THREE.Vector3(x1, y, z0 - o));
  seg(new THREE.Vector3(x0, y, z0 - o - t), new THREE.Vector3(x0, y, z0 - 0.6)); seg(new THREE.Vector3(x1, y, z0 - o - t), new THREE.Vector3(x1, y, z0 - 0.6));
  seg(new THREE.Vector3(x0 - o, y, z0), new THREE.Vector3(x0 - o, y, z1));
  seg(new THREE.Vector3(x0 - o - t, y, z0), new THREE.Vector3(x0 - 0.6, y, z0)); seg(new THREE.Vector3(x0 - o - t, y, z1), new THREE.Vector3(x0 - 0.6, y, z1));
  dims3d.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x2b45f5 })));
  world.add(dims3d);
  $("#dimTags").innerHTML = ""; dimTagEls.length = 0;
  for (const [txt, p] of [[fmtFt(W), new THREE.Vector3(0, y, z0 - o)], [fmtFt(D), new THREE.Vector3(x0 - o, y, 0)]]) {
    const el = document.createElement("div"); el.className = "dimtag"; el.textContent = txt; $("#dimTags").append(el); dimTagEls.push([el, p]);
  }
}
const dv = new THREE.Vector3();
function updateDimTags() {
  const show = tools.dims && tools.view === "3d";
  for (const [el, p] of dimTagEls) {
    el.style.display = show ? "" : "none"; if (!show) continue;
    world.localToWorld(dv.copy(p)).project(camera);
    el.style.left = (dv.x * 0.5 + 0.5) * innerWidth + "px"; el.style.top = (-dv.y * 0.5 + 0.5) * innerHeight + "px";
  }
}
function syncTools() {
  document.querySelectorAll("#viewbar [data-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === tools.view));
  for (const k of ["grid", "dims", "measure"]) document.querySelector(`#viewbar [data-tog="${k}"]`).setAttribute("aria-pressed", tools[k]);
  document.body.classList.toggle("dims", tools.dims);
  document.body.classList.toggle("planmode", tools.view === "plan");
  if (grid3d) grid3d.visible = tools.grid && tools.view === "3d";
  if (dims3d) dims3d.visible = tools.dims && tools.view === "3d";
  const pv = $("#planView"); pv.hidden = tools.view !== "plan";
  pv.classList.toggle("measuring", tools.measure);
  const svg = $("#planSvg"); svg.classList.toggle("grid", tools.grid); svg.classList.toggle("dims", tools.dims);
  const inPlan = tools.view === "plan";
  controls.enabled = !inPlan && document.body.dataset.state === "result" && !editing;
  if (furnDrag) furnDrag.enabled = !inPlan && document.body.dataset.state === "result" && !editing;
  $("#planHint").textContent = tools.measure ? "Drag between two points to measure · hold Shift to turn off snapping" : "Scroll to zoom · drag to pan · hover a room for its size";
}
$("#viewbar").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.view) { tools.view = b.dataset.view; if (tools.view === "plan") renderPlan(); else tools.measure = false; }
  if (b.dataset.tog) {
    tools[b.dataset.tog] = !tools[b.dataset.tog];
    if (b.dataset.tog === "measure" && tools.measure && tools.view !== "plan") { tools.view = "plan"; renderPlan(); }
    if (b.dataset.tog === "measure" && !tools.measure) clearTape();
  }
  syncTools();
});

// plan view (SVG in feet; origin = the footprint's top-left corner)
const PV = { vb: { x: 0, y: 0, w: 60, h: 40 } };
const planSvgEl = $("#planSvg");
function itemBoxes() {
  const { width_ft: W, depth_ft: D } = layout.footprint, out = [];
  furn.group.updateMatrixWorld(true);
  const inv = furn.group.matrixWorld.clone().invert(), bb = new THREE.Box3(), tb = new THREE.Box3(), m = new THREE.Matrix4();
  for (const it of furn.items) {
    if (!it.parent || it.userData.wall || /rug|runner|mat/.test(it.userData.name)) continue;
    bb.makeEmpty();
    it.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); tb.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)); bb.union(tb); } });
    if (bb.isEmpty()) continue;
    out.push([bb.min.x + W / 2, bb.min.z + D / 2, bb.max.x - bb.min.x, bb.max.z - bb.min.z, it.userData.name]);
  }
  return out;
}
function renderPlan() {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  $("#planView").hidden = false; // must be laid out before it can be fitted
  const raw = planSVG(layout, { pad: 0, labels: true, dims: true });
  const inner = raw.slice(raw.indexOf(">") + 1, raw.lastIndexOf("</svg>"));
  const big = Math.max(W, D) + 200;
  const fur = itemBoxes().map(([x, y, w, h, n]) => `<rect class="fur" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx=".2"><title>${n}</title></rect>`).join("");
  const o = 3.2, tk = 0.6;
  const dims = `<g class="dimlayer">
    <path class="dimline" d="M0 ${-o} H${W} M0 ${-o - tk} V${-0.4} M${W} ${-o - tk} V${-0.4} M${-o} 0 V${D} M${-o - tk} 0 H${-0.4} M${-o - tk} ${D} H${-0.4}"/>
    <text class="dimtext" x="${W / 2}" y="${-o - 0.5}" text-anchor="middle">${fmtFt(W)}</text>
    <text class="dimtext" x="${-o - 0.5}" y="${D / 2}" text-anchor="middle" transform="rotate(-90 ${-o - 0.5} ${D / 2})">${fmtFt(D)}</text></g>`;
  planSvgEl.innerHTML = `<defs>
      <pattern id="g1" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="#e6e2d9" stroke-width=".04"/></pattern>
      <pattern id="g5" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M5 0H0V5" fill="none" stroke="#c9cfe6" stroke-width=".09"/></pattern></defs>
    <g class="gridlayer"><rect x="${-big}" y="${-big}" width="${big * 2}" height="${big * 2}" fill="url(#g1)"/><rect x="${-big}" y="${-big}" width="${big * 2}" height="${big * 2}" fill="url(#g5)"/></g>
    ${inner.replace('<g class="p-labels">', `<g class="p-fur">${fur}</g><g class="p-labels">`)}${dims}<g class="tape" id="tape"></g>`;
  // fit the footprint (plus room for the dimension strings) to the view
  const r = planSvgEl.getBoundingClientRect(), pad = 7, aw = W + pad * 2, ah = D + pad * 2;
  const s = Math.min(r.width / aw, r.height / ah) || 10;
  PV.vb = { w: r.width / s, h: r.height / s, x: -pad - (r.width / s - aw) / 2, y: -pad - (r.height / s - ah) / 2 };
  applyVB();
  planSvgEl.querySelectorAll(".p-room").forEach((el) => {
    el.addEventListener("pointerenter", () => { if (tools.measure) return; const rm = roomById(el.dataset.id, layout); el.classList.add("hot"); $("#planHint").textContent = `${rm.name}: ${fmtFt(rm.w)} × ${fmtFt(rm.h)} · ${sqft(rm)} sq ft`; });
    el.addEventListener("pointerleave", () => { el.classList.remove("hot"); syncTools(); });
  });
  syncTools();
}
function applyVB() {
  const { x, y, w, h } = PV.vb;
  planSvgEl.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  renderRulers();
}
const STEPS = [1, 2, 5, 10, 20, 50];
function renderRulers() {
  const r = planSvgEl.getBoundingClientRect(); if (!r.width) return;
  const s = r.width / PV.vb.w; // px per ft
  const label = STEPS.find((st) => st * s >= 46) ?? 50, minor = s >= 7 ? 1 : label / 5 >= 1 ? label / 5 : 1;
  const ruler = (from, len, px, horiz) => {
    let out = "";
    for (let ft = Math.ceil(from / minor) * minor; ft <= from + len; ft += minor) {
      const p = (ft - from) * s, isL = Math.abs(ft / label - Math.round(ft / label)) < 1e-6, h = isL ? 10 : 5;
      out += horiz ? `<line x1="${p}" x2="${p}" y1="24" y2="${24 - h}" stroke="#9a968d" stroke-width="1"/>` : `<line y1="${p}" y2="${p}" x1="28" x2="${28 - h}" stroke="#9a968d" stroke-width="1"/>`;
      if (isL) out += horiz ? `<text x="${p + 3}" y="11" fill="#6E6B65" font-size="10">${Math.round(ft)}'</text>` : `<text x="3" y="${p - 3}" fill="#6E6B65" font-size="10">${Math.round(ft)}'</text>`;
    }
    return `<svg width="${horiz ? px : 28}" height="${horiz ? 24 : px}">${out}</svg>`;
  };
  $("#rulerTop").innerHTML = ruler(PV.vb.x, PV.vb.w, r.width, true);
  $("#rulerLeft").innerHTML = ruler(PV.vb.y, PV.vb.h, r.height, false);
  // scale bar: the round length closest to ~110 px
  const L = [1, 2, 5, 10, 20, 50].reduce((a, b) => (Math.abs(b * s - 110) < Math.abs(a * s - 110) ? b : a));
  const w = L * s;
  $("#scaleBar").innerHTML = `<svg width="${w + 2}" height="10"><rect x="1" y="2" width="${w / 2}" height="6" fill="#151515"/><rect x="${1 + w / 2}" y="2" width="${w / 2}" height="6" fill="#fff" stroke="#151515" stroke-width="1"/></svg>`
    + `<div style="display:flex;justify-content:space-between;width:${w + 2}px"><span>0</span><span>${L} ft</span></div>${tools.grid ? "<div>1 square = 1 ft</div>" : ""}`;
}
function toPlan(e) {
  const r = planSvgEl.getBoundingClientRect();
  return { x: PV.vb.x + ((e.clientX - r.left) / r.width) * PV.vb.w, y: PV.vb.y + ((e.clientY - r.top) / r.height) * PV.vb.h };
}
planSvgEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = toPlan(e), f = Math.exp(e.deltaY * 0.0015), vb = PV.vb;
  const nw = Math.min(400, Math.max(6, vb.w * f)), k = nw / vb.w;
  PV.vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w: nw, h: vb.h * k };
  applyVB();
}, { passive: false });
let panFrom = null, tapeFrom = null;
const snap = (v, e) => (e.shiftKey ? v : Math.round(v * 2) / 2);
function clearTape() { const t = $("#tape"); if (t) t.innerHTML = ""; }
function drawTape(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, up = ang > 90 || ang < -90 ? ang + 180 : ang;
  $("#tape").innerHTML = `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/><circle cx="${a.x}" cy="${a.y}" r=".22"/><circle cx="${b.x}" cy="${b.y}" r=".22"/>`
    + `<text x="${mx}" y="${my - 0.5}" text-anchor="middle" transform="rotate(${up} ${mx} ${my})">${fmtFt(Math.round(d * 12) / 12)}</text>`;
  $("#planHint").textContent = `${fmtFt(Math.round(d * 12) / 12)} · Δ ${fmtFt(Math.abs(Math.round((b.x - a.x) * 12) / 12))} × ${fmtFt(Math.abs(Math.round((b.y - a.y) * 12) / 12))}`;
}
planSvgEl.addEventListener("pointerdown", (e) => {
  try { planSvgEl.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
  const p = toPlan(e);
  if (tools.measure) { tapeFrom = { x: snap(p.x, e), y: snap(p.y, e) }; drawTape(tapeFrom, tapeFrom); }
  else { panFrom = { x: e.clientX, y: e.clientY, vb: { ...PV.vb } }; planSvgEl.classList.add("panning"); }
});
planSvgEl.addEventListener("pointermove", (e) => {
  if (tapeFrom) { const p = toPlan(e); drawTape(tapeFrom, { x: snap(p.x, e), y: snap(p.y, e) }); return; }
  if (!panFrom) return;
  const r = planSvgEl.getBoundingClientRect(), s = r.width / panFrom.vb.w;
  PV.vb = { ...panFrom.vb, x: panFrom.vb.x - (e.clientX - panFrom.x) / s, y: panFrom.vb.y - (e.clientY - panFrom.y) / s };
  applyVB();
});
planSvgEl.addEventListener("pointerup", () => { panFrom = null; tapeFrom = null; planSvgEl.classList.remove("panning"); });
addEventListener("resize", () => { if (tools.view === "plan") renderPlan(); });

// dev-only handle for automated checks (stripped from production builds)
if (process.env.NODE_ENV !== "production") window.__build = { THREE, camera, get furn() { return furn; }, get layout() { return layout; }, canvas };
}
