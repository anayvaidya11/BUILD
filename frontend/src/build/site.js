// Site view for the design mockups: drop the generated house onto its real lot.
//
// Shared by all five mockups. Each page only calls `addSiteButton(walkButton, () => layout)`;
// this module adds an "On site" button next to its Walk through button and owns a
// full-screen overlay with its own renderer:
//
//   - Google Photorealistic 3D Tiles (3d-tiles-renderer), recentered on the address so the lot
//     sits at the three.js origin (+Y up, -X east, +Z north, meters).
//   - Address search via OpenStreetMap Nominatim (free, no key).
//   - Ground height: raycast the tiles in a ring around the lot; ignore coarse root tiles.
//   - TileFlatteningPlugin presses anything above a "bowl" (flat pad + sloped skirt) down onto
//     it, which removes the existing house and trees without vertical "curtains".
//   - Double-click the map to move the house; slider to rotate; gable / flat roof.
//
// Key: NEXT_PUBLIC_GOOGLE_MAPS_KEY in frontend/.env.local (git-ignored).
// Without a key the overlay still works on a plain lawn.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { BRAND } from "./core.js";
import { STYLES, defaultExterior, buildExteriorHouse, parseExteriorPrompt } from "./exterior.js";
import { ProjectionSkin } from "./projskin.js";
import { neighborhoodOrientation, houseRotation } from "./orient.js";

const FT = 0.3048;
const DEG = Math.PI / 180;
const LOT_MARGIN_FT = 12;
const SKIRT_RUN_M = 14, SKIRT_RISE_M = 12;
const MIN_GROUND_M = -500, MAX_GROUND_M = 6000; // ellipsoid heights; outside = coarse root tiles

async function loadKey() {
  // Google Map Tiles key: NEXT_PUBLIC_GOOGLE_MAPS_KEY in frontend/.env.local (restrict it by HTTP referrer)
  return process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || "";
}

/** Flattening shape (meters): pad w x d, skirt rising SKIRT_RISE_M over SKIRT_RUN_M. */
function lotBowl(w, d) {
  const iw = w / 2, id = d / 2, ow = iw + SKIRT_RUN_M, od = id + SKIRT_RUN_M, h = SKIRT_RISE_M;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([
    -iw, 0, -id, iw, 0, -id, iw, 0, id, -iw, 0, id, -ow, h, -od, ow, h, -od, ow, h, od, -ow, h, od,
  ], 3));
  const idx = [0, 2, 1, 0, 3, 2];
  for (let i = 0; i < 4; i++) { const a = i, b = (i + 1) % 4; idx.push(a, b, b + 4, a, b + 4, a + 4); }
  geo.setIndex(idx); geo.computeBoundingSphere();
  return geo;
}

// ---------- overlay UI ----------

const CSS = `
.site-ov{position:fixed;inset:0;z-index:9000;background:#cfd8e3;font:14px/1.4 inherit;color:#151515}
.site-ov canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.site-ov .sp{position:absolute;top:16px;left:16px;width:300px;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-radius:14px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.15);display:flex;flex-direction:column;gap:10px}
.site-ov .sp h3{margin:0;font-size:15px;font-weight:600}
.site-ov form{display:flex;gap:6px}
.site-ov input[type=text]{flex:1;min-width:0;border:1px solid #d9d6cf;border-radius:8px;padding:7px 9px;font:inherit;background:#fff;color:#151515}
.site-ov button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid #d9d6cf;background:#fff;color:#151515;padding:6px 10px}
.site-ov button.pri{background:${BRAND.blue};border-color:${BRAND.blue};color:#fff}
.site-ov button.on{border-color:${BRAND.blue};color:${BRAND.blue};background:#eef1ff}
.site-ov .row{display:flex;gap:6px;align-items:center}
.site-ov .muted{font-size:12px;color:#6e6b65}
.site-ov .err{font-size:12px;color:#b26a00}
.site-ov .close{position:absolute;top:16px;right:16px;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,.92)}
.site-ov .hint,.site-ov .load{position:absolute;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.6);color:#fff;border-radius:999px;padding:5px 12px;font-size:12px;pointer-events:none;white-space:nowrap}
.site-ov .hint{bottom:14px}.site-ov .load{top:16px}
.site-ov .attr{position:absolute;right:10px;bottom:6px;font-size:10px;color:#fff;text-shadow:0 0 3px #000;display:flex;gap:6px;align-items:center;max-width:60%;pointer-events:none}
.site-ov .attr img{height:14px}
.site-ov input[type=range]{width:100%;accent-color:${BRAND.blue}}
.site-ov .sp{max-height:calc(100% - 32px);overflow:auto}
.site-ov .sec{border-top:1px solid #e7e4dd;padding-top:10px;display:flex;flex-direction:column;gap:8px}
.site-ov .chips{display:flex;flex-wrap:wrap;gap:5px}
.site-ov .chips button{padding:4px 8px;font-size:12px;border-radius:999px}
.site-ov .seg{display:flex;gap:4px}.site-ov .seg button{flex:1;padding:5px 4px;font-size:12px}
.site-ov .cols{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.site-ov .cols label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:#6e6b65}
.site-ov input[type=color]{width:100%;height:28px;border:1px solid #d9d6cf;border-radius:6px;padding:1px;background:#fff;cursor:pointer}
.site-ov .ok{font-size:12px;color:#1f7a4d}
.site-ov .shots{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);display:flex;gap:10px;align-items:flex-end;background:rgba(20,20,22,.55);backdrop-filter:blur(8px);padding:8px;border-radius:14px}
.site-ov .thumbs{display:grid;grid-template-columns:repeat(8,52px);gap:5px}
.site-ov .shot{width:52px;height:33px;border-radius:9px;overflow:hidden;background:#2a2b2e;position:relative;cursor:pointer;border:0;padding:0}
.site-ov .shot img{width:100%;height:100%;object-fit:cover;display:block}
.site-ov .shot span{position:absolute;inset:0;display:grid;place-items:center;color:#ddd;font-size:9px;text-align:center;padding:3px;overflow:hidden}
.site-ov .shot.busy span::after{content:"";width:16px;height:16px;margin-top:22px;border:2px solid #fff6;border-top-color:#fff;border-radius:50%;animation:sitespin 0.8s linear infinite;position:absolute}
@keyframes sitespin{to{transform:rotate(360deg)}}
.site-ov .shots .side{display:flex;flex-direction:column;gap:6px;color:#fff;font-size:11px;max-width:150px}
.site-ov .shots .side button{font-size:12px;padding:5px 8px}
.site-ov button:disabled{opacity:.45;cursor:default}
.site-ov .ostat{font-size:11px;color:#6e6b65}
.site-ov .gen{position:absolute;inset:0;z-index:8;display:grid;place-items:center;backdrop-filter:blur(18px) saturate(1.1);-webkit-backdrop-filter:blur(18px);background:rgba(12,14,20,.28);opacity:0;pointer-events:none;transition:opacity .7s}
.site-ov .gen.on{opacity:1;pointer-events:auto}
.site-ov .gen .gcard{color:#fff;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;text-shadow:0 1px 8px #0008}
.site-ov .gen .gcard b{font-size:22px;font-weight:600;letter-spacing:-.01em}
.site-ov .gen .gcard span{font-size:13px;opacity:.85}
.site-ov .gen .ring{width:42px;height:42px;border:3px solid #fff5;border-top-color:#fff;border-radius:50%;animation:sitespin 0.9s linear infinite}
.site-ov .gen .bar{width:220px;height:4px;border-radius:2px;background:#fff3;overflow:hidden}.site-ov .gen .bar i{display:block;height:100%;width:0;background:#fff;transition:width .4s}
.site-ov .spinbg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:2;opacity:0;pointer-events:none;background:#0b0b0c}
.site-ov.spinning canvas{visibility:hidden}
.site-ov.spinning{background:#0b0b0c}
.site-ov .attr{z-index:3}
.site-ov .spinhud{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);z-index:4;display:none;align-items:center;gap:10px;background:rgba(0,0,0,.55);color:#fff;padding:8px 10px 8px 16px;border-radius:999px;font-size:13px;backdrop-filter:blur(8px)}
.site-ov .spinhud button{background:#fff;color:#151515;border:0;border-radius:999px;padding:6px 12px}
.site-ov.spinning .spinhud{display:flex}
.site-ov.spinning .sp,.site-ov.spinning .shots,.site-ov.spinning .hint,.site-ov.flying .sp,.site-ov.flying .shots,.site-ov.flying .hint{display:none}
.site-ov.spinning{cursor:ew-resize}
.site-ov .skinrow{display:flex;gap:5px;align-items:center;font-size:11px}
.site-ov .lb{position:absolute;inset:0;background:rgba(0,0,0,.82);display:grid;place-items:center;z-index:5}
.site-ov .lb img{max-width:92%;max-height:82%;border-radius:10px;box-shadow:0 20px 60px #000}
.site-ov .lb .bar{position:absolute;top:16px;right:16px;display:flex;gap:8px}
`;

let state = { label: "", lat: null, lon: null, rotationDeg: 0, orient: "street", flatten: true, ext: defaultExterior() };

async function geocode(q) {
  // Server route (src/app/api/geocode): Google Geocoding when keyed, else Nominatim.
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !Number.isFinite(d.lat)) throw new Error(d.error || `No match for "${q}"`);
  return d;
}

export async function openSiteView(layout) {
  if (!document.getElementById("site-ov-css")) {
    const st = document.createElement("style"); st.id = "site-ov-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const key = await loadKey();
  const ov = document.createElement("div");
  ov.className = "site-ov";
  ov.innerHTML = `
    <canvas tabindex="0" aria-label="3D site view"></canvas>
    <img class="spinbg" alt="" /><img class="spinbg" alt="" />
    <div class="sp">
      <h3>Put it on a lot</h3>
      <form><input type="text" placeholder="Street address" aria-label="Address" /><button class="pri">Place</button></form>
      <div class="err" hidden></div>
      <div class="muted where"></div>
      <div class="muted">Orientation</div>
      <div class="seg orients"><button type="button" data-orient="street">Face street</button><button type="button" data-orient="match">Match neighbors</button><button type="button" data-orient="manual">Manual</button></div>
      <div class="ostat"></div>
      <label class="muted">Rotate house: <span class="deg">0°</span><input type="range" class="rot" min="-180" max="180" step="1" /></label>
      <label class="row muted"><input type="checkbox" class="flat" /> Clear the lot (existing house &amp; trees)</label>
      <div class="sec">
        <h3>Exterior</h3>
        <form class="describe"><input type="text" placeholder="e.g. craftsman, navy siding, white trim" aria-label="Describe the exterior" /><button class="pri">Apply</button></form>
        <div class="ok" hidden></div>
        <div class="chips styles"></div>
        <div class="muted">Roof</div>
        <div class="seg roofs">${["gable", "hip", "flat", "shed"].map((r) => `<button type="button" data-roof="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join("")}</div>
        <label class="muted pitchrow">Pitch: <span class="pv"></span>/12<input type="range" class="pitch" min="2" max="12" step="1" /></label>
        <div class="cols">
          <label>Siding<input type="color" data-c="siding" /></label>
          <label>Trim<input type="color" data-c="trim" /></label>
          <label>Roof<input type="color" data-c="roofColor" /></label>
        </div>
        <div class="muted">Porch</div>
        <div class="seg porches">${["none", "stoop", "covered"].map((r) => `<button type="button" data-porch="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join("")}</div>
      </div>
      ${key ? "" : `<div class="err">No Google key: showing a plain lawn. Set NEXT_PUBLIC_GOOGLE_MAPS_KEY to use real 3D terrain.</div>`}
    </div>
    <button class="close" type="button">Close ✕</button>
    <div class="load" hidden>Loading terrain…</div>
    <div class="hint" hidden>Drag to orbit · scroll to zoom · double-click the map to move the house</div>
    <div class="attr"></div>
    <div class="spinhud">Move your mouse left and right to walk around the house · 360° photoreal <button type="button" class="explore">Explore map</button></div>
    <div class="gen"><div class="gcard"><div class="ring"></div><b>Building your house on the lot</b><span class="gstat">Generating photoreal views…</span><div class="bar"><i></i></div></div></div>
    <div class="shots" hidden>
      <div class="thumbs">${Array.from({ length: 16 }, (_, i) => `<button type="button" class="shot" data-i="${i}"><span></span></button>`).join("")}</div>
      <div class="side"><b>Photoreal shots</b><span class="sstat"></span><label class="skinrow"><input type="checkbox" class="skin" checked disabled /> Photo skin on 3D house</label><button type="button" class="fullview pri" disabled>360° view</button><button type="button" class="rerender">Re-render</button></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (s) => ov.querySelector(s);

  // --- three setup ---
  const canvas = $("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfdcec);
  scene.fog = new THREE.Fog(0xcfdcec, 1500, 9000);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1e8); // far enough to start the fly-in from space (log depth keeps precision)
  camera.position.set(-22, 18, -24);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.08; controls.minDistance = 8; controls.maxDistance = 900;
  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x8a8070, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-60, 80, -30); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 300 });
  scene.add(sun, sun.target);

  const lawn = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x86a872, roughness: 1 }));
  lawn.receiveShadow = true; lawn.position.y = -0.3;
  const houseRoot = new THREE.Group(); houseRoot.scale.setScalar(FT); scene.add(houseRoot);
  // Gemini renders projected back onto the 3D house (see projskin.js).
  const skin = new ProjectionSkin(renderer, houseRoot);

  let groundY = null, tiles = null, reorient = null, flattener = null, shape = null, disposed = false;

  const rebuildHouse = () => {
    skin.invalidate(); // new geometry: old projections no longer line up until Re-render
    if (spin) exitSpin();
    const box = ov.querySelector(".skin"); if (box) box.disabled = true;
    houseRoot.clear(); houseRoot.add(buildExteriorHouse(layout, state.ext));
    houseRoot.rotation.y = Math.PI + state.rotationDeg * DEG;
    houseRoot.position.y = groundY ?? 0;
  };
  const resetCamera = () => {
    const y = groundY ?? 0;
    camera.position.set(-22, y + 18, -24); controls.target.set(0, y + 3, 0); controls.update();
  };

  // --- tiles ---
  if (key) {
    const [{ TilesRenderer }, P] = await Promise.all([import("3d-tiles-renderer"), import("3d-tiles-renderer/plugins")]);
    tiles = new TilesRenderer();
    tiles.registerPlugin(new P.GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
    tiles.registerPlugin(new P.GLTFExtensionsPlugin({ dracoLoader: new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/") }));
    reorient = new P.ReorientationPlugin({ lat: (state.lat ?? 0) * DEG, lon: (state.lon ?? 0) * DEG, height: 0, recenter: true });
    tiles.registerPlugin(reorient);
    flattener = new P.TileFlatteningPlugin();
    tiles.registerPlugin(flattener);
    tiles.registerPlugin(new P.TilesFadePlugin());
    tiles.errorTarget = 6;
    tiles.setCamera(camera);
    scene.add(tiles.group);
    tiles.group.visible = state.lat !== null;
  } else {
    scene.add(lawn);
  }

  const applyFlatten = () => {
    if (!flattener || !tiles) return;
    if (shape) { flattener.deleteShape(shape); shape = null; }
    if (!state.flatten || groundY === null) return;
    let w = (layout.footprint.width_ft + 2 * LOT_MARGIN_FT) * FT, d = (layout.footprint.depth_ft + 2 * LOT_MARGIN_FT + 10) * FT;
    // Grow the pad to cover the existing house's whole OSM outline (in the new house's axes), so no
    // part of the old house survives next to the new one.
    if (orientInfo?.lotBuilding && orientInfo.snapped) {
      const Y = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3();
      for (const q of orientInfo.lotBuilding) {
        v.set(q.x, 0, q.z).applyAxisAngle(Y, -houseRoot.rotation.y);
        w = Math.max(w, 2 * (Math.abs(v.x) + 3)); d = Math.max(d, 2 * (Math.abs(v.z) + 3));
      }
    }
    const mesh = new THREE.Mesh(lotBowl(w, d));
    tiles.group.updateMatrixWorld(true);
    const inv = tiles.group.matrixWorld.clone().invert();
    const world = new THREE.Matrix4().compose(new THREE.Vector3(0, groundY, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), houseRoot.rotation.y), new THREE.Vector3(1, 1, 1));
    world.premultiply(inv).decompose(mesh.position, mesh.quaternion, mesh.scale);
    // Direction = the way vertices are pushed: things above the bowl get pressed DOWN onto it.
    flattener.addShape(mesh, new THREE.Vector3(0, -1, 0).transformDirection(inv), { threshold: Infinity });
    shape = mesh;
  };

  const setGround = (y) => {
    const dy = y - (groundY ?? y);
    groundY = y; houseRoot.position.y = y;
    if (flight || spin) { /* the fly-in and 360 view place the camera themselves */ }
    else if (dy) { camera.position.y += dy; controls.target.y += dy; } else { resetCamera(); }
    applyFlatten();
    $(".load").hidden = true; $(".hint").hidden = false;
  };

  // ground finder: ring outside the bowl, low quantile (trees/roofs only push hits up)
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), o = new THREE.Vector3();
  let gT = 0, gAge = 0;
  const findGround = (dt) => {
    if (!tiles || state.lat === null) return;
    gT += dt; gAge += dt;
    if (gT < (gAge < 30 ? 0.5 : 3)) return;
    gT = 0;
    const hw = (layout.footprint.width_ft / 2 + LOT_MARGIN_FT) * FT, hd = (layout.footprint.depth_ft / 2 + LOT_MARGIN_FT + 5) * FT;
    const r = Math.hypot(hw, hd) + SKIRT_RUN_M + 2, hs = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ray.set(o.set(Math.cos(a) * r, MAX_GROUND_M + 500, Math.sin(a) * r), down);
      const hit = ray.intersectObject(tiles.group, true).find((h) => h.point.y > MIN_GROUND_M && h.point.y < MAX_GROUND_M);
      if (hit) hs.push(hit.point.y);
    }
    if (hs.length < 4) return;
    hs.sort((a, b) => a - b);
    const g = hs[Math.floor(hs.length * 0.25)];
    if (groundY === null || Math.abs(g - groundY) > 0.25) setGround(g);
  };

  // --- photoreal shots: house-only captures -> Gemini image edit (via serve.mjs) ---
  // Google tiles are hidden during capture: the model only ever sees OUR house on a neutral
  // backdrop, and gets the neighborhood as words. Restyling Google map imagery itself would be a
  // derivative of Maps content, which the Maps Platform terms don't allow.
  // A 360 turntable: RING frames evenly spaced around the house, every camera at the same height
  // and distance so the house stays put from frame to frame. All on the high-quality model; the
  // first (front three-quarter) frame renders first and is passed to every other frame as a
  // reference so materials, landscaping and light match all the way round.
  // off = degrees from the front-door direction; elev = camera pitch; fill = share of frame width.
  const RING = 16; // 22.5 deg apart: small enough steps that cross-fades read as turning
  const sideName = (off) => {
    const a = ((off % 360) + 360) % 360;
    return a < 22.5 || a >= 337.5 ? "front" : a < 67.5 ? "front-right corner" : a < 112.5 ? "right side" : a < 157.5 ? "back-right corner"
      : a < 202.5 ? "back" : a < 247.5 ? "back-left corner" : a < 292.5 ? "left side" : "front-left corner";
  };
  const SHOTS = Array.from({ length: RING }, (_, k) => {
    const off = 30 + k * (360 / RING);
    return { off, elev: 8, fill: 0.6, tier: "main", desc: `Photo from the ${sideName(off)} of the house, at the same distance and height as every other frame of a 360° turntable` };
  });
  // the photo skin (3D map view) has 6 projectors: use 6 evenly spaced ring frames
  const SKIN_FRAMES = Array.from({ length: 6 }, (_, k) => Math.round((k * RING) / 6));
  const skinSlot = (i) => SKIN_FRAMES.indexOf(i);
  let shotToken = 0, shotTimer = 0, renderReady = null, shotsBusy = false, lastShotError = null;
  const shotEls = [...ov.querySelectorAll(".shot")];
  const shotUrls = [];
  const captureAngles = () => {
    const { width_ft: W, depth_ft: D } = layout.footprint, e = layout.entrance;
    const y = groundY ?? 0, th = houseRoot.rotation.y;
    // Outward normal of the wall with the front door (plan: y grows south), in house-local x/z,
    // then rotated into world space (house is rotated by th about Y).
    const eps = 0.01;
    const [lx, lz] = Math.abs(e.y - D) < eps ? [0, 1] : Math.abs(e.y) < eps ? [0, -1] : Math.abs(e.x - W) < eps ? [1, 0] : [-1, 0];
    const base = Math.atan2(lx * Math.cos(th) + lz * Math.sin(th), -lx * Math.sin(th) + lz * Math.cos(th));
    const box = new THREE.Box3().setFromObject(houseRoot), center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const saved = { bg: scene.background, fog: scene.fog, tiles: tiles?.group.visible, lawn: lawn.parent };
    const ground = new THREE.Mesh(new THREE.CircleGeometry(80, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd4d3cf, roughness: 1 }));
    ground.position.y = y - 0.25; ground.receiveShadow = true;
    if (tiles) tiles.group.visible = false;
    if (lawn.parent) scene.remove(lawn);
    scene.add(ground); scene.background = new THREE.Color(0xe8e8e4); scene.fog = null;
    const cam = new THREE.PerspectiveCamera(42, 1.6, 0.3, 2000);
    ProjectionSkin.configureCamera(cam); // near/far tuned so the projector depth maps stay precise
    skin.enable(false); // capture the plain model, not last round's skin
    renderer.setSize(1024, 640, false);
    const hfov = 2 * Math.atan(Math.tan((cam.fov * DEG) / 2) * cam.aspect);
    const out = SHOTS.map((s, i) => {
      // distance so the house's bounding sphere spans `fill` of the frame width
      const a = base + s.off * DEG, el = s.elev * DEG, r = radius / Math.tan((hfov * s.fill) / 2);
      cam.position.set(center.x + Math.sin(a) * Math.cos(el) * r, Math.max(y + 1.6, center.y + Math.sin(el) * r), center.z + Math.cos(a) * Math.cos(el) * r);
      cam.lookAt(center.x, center.y - (s.elev > 10 ? 1 : 0.5), center.z); cam.updateMatrixWorld();
      renderer.render(scene, cam);
      const url = renderer.domElement.toDataURL("image/jpeg", 0.9); // read back in the same task as the render
      if (skinSlot(i) >= 0) skin.captureProjector(skinSlot(i), cam); // this exact camera becomes a projector
      return url;
    });
    scene.remove(ground); ground.geometry.dispose(); ground.material.dispose();
    scene.background = saved.bg; scene.fog = saved.fog;
    if (tiles) tiles.group.visible = saved.tiles;
    if (saved.lawn) scene.add(lawn);
    resize(); renderer.render(scene, camera);
    return out;
  };
  const setShot = (i, { busy = false, text = "", url = null }) => {
    const el = shotEls[i]; el.classList.toggle("busy", busy);
    el.querySelector("span").textContent = text;
    el.querySelector("img")?.remove();
    if (url) { const im = new Image(); im.src = url; im.alt = SHOTS[i].desc; el.prepend(im); }
    shotUrls[i] = url;
  };
  const runShots = async () => {
    const token = ++shotToken;
    shotUrls.length = 0; $(".fullview").disabled = true; shotsBusy = true;
    $(".shots").hidden = false;
    if (renderReady === null) renderReady = await fetch("/api/render/status").then((r) => r.json()).catch(() => ({ ready: false, offline: true }));
    if (!renderReady.ready) {
      shotsBusy = false; afterShots();
      $(".sstat").textContent = renderReady.offline ? "Run node design-mockups/serve.mjs to enable." : "Add GEMINI_API_KEY to design-mockups/.env.local and restart serve.mjs.";
      shotEls.forEach((_, i) => setShot(i, { text: "Not set up" }));
      return;
    }
    const where = (state.label || "").replace(/ \(moved\)$/, "").split(",").slice(1).map((x) => x.trim())
      .filter((x) => x && !/^\d{4,}$/.test(x) && x !== "United States").slice(0, 4).join(", ");
    const style = state.ext.style === "Custom" ? "custom-styled" : state.ext.style.toLowerCase();
    const images = captureAngles();
    $(".sstat").textContent = "Rendering…";
    let done = 0;
    lastShotError = null;
    images.forEach((_, i) => setShot(i, { busy: i === 0, text: i === 0 ? "Rendering" : "Queued" }));
    const progress = () => {
      $(".sstat").textContent = done === images.length ? "Done · click for 360°" : `Rendering… ${done}/${images.length}`;
      $(".gstat").textContent = `Generating photoreal 360° views… ${done}/${images.length}`;
      $(".gen .bar i").style.width = `${Math.round((done / images.length) * 100)}%`;
    };
    const renderOne = async (i, reference) => {
      if (token !== shotToken) return null;
      setShot(i, { busy: true, text: "Rendering" });
      const prompt = `Turn this plain 3D model render into a photorealistic architectural exterior photograph. ` +
        `Keep the house EXACTLY as modeled: same single-story footprint, roof shape and pitch, wall, trim and roof colors, ` +
        `window and door positions, and porch. Do not add floors, wings, garages or chimneys. ` +
        `Keep the camera framing exactly as given: the house must stay the same size and in the same place in the frame. ` +
        `Keep the whole house fully visible and unobstructed: no trees, branches, shrubs, cars or objects in front of or overhanging any part of it; keep landscaping beside and behind it, and low plantings below the windows only. ` +
        `Replace the plain gray backdrop and ground with a realistic setting: a ${style} home on a residential lot${where ? ` in ${where}` : ""}, ` +
        `with mature trees and shrubs typical of the area, a green lawn, a front walkway, and neighboring houses softly out of focus. ` +
        `${SHOTS[i].desc}. Soft late-afternoon sunlight, natural shadows, 35mm lens, high-end real estate photography. No text, watermarks or people.` +
        (reference ? ` The second image is a photo of this same house and yard from the front-right: match its siding, trim, roof material and color, windows, trees, landscaping, lighting and season exactly, as if taken on the same afternoon a few steps further around the house.` : "");
      try {
        const r = await fetch("/api/render", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: images[i], prompt, tier: SHOTS[i].tier, ...(reference ? { reference } : {}) }) });
        const data = await r.json();
        if (token !== shotToken) return null;
        if (!r.ok) throw new Error(data.error || r.statusText);
        setShot(i, { url: data.image });
        if (skinSlot(i) >= 0) {
          await skin.setImage(skinSlot(i), data.image);
          if (token === shotToken) { $(".skin").disabled = false; if ($(".skin").checked && !spin) skin.enable(true); }
        }
        return data.image;
      } catch (err) {
        lastShotError = String(err.message || err);
        if (token === shotToken) setShot(i, { text: lastShotError.slice(0, 60) });
        return null;
      } finally {
        if (token === shotToken) { done++; progress(); }
      }
    };
    // hero first (it is the reference for everything else), then the rest, 6 at a time
    const hero = await renderOne(0, null);
    const queue = images.map((_, i) => i).slice(1);
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length && token === shotToken) await renderOne(queue.shift(), hero);
    }));
    if (token !== shotToken) return;
    shotsBusy = false;
    $(".fullview").disabled = !shotUrls.some(Boolean);
    afterShots();
  };
  $(".skin").addEventListener("change", (e) => skin.enable(e.target.checked));
  const scheduleShots = () => { if (disposed) return; clearTimeout(shotTimer); shotTimer = setTimeout(() => { if (!disposed) runShots(); }, 400); };
  $(".rerender").addEventListener("click", runShots);
  // --- 360 view: photos only. The ring frames are shown full screen; moving the mouse left/right
  // scrubs around the house, cross-fading neighboring frames (all taken from the same distance and
  // height, so the house stays in place while the view turns). No Google mesh, no 3D model. ---
  const frameEls = [...ov.querySelectorAll(".spinbg")];
  let spin = null;
  const ringPos = (i) => i; // frame i sits at ring position i (30 deg steps)
  const nearestWithPhoto = (k) => {
    for (let d = 0; d < RING; d++) for (const j of [k + d, k - d]) { const i = ((j % RING) + RING) % RING; if (shotUrls[i]) return i; }
    return -1;
  };
  const enterSpin = (startShot = 0) => {
    if (!shotUrls.some(Boolean)) return false;
    spin = { pos: ringPos(startShot), vel: 0, target: ringPos(startShot), origin: ringPos(startShot) };
    controls.enabled = false;
    ov.classList.add("spinning");
    return true;
  };
  const exitSpin = () => {
    if (!spin) return;
    spin = null; ov.classList.remove("spinning");
    frameEls.forEach((el) => { el.style.opacity = 0; el.style.transform = ""; });
    controls.enabled = true; resetCamera(); // back to the close orbit view of the lot
    skin.enable($(".skin").checked);
  };
  const updateSpin = (dt) => {
    // critically damped spring toward the mouse target (shortest way round the ring): no snapping,
    // no overshoot, eases in and out like a camera dolly
    let d = spin.target - spin.pos; d -= Math.round(d / RING) * RING;
    const K = 38, C = 2 * Math.sqrt(K), h = Math.min(dt, 1 / 30);
    spin.vel += (K * d - C * spin.vel) * h;
    spin.pos += spin.vel * h;
    const p = ((spin.pos % RING) + RING) % RING, k = Math.floor(p), f = p - k;
    const a = nearestWithPhoto(k), b = nearestWithPhoto(k + 1);
    const t = f * f * f * (f * (6 * f - 15) + 10); // smootherstep: softer start/end of each blend
    // slight sideways drift while blending, so neighboring frames slide past like a turning camera
    const DRIFT = 2.4;
    [[a, 1, -t * DRIFT], [b, t, (1 - t) * DRIFT]].forEach(([i, o, x], n) => {
      const el = frameEls[n];
      if (i < 0) { el.style.opacity = 0; return; }
      if (el.dataset.i !== String(i)) { el.src = shotUrls[i]; el.dataset.i = String(i); }
      el.style.opacity = (n === 1 && a === b ? 0 : o).toFixed(3);
      el.style.transform = `translateX(${x.toFixed(2)}%) scale(${(1.03).toFixed(2)})`;
    });
  };
  ov.addEventListener("pointermove", (e) => {
    if (!spin || e.target.closest(".spinhud")) return;
    const r = ov.getBoundingClientRect();
    // one sweep across the screen = one full lap, centered on where we came in
    spin.target = spin.origin + ((e.clientX - r.left) / r.width - 0.5) * RING;
  });
  $(".explore").addEventListener("click", exitSpin);
  shotEls.forEach((el, i) => el.addEventListener("click", () => { if (shotUrls[i]) enterSpin(i); }));
  $(".fullview").addEventListener("click", () => enterSpin(0));

  // --- fly-in from space, then a blurred "generating" screen until the photos are ready ---
  let flight = null;
  const SKY = new THREE.Color(0xcfdcec), SPACE = new THREE.Color(0x04060c);
  const startFlight = () => {
    if (!tiles) return;
    exitSpin();
    flight = { t: 0, dur: 9 };
    controls.enabled = false;
    scene.fog = null;
    ov.classList.add("flying");
  };
  const updateFlight = (dt) => {
    flight.t += dt;
    const u = Math.min(1, flight.t / flight.dur);
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    const gy = groundY ?? 0, hTop = 1.8e7, hEnd = 140;
    // exponential descent: equal time per order of magnitude, like a real zoom from orbit
    const h = Math.exp(Math.log(hTop) + (Math.log(hEnd) - Math.log(hTop)) * e);
    const tiltIn = u < 0.6 ? 0 : ((u - 0.6) / 0.4) ** 2; // straight down from space, tilting to oblique at the end
    const horiz = h * (0.02 + 0.9 * tiltIn);
    camera.position.set(-0.68 * horiz, gy + h, -0.74 * horiz);
    camera.lookAt(0, gy, 0);
    const k = Math.max(0, Math.min(1, (Math.log(h) - Math.log(3e5)) / (Math.log(hTop) - Math.log(3e5))));
    scene.background = SKY.clone().lerp(SPACE, k);
    if (u >= 1) finishFlight();
  };
  const finishFlight = () => {
    flight = null;
    ov.classList.remove("flying");
    scene.background = SKY; scene.fog = new THREE.Fog(0xcfdcec, 1500, 9000);
    controls.target.set(0, (groundY ?? 0) + 3, 0);
    // at ~100 m the photo mesh turns soft: blur the screen while the photoreal views finish
    if (shotsBusy) $(".gen").classList.add("on");
    else afterShots();
  };
  const afterShots = () => {
    if (flight) return; // flight end will pick this up
    if (!shotUrls.some(Boolean) && lastShotError) {
      // nothing came back: say why on the loading card instead of silently dropping to the map
      const gen = $(".gen");
      gen.classList.add("on"); gen.querySelector(".ring").style.display = "none";
      gen.querySelector("b").textContent = "Couldn't generate the photoreal views";
      $(".gstat").textContent = /credit|billing|quota/i.test(lastShotError) ? `${lastShotError.slice(0, 140)} (check Gemini billing)` : lastShotError.slice(0, 160);
      setTimeout(() => {
        gen.classList.remove("on"); gen.querySelector(".ring").style.display = "";
        gen.querySelector("b").textContent = "Building your house on the lot";
      }, 6000);
      controls.enabled = true; resetCamera();
      return;
    }
    $(".gen").classList.remove("on");
    if (shotUrls.some(Boolean)) enterSpin(0);
    else if (!spin) { controls.enabled = true; resetCamera(); }
  };

  // --- auto-orientation from OpenStreetMap neighbors + street ---
  const setRotation = (theta) => {
    let deg = Math.round(((theta - Math.PI) / DEG) % 360);
    if (deg > 180) deg -= 360; if (deg < -180) deg += 360;
    state.rotationDeg = deg;
    range.value = deg; $(".deg").textContent = `${deg}°`;
    houseRoot.rotation.y = Math.PI + deg * DEG; applyFlatten();
  };
  let orientInfo = null;
  const houseVectors = () => {
    const { width_ft: W, depth_ft: D } = layout.footprint, e = layout.entrance, eps = 0.01;
    const [fx, fz] = Math.abs(e.y - D) < eps ? [0, 1] : Math.abs(e.y) < eps ? [0, -1] : Math.abs(e.x - W) < eps ? [1, 0] : [-1, 0];
    return { front: { x: fx, z: fz }, long: W >= D ? { x: 1, z: 0 } : { x: 0, z: 1 } };
  };
  const applyOrientation = () => {
    const syncBtns = () => ov.querySelectorAll("[data-orient]").forEach((b) => b.classList.toggle("on", b.dataset.orient === state.orient));
    syncBtns();
    if (state.orient === "manual" || !orientInfo) return;
    const { front, long } = houseVectors();
    const th = houseRotation(orientInfo, front, long, state.orient);
    if (th !== null) setRotation(th);
  };
  const autoOrient = async (loc, { snap = true } = {}) => {
    $(".ostat").textContent = "Checking how neighboring houses sit…";
    try {
      orientInfo = await neighborhoodOrientation(loc.lat, loc.lon);
      const o = orientInfo;
      // Replace the house that is there today: move onto its footprint's center (the geocoder
      // usually returns a point near the curb), before any photos are rendered.
      o.snapped = false;
      if (snap && o.lotCenter && Math.hypot(o.lotCenter.x, o.lotCenter.z) > 1) {
        state.lat = o.lotCenter.lat; state.lon = o.lotCenter.lon; o.snapped = true;
        $(".where").textContent = `${state.label}\n${state.lat.toFixed(5)}, ${state.lon.toFixed(5)} · on the existing house's footprint`;
        if (tiles) {
          reorient.lat = state.lat * DEG; reorient.lon = state.lon * DEG;
          reorient.transformLatLonHeightToOrigin(state.lat * DEG, state.lon * DEG, 0);
          groundY = null; gAge = 0; gT = 1; houseRoot.position.y = 0;
          if (shape) { flattener.deleteShape(shape); shape = null; }
        }
      } else if (o.lotCenter && Math.hypot(o.lotCenter.x, o.lotCenter.z) <= 1) o.snapped = true;
      $(".ostat").textContent = o.longAxis || o.toStreet
        ? `${o.snapped ? "Replacing the existing house (same spot and axis)" : `Lined up with ${o.nBuildings} nearby buildings`}${o.street ? `, facing ${o.street}` : ""}.`
        : "No nearby buildings or streets found; set it by hand.";
      applyOrientation();
      applyFlatten();
    } catch (err) {
      orientInfo = null;
      $(".ostat").textContent = `Couldn't read neighbors (${err.message}); set it by hand.`;
    }
  };

  const place = (loc, { fly = true, snap = true } = {}) => {
    Object.assign(state, loc);
    $(".where").textContent = `${loc.label}\n${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`;
    exitSpin();
    // orient first (renders depend on it for lighting), but never wait more than ~7 s for OSM
    Promise.race([autoOrient(loc, { snap }), new Promise((r) => setTimeout(r, 7000))]).then(scheduleShots);
    if (!tiles) return;
    reorient.lat = loc.lat * DEG; reorient.lon = loc.lon * DEG; // re-applied if the root tileset loads later
    reorient.transformLatLonHeightToOrigin(loc.lat * DEG, loc.lon * DEG, 0);
    tiles.group.visible = true;
    groundY = null; gAge = 0; gT = 1;
    if (shape) { flattener.deleteShape(shape); shape = null; }
    houseRoot.position.y = 0; resetCamera();
    $(".load").hidden = false; $(".hint").hidden = true;
    if (fly) startFlight();
  };

  // --- controls wiring ---
  const input = $("input[type=text]");
  input.value = state.label;
  $("form:not(.describe)").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $(".err"); err.hidden = true;
    try { place(await geocode(input.value)); } catch (x) { err.textContent = x.message; err.hidden = false; }
  });
  const range = $("input.rot");
  range.value = state.rotationDeg; $(".deg").textContent = `${state.rotationDeg}°`;
  range.addEventListener("input", () => {
    state.rotationDeg = Number(range.value); $(".deg").textContent = `${state.rotationDeg}°`;
    state.orient = "manual"; ov.querySelectorAll("[data-orient]").forEach((b) => b.classList.toggle("on", b.dataset.orient === "manual"));
    houseRoot.rotation.y = Math.PI + state.rotationDeg * DEG; applyFlatten();
  });
  // --- exterior editing: presets, roof, pitch, colors, porch, and a plain-English box ---
  $(".styles").innerHTML = Object.keys(STYLES).map((n) => `<button type="button" data-style="${n}">${n}</button>`).join("");
  const syncExt = () => {
    const x = state.ext;
    ov.querySelectorAll("[data-style]").forEach((b) => b.classList.toggle("on", b.dataset.style === x.style));
    ov.querySelectorAll("[data-roof]").forEach((b) => b.classList.toggle("on", b.dataset.roof === x.roof));
    ov.querySelectorAll("[data-porch]").forEach((b) => b.classList.toggle("on", b.dataset.porch === x.porch));
    ov.querySelectorAll("[data-c]").forEach((i) => { i.value = x[i.dataset.c]; });
    $(".pitch").value = x.pitch || 6; $(".pv").textContent = x.pitch; $(".pitchrow").hidden = x.roof === "flat";
  };
  const setExt = (patch) => { state.ext = { ...state.ext, ...patch }; syncExt(); rebuildHouse(); };
  const custom = (patch) => setExt({ ...patch, style: "Custom" });
  ov.querySelectorAll("[data-style]").forEach((b) => b.addEventListener("click", () => setExt({ ...STYLES[b.dataset.style], style: b.dataset.style })));
  ov.querySelectorAll("[data-roof]").forEach((b) => b.addEventListener("click", () => custom({ roof: b.dataset.roof, pitch: b.dataset.roof === "flat" ? 0 : state.ext.pitch || 6 })));
  ov.querySelectorAll("[data-porch]").forEach((b) => b.addEventListener("click", () => custom({ porch: b.dataset.porch })));
  ov.querySelectorAll("[data-c]").forEach((i) => i.addEventListener("input", () => custom({ [i.dataset.c]: i.value })));
  $(".pitch").addEventListener("input", (e) => custom({ pitch: Number(e.target.value) }));
  $(".describe").addEventListener("submit", (e) => {
    e.preventDefault();
    const box = $(".describe input"), msg = $(".ok");
    const { spec, changes } = parseExteriorPrompt(box.value, state.ext);
    msg.hidden = false;
    if (!changes.length) { msg.style.color = "#b26a00"; msg.textContent = "Didn't catch a style, roof, color or porch in that."; return; }
    msg.style.color = ""; msg.textContent = `Applied: ${changes.join(", ")}`;
    state.ext = spec; syncExt(); rebuildHouse(); box.value = "";
  });
  ov.querySelectorAll("[data-orient]").forEach((b) => b.addEventListener("click", () => { state.orient = b.dataset.orient; applyOrientation(); }));
  const flat = $("input.flat");
  flat.checked = state.flatten;
  flat.addEventListener("change", () => { state.flatten = flat.checked; applyFlatten(); });
  canvas.addEventListener("dblclick", (e) => {
    if (!tiles) return;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObject(tiles.group, true)[0];
    if (!hit) return;
    const c = tiles.ellipsoid.getPositionToCartographic(hit.point.clone().applyMatrix4(tiles.group.matrixWorld.clone().invert()), {});
    place({ lat: c.lat / DEG, lon: c.lon / DEG, label: state.label.replace(/ \(moved\)$/, "") + " (moved)" }, { fly: false, snap: false });
  });

  const resize = () => {
    const w = ov.clientWidth, h = ov.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.updateProjectionMatrix();
    tiles?.setResolutionFromRenderer(camera, renderer);
  };
  addEventListener("resize", resize);

  let attrKey = "", aT = 0, last = performance.now(), raf = 0;
  const frame = (now) => {
    if (disposed) return;
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    if (flight) updateFlight(dt);
    else if (spin) updateSpin(dt);
    else controls.update();
    camera.updateMatrixWorld();
    skin.update();
    if (tiles && tiles.group.visible) {
      tiles.update(); findGround(dt);
      if ((aT += dt) > 1) {
        aT = 0;
        const a = tiles.getAttributions().map((x) => ({ type: x.type, value: String(x.value) }));
        const k = JSON.stringify(a);
        if (k !== attrKey) {
          attrKey = k;
          $(".attr").replaceChildren(...a.map((x) => {
            if (x.type === "image") { const im = new Image(); im.src = x.value; im.alt = "Google"; return im; }
            const s = document.createElement("span"); s.textContent = x.value; return s;
          }));
        }
      }
    }
    if (!spin) renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };

  const close = () => {
    shotToken++; clearTimeout(shotTimer);
    disposed = true; cancelAnimationFrame(raf); removeEventListener("resize", resize); removeEventListener("keydown", onKey);
    controls.dispose(); skin.dispose(); tiles?.dispose(); renderer.dispose(); ov.remove();
  };
  const onKey = (e) => { if (e.key === "Escape") (spin ? exitSpin() : close()); };
  addEventListener("keydown", onKey);
  // Keep keystrokes in the overlay away from the mockup underneath (WASD walkers, shortcuts).
  for (const t of ["keydown", "keyup", "keypress"]) ov.addEventListener(t, (e) => { if (t === "keydown" && e.key === "Escape") (spin ? exitSpin() : close()); e.stopPropagation(); });
  $(".close").addEventListener("click", close);

  syncExt(); rebuildHouse(); resize(); resetCamera();
  raf = requestAnimationFrame(frame);
  if (state.lat !== null) place({ lat: state.lat, lon: state.lon, label: state.label });
  else input.focus();
}

/**
 * Adds an "On site" button right after a page's Walk through button, copying its classes so it
 * matches each mockup's look, and mirroring its disabled state.
 */
export function addSiteButton(walkBtn, getLayout, { label = "On site" } = {}) {
  if (!walkBtn) return null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = walkBtn.className;
  for (const a of ["role", "data-tab"]) if (walkBtn.hasAttribute(a)) b.setAttribute(a, a === "data-tab" ? "site" : walkBtn.getAttribute(a));
  b.textContent = label;
  b.title = "Place this house on a real street in Google 3D";
  // Flex/grid parents space their own children; plain flow needs a gap.
  if (!/flex|grid/.test(getComputedStyle(walkBtn.parentElement).display)) b.style.marginLeft = "8px";
  const sync = () => { b.disabled = walkBtn.disabled; };
  new MutationObserver(sync).observe(walkBtn, { attributes: true, attributeFilter: ["disabled"] });
  sync();
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openSiteView(getLayout()); });
  walkBtn.after(b);
  return b;
}
