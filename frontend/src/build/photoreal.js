// build — photoreal walkthrough. Sends the current house (layout + the furniture exactly as the user
// arranged it) to the local render bridge (render/bridge.py), which renders one Blender Cycles 360°
// panorama per room on Modal GPUs in parallel. Renders start automatically when a house is built;
// the tour viewer (Pannellum) fills in room by room as panoramas arrive.
//
// Usage in a mockup (next to its Walk through button):
//   addPhotorealButton(walkBtn, () => ({ layout, furniture }))
import * as THREE from "three";

const BRIDGE = process.env.NEXT_PUBLIC_RENDER_BRIDGE || "http://127.0.0.1:8790";
const PANNELLUM = "https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/";

// ---------- scene export (plan feet; x east, y south, z up) ----------
export function exportScene(layout, furniture) {
  const W = layout.footprint.width_ft, D = layout.footprint.depth_ft;
  furniture.group.updateMatrixWorld(true);
  const inv = furniture.group.matrixWorld.clone().invert(), m = new THREE.Matrix4(), bb = new THREE.Box3();
  const parts = [], itemsMap = new Map();
  const itemOf = (o) => { while (o && o.userData?.kind !== "item") o = o.parent; return o; };
  const hex = (c) => "#" + c.getHexString();
  for (const mesh of furniture.pieces) {
    if (!mesh.parent || !mesh.visible || !mesh.geometry) continue;
    mesh.geometry.computeBoundingBox();
    bb.copy(mesh.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, mesh.matrixWorld));
    const it = itemOf(mesh);
    const room = it?.userData.roomId ?? mesh.userData.roomId;
    const item = mesh.userData.item ?? mesh.userData.name;
    const col = mesh.material?.color ? hex(mesh.material.color) : "#cccccc";
    const p = {
      room, item, name: mesh.userData.name, colorKey: mesh.userData.colorKey ?? "fabric", color: col,
      round: mesh.geometry.type === "RoundedBoxGeometry" ? (mesh.geometry.parameters?.radius ?? 0.1) : 0,
      min: [bb.min.x + W / 2, bb.min.z + D / 2, Math.max(0, bb.min.y)].map((v) => +v.toFixed(3)),
      max: [bb.max.x + W / 2, bb.max.z + D / 2, bb.max.y].map((v) => +v.toFixed(3)),
    };
    // min/max as [x, y, z] in plan feet
    p.min = [p.min[0], p.min[1], p.min[2]]; p.max = [p.max[0], p.max[1], p.max[2]];
    parts.push(p);
    const k = `${room}|${item}`;
    if (!itemsMap.has(k)) itemsMap.set(k, { room, item, name: it?.userData.name ?? p.name, parts: [] });
    itemsMap.get(k).parts.push(p);
  }
  const items = [...itemsMap.values()].map((it) => {
    const x0 = Math.min(...it.parts.map((p) => p.min[0])), x1 = Math.max(...it.parts.map((p) => p.max[0]));
    const y0 = Math.min(...it.parts.map((p) => p.min[1])), y1 = Math.max(...it.parts.map((p) => p.max[1]));
    const c = [(x0 + x1) / 2, (y0 + y1) / 2];
    // facing: away from a back/headboard part, otherwise toward the room centre
    const back = it.parts.find((p) => /back|headboard/.test(p.name) && p.name !== "chair back");
    let f;
    if (back) { const bc = [(back.min[0] + back.max[0]) / 2, (back.min[1] + back.max[1]) / 2]; f = [c[0] - bc[0], c[1] - bc[1]]; }
    else { const r = layout.rooms.find((q) => q.id === it.room); f = r ? [r.x + r.w / 2 - c[0], r.y + r.h / 2 - c[1]] : [0, 1]; }
    // snap to the dominant axis (furniture is placed square to the walls)
    f = Math.abs(f[0]) > Math.abs(f[1]) ? [Math.sign(f[0]) || 1, 0] : [0, Math.sign(f[1]) || 1];
    return { room: it.room, item: it.item, name: it.name, center: c.map((v) => +v.toFixed(3)), size: [+(x1 - x0).toFixed(3), +(y1 - y0).toFixed(3)], front: f };
  });
  const lay = { footprint: layout.footprint, entrance: layout.entrance, rooms: layout.rooms, doors: layout.doors, windows: layout.windows, open: layout.open ?? [] };
  return { layout: lay, parts, items };
}

// ---------- bridge client ----------
async function bridge(path, body) {
  const r = await fetch(BRIDGE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!r.ok && r.status !== 404) throw new Error(`bridge ${r.status}`);
  return r.json();
}
export async function bridgeOnline(timeoutMs = 6000) {
  try { const c = new AbortController(); setTimeout(() => c.abort(), timeoutMs); const r = await fetch(BRIDGE + "/health", { signal: c.signal }); return r.ok; } catch { return false; }
}

// ---------- styles ----------
let cssDone = false;
function css() {
  if (cssDone) return; cssDone = true;
  const s = document.createElement("style");
  s.textContent = `
  .pr-chip{font:inherit;display:inline-flex;align-items:center;gap:8px}
  .pr-dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.35;flex:none}
  .pr-chip[data-state=rendering] .pr-dot{opacity:1;animation:prp 1.1s ease-in-out infinite}
  .pr-chip[data-state=done] .pr-dot{opacity:1;background:#3ccf8e}
  .pr-chip[data-state=stale] .pr-dot{opacity:1;background:#f0b44c}
  .pr-chip[data-state=offline] .pr-dot{opacity:.5;background:#999}
  @keyframes prp{50%{transform:scale(.55);opacity:.4}}
  #pr{position:fixed;inset:0;z-index:9000;background:#0b0c10;color:#f2f2f4;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;display:none}
  #pr.open{display:block;animation:prin .35s ease}
  @keyframes prin{from{opacity:0}to{opacity:1}}
  #pr-pano{position:absolute;inset:0}
  #pr .pr-hud{position:absolute;z-index:3;background:rgba(14,15,20,.72);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:14px}
  #pr-top{top:16px;left:16px;padding:12px 16px;max-width:min(520px,60vw)}
  #pr-top b{display:block;font-size:17px;letter-spacing:-.01em}
  #pr-top span{color:#a7a9b4;font-size:12.5px}
  #pr-close{top:16px;right:16px;padding:9px 14px;cursor:pointer;color:inherit;font:inherit}
  #pr-close:focus-visible,#pr button:focus-visible{outline:2px solid #6c80ff;outline-offset:2px}
  #pr-rooms{right:16px;top:70px;bottom:16px;width:220px;padding:10px;overflow:auto;display:flex;flex-direction:column;gap:8px}
  #pr-rooms button{all:unset;cursor:pointer;display:grid;grid-template-columns:64px 1fr;gap:10px;align-items:center;padding:6px;border-radius:10px}
  #pr-rooms button:hover,#pr-rooms button[aria-current=true]{background:rgba(255,255,255,.08)}
  #pr-rooms button[disabled]{cursor:default;opacity:.75}
  #pr-rooms .th{width:64px;height:32px;border-radius:6px;background:#1b1d26 center/cover;position:relative;overflow:hidden}
  #pr-rooms .th i{position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent);animation:prs 1.4s linear infinite}
  @keyframes prs{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
  #pr-rooms small{display:block;color:#a7a9b4;font-size:11.5px}
  #pr-map{left:16px;bottom:16px;padding:10px;width:230px}
  #pr-map svg{display:block;width:100%;height:auto}
  #pr-wait{position:absolute;inset:0;display:grid;place-items:center;z-index:2;text-align:center;padding:24px}
  #pr-wait .card{max-width:440px}
  #pr-wait h2{margin:0 0 6px;font-size:22px;letter-spacing:-.02em}
  #pr-wait p{color:#a7a9b4;margin:0 0 14px}
  #pr-wait .bar{height:4px;border-radius:4px;background:#22242e;overflow:hidden}
  #pr-wait .bar i{display:block;height:100%;background:#6c80ff;transition:width .6s ease}
  #pr .pr-hs{width:46px;height:46px;border-radius:50%;background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.85);backdrop-filter:blur(4px);cursor:pointer;transition:background .2s,box-shadow .2s}
  #pr .pr-hs:hover{background:rgba(108,128,255,.55);box-shadow:0 0 0 6px rgba(108,128,255,.25)}
  #pr .pr-hs::after{content:"";position:absolute;left:50%;top:50%;width:12px;height:12px;border-left:3px solid #fff;border-top:3px solid #fff;transform:translate(-50%,-30%) rotate(45deg)}
  #pr .pr-hs span{position:absolute;bottom:54px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(14,15,20,.8);padding:4px 10px;border-radius:8px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none}
  #pr .pr-hs:hover span{opacity:1}
  #pr .pr-hs.pending{opacity:.45;cursor:default}
  @media (max-width:720px){#pr-rooms{top:auto;left:16px;right:16px;bottom:16px;width:auto;height:96px;flex-direction:row;overflow-x:auto}#pr-rooms button{grid-template-columns:1fr}#pr-map{display:none}}
  @media (prefers-reduced-motion:reduce){#pr.open,.pr-chip .pr-dot,#pr-rooms .th i{animation:none}}`;
  document.head.appendChild(s);
}
function loadPannellum() {
  if (window.pannellum) return Promise.resolve();
  return new Promise((res, rej) => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = PANNELLUM + "pannellum.css"; document.head.appendChild(l);
    const s = document.createElement("script"); s.src = PANNELLUM + "pannellum.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}

// ---------- controller (one per page) ----------
function createController(getScene) {
  let job = null, poll = 0, sceneKey = null, stale = false, online = null, viewer = null, current = null, arrSig = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f());
  const keyOf = (s) => JSON.stringify(s.layout.rooms.map((r) => [r.id, r.x, r.y, r.w, r.h]));
  const counts = () => { const n = Object.values(job?.nodes ?? {}); return { done: n.filter((x) => x.state === "done").length, total: n.length }; };

  let onlineAt = 0;
  async function start(quality = "auto") {
    // a hosted bridge can be slow to answer right after a deploy: re-probe every 10 s instead of
    // treating one failed probe as "offline" for the rest of the session
    if (online !== true && Date.now() - onlineAt > 10000) { onlineAt = Date.now(); online = await bridgeOnline(); }
    if (!online) { emit(); return; }
    const { layout, furniture } = getScene();
    const payload = { ...exportScene(layout, furniture), quality };
    sceneKey = keyOf(payload); stale = false; arrSig = JSON.stringify(furniture.getArrangement?.() ?? []);
    job = await bridge("/render", payload);
    emit(); tick();
  }
  async function tick() {
    clearTimeout(poll);
    if (!job) return;
    try {
      const j = await bridge(`/render/${job.job}`);
      if (!j?.job) { job = null; return start(); } // the bridge restarted and forgot this job: send it again
      job = j;
    } catch { /* bridge restarting: keep polling */ }
    emit(); syncViewer();
    if (job.status === "rendering" || job.status === "refining") poll = setTimeout(tick, 2500);
  }
  function label() {
    if (online === false) return { state: "offline", text: "Photoreal offline" };
    if (!job) return { state: "idle", text: "Photoreal" };
    const { done, total } = counts();
    if (stale) return { state: "stale", text: "Photoreal · re-render" };
    if (job.status === "rendering") return { state: "rendering", text: `Photoreal · ${done}/${total} rooms` };
    if (job.status === "refining") {
      const sharp = Object.values(job.nodes).filter((n) => n.hq).length;
      return { state: "rendering", text: `Photoreal · sharpening ${sharp}/${total}` };
    }
    return { state: "done", text: "Photoreal tour" };
  }

  // ----- overlay -----
  let el;
  function ensureOverlay() {
    if (el) return el;
    css();
    el = document.createElement("div"); el.id = "pr"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Photoreal walkthrough");
    el.innerHTML = `<div id="pr-pano"></div>
      <div id="pr-wait"><div class="card"><h2>Rendering your house in Blender Cycles</h2>
        <p>Each room renders on its own GPU with real light bouncing off the walls and furniture. A quick preview of each room lands in under a minute, then a 4K pass sharpens it in place.</p>
        <div class="bar"><i style="width:4%"></i></div><p id="pr-waitn" style="margin-top:10px"></p></div></div>
      <div class="pr-hud" id="pr-top"><b id="pr-title">Photoreal walkthrough</b><span id="pr-sub">Drag to look around · click the arrows to walk</span></div>
      <button class="pr-hud" id="pr-close" type="button">Close</button>
      <div class="pr-hud" id="pr-rooms" aria-label="Rooms"></div>
      <div class="pr-hud" id="pr-map"></div>`;
    document.body.appendChild(el);
    el.querySelector("#pr-close").addEventListener("click", close);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && el.classList.contains("open")) close(); });
    return el;
  }
  async function open() {
    ensureOverlay(); el.classList.add("open");
    if (!job) await start();
    if (!job && online === false) {
      el.querySelector("#pr-wait h2").textContent = "The photoreal renderer isn't running";
      el.querySelector("#pr-wait p").innerHTML = "Start it from the BUILD folder with <code>python3 render/bridge.py</code>, then press Photoreal again.";
      return;
    }
    await loadPannellum();
    syncViewer(true);
    el.querySelector("#pr-close").focus();
  }
  function close() { el?.classList.remove("open"); }

  const hs = (link, ready) => ({
    pitch: link.pitch, yaw: link.yaw, type: ready ? "scene" : "info", sceneId: ready ? link.to : undefined,
    cssClass: "pr-hs" + (ready ? "" : " pending"), id: `to-${link.to}`,
    createTooltipFunc: (div) => { const s = document.createElement("span"); s.textContent = ready ? link.label : `${link.label} · rendering`; div.appendChild(s); },
  });
  function sceneConfig(id, extra = {}) {
    const s = job.tour.scenes[id], n = job.nodes[id];
    return { type: "equirectangular", panorama: new URL(n.url, location.href).href, hfov: 90, yaw: s.links[0]?.yaw ?? 0, pitch: -4,
      hotSpots: s.links.map((l) => hs(l, job.nodes[l.to]?.state === "done")), ...extra };
  }
  const added = new Set(), shown = {};
  function syncViewer(force) {
    if (!el?.classList.contains("open") || !job || !window.pannellum) { renderSide(); return; }
    const ready = Object.entries(job.nodes).filter(([, n]) => n.state === "done").map(([id]) => id);
    const { done, total } = counts();
    el.querySelector("#pr-wait").style.display = ready.length ? "none" : "grid";
    el.querySelector("#pr-wait .bar i").style.width = `${Math.max(4, (done / Math.max(1, total)) * 100)}%`;
    el.querySelector("#pr-waitn").textContent = `${done} of ${total} rooms rendered`;
    if (ready.length && !viewer) {
      const first = ready.includes(job.tour.start) ? job.tour.start : ready[0];
      const scenes = {}; for (const id of ready) { scenes[id] = sceneConfig(id); added.add(id); shown[id] = job.nodes[id].url; }
      viewer = pannellum.viewer(el.querySelector("#pr-pano"), { default: { firstScene: first, sceneFadeDuration: 900, autoLoad: true, showControls: false }, scenes });
      current = first;
      viewer.on("scenechange", (id) => { current = id; renderSide(); });
      // Pannellum 2.5 sizes its canvas in CSS pixels, so Retina screens get half the detail. Measure
      // what it did and lay the container out larger, scaled back down, so one texel maps to one pixel.
      viewer.on("load", () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2), c = el.querySelector("#pr-pano canvas"), box = el.querySelector("#pr-pano");
        if (!c || dpr <= 1 || box.dataset.dpr) return;
        const need = dpr / (c.width / Math.max(1, c.clientWidth));
        if (need > 1.05) {
          box.dataset.dpr = "1";
          Object.assign(box.style, { width: `${100 * need}%`, height: `${100 * need}%`, transform: `scale(${1 / need})`, transformOrigin: "0 0" });
          viewer.resize();
        }
      });
    } else if (viewer) {
      // 4K pass landed for a room already in the tour: swap the image in place, keep the view
      for (const id of ready) if (added.has(id) && shown[id] !== job.nodes[id].url) {
        shown[id] = job.nodes[id].url;
        // no crossfade for the swap: Pannellum's fade snapshots the canvas to an <img>, which fails on
        // high-DPI canvases and leaves a blank layer over the view
        viewer.addScene(id, sceneConfig(id, { sceneFadeDuration: 0 }));
        if (id === current) viewer.loadScene(id, viewer.getPitch(), viewer.getYaw(), viewer.getHfov());
      }
      for (const id of ready) if (!added.has(id)) {
        viewer.addScene(id, sceneConfig(id)); added.add(id); shown[id] = job.nodes[id].url;
        // upgrade "rendering" hotspots that point at the new room
        for (const other of added) {
          if (other === id) continue;
          const link = job.tour.scenes[other].links.find((l) => l.to === id); if (!link) continue;
          try { viewer.removeHotSpot(`to-${id}`, other); } catch {}
          viewer.addHotSpot(hs(link, true), other);
        }
      }
    }
    renderSide();
  }
  function renderSide() {
    if (!el || !job) return;
    const list = el.querySelector("#pr-rooms");
    list.innerHTML = Object.entries(job.tour.scenes).map(([id, s]) => {
      const n = job.nodes[id], d = n.state === "done";
      const secs = n.started && !d ? Math.round(Date.now() / 1000 - n.started) : null;
      const sub = d ? (n.hq ? `4K · ${n.hq_seconds ?? ""} s on GPU` : n.hq_state === "rendering" || n.hq_state === "queued" ? "preview · sharpening" : `${n.seconds ?? ""} s on GPU`) : n.state === "error" ? "failed" : n.state === "rendering" ? `rendering${secs ? ` · ${secs}s` : ""}` : "queued";
      return `<button type="button" data-id="${id}" ${d ? "" : "disabled"} aria-current="${id === current}"><div class="th" style="${d ? `background-image:url(${n.url})` : ""}">${d ? "" : "<i></i>"}</div><div>${s.label}<small>${sub}</small></div></button>`;
    }).join("");
    list.querySelectorAll("button:not([disabled])").forEach((b) => b.addEventListener("click", () => viewer?.loadScene(b.dataset.id)));
    // minimap (Blender metres; plan rects are in x east / y south metres)
    const [Wm, Dm] = job.tour.size, pad = 0.4;
    const rooms = job.tour.rooms.map(([x0, y0, x1, y1]) => `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#1b1d26" stroke="#6b6e7c" stroke-width=".05"/>`).join("");
    const dots = Object.entries(job.tour.scenes).map(([id, s]) => {
      const st = job.nodes[id].state, x = s.x, y = Dm - s.y;
      const fill = id === current ? "#6c80ff" : st === "done" ? "#f2f2f4" : "none";
      return `<circle cx="${x}" cy="${y}" r="${id === current ? 0.42 : 0.3}" fill="${fill}" stroke="#f2f2f4" stroke-width=".06" ${st === "done" ? `style="cursor:pointer" data-id="${id}"` : 'opacity=".55"'}/>`;
    }).join("");
    el.querySelector("#pr-map").innerHTML = `<svg viewBox="${-pad} ${-pad} ${Wm + 2 * pad} ${Dm + 2 * pad}">${rooms}${dots}</svg>`;
    el.querySelectorAll("#pr-map circle[data-id]").forEach((c) => c.addEventListener("click", () => viewer?.loadScene(c.dataset.id)));
    if (current) el.querySelector("#pr-title").textContent = job.tour.scenes[current]?.label ?? "Photoreal walkthrough";
  }

  return {
    start, open, close, label, counts,
    on: (f) => (listeners.add(f), () => listeners.delete(f)),
    // a new house: render automatically once per distinct layout
    async auto() {
      const s = getScene(); if (!s?.layout || !s?.furniture) return;
      const key = keyOf({ layout: s.layout });
      if (key === sceneKey && job) return;
      if (online !== true && Date.now() - onlineAt <= 10000) return; // probe cooldown
      viewer?.destroy?.(); viewer = null; added.clear(); current = null;
      await start("auto");
    },
    // furniture moved after a render: offer a re-render instead of spending GPU time on every drag
    markStale() { if (job) { stale = true; emit(); } },
    checkStale() {
      if (!job || stale) return;
      const f = getScene()?.furniture; if (!f?.getArrangement) return;
      if (JSON.stringify(f.getArrangement()) !== arrSig) { stale = true; emit(); }
    },
    async rerender() { viewer?.destroy?.(); viewer = null; added.clear(); current = null; await start("auto"); },
    get job() { return job; },
  };
}

// ---------- button next to "Walk through" ----------
// Starts rendering automatically when the house is ready (the walk button becomes visible + enabled).
export function addPhotorealButton(walkBtn, getScene, { auto = true } = {}) {
  if (!walkBtn) return null;
  css();
  const ctl = createController(getScene);
  const b = document.createElement("button");
  b.type = "button"; b.className = walkBtn.className + " pr-chip";
  for (const a of ["role"]) if (walkBtn.hasAttribute(a)) b.setAttribute(a, walkBtn.getAttribute(a));
  b.innerHTML = `<i class="pr-dot" aria-hidden="true"></i><span>Photoreal</span>`;
  b.title = "Blender Cycles 360° walkthrough of this house";
  if (!/flex|grid/.test(getComputedStyle(walkBtn.parentElement).display)) b.style.marginLeft = "8px";
  const paint = () => { const l = ctl.label(); b.dataset.state = l.state; b.querySelector("span").textContent = l.text; };
  ctl.on(paint); paint();
  b.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (ctl.label().state === "stale") { await ctl.rerender(); }
    ctl.open();
  });
  walkBtn.after(b);
  const sync = () => { b.disabled = walkBtn.disabled; };
  new MutationObserver(sync).observe(walkBtn, { attributes: true, attributeFilter: ["disabled"] });
  sync();
  if (auto) {
    // when the walk button is shown and enabled (= the house finished building), render each new layout
    // once (a generate or an edit); furniture moves only mark the tour stale. Cheap 2 s poll.
    let ready = 0;
    setInterval(() => {
      const visible = walkBtn.offsetParent !== null && getComputedStyle(walkBtn).visibility !== "hidden";
      ready = visible && !walkBtn.disabled ? ready + 1 : 0;
      if (ready >= 2) { ctl.auto(); ctl.checkStale(); }
    }, 2000);
  }
  b.photoreal = ctl;
  return b;
}
