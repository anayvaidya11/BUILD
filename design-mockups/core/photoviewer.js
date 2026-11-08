// Full-screen viewer that joins the photoreal shots into one navigable view.
//
// The shots are ordered by where their camera stood around the house, so moving through them
// walks you around it: drag sideways (or use the arrows / arrow keys) to cross-fade continuously
// from one viewpoint to the next, with a slight slide so it reads as movement. It wraps around,
// so you can keep circling. Scroll or pinch to zoom, drag to pan while zoomed, double-click to
// toggle 2x. Esc closes.

const CSS = `
.phv{position:absolute;inset:0;z-index:20;background:#0b0b0c;overflow:hidden;touch-action:none;user-select:none;cursor:grab;color:#fff;font:13px/1.4 inherit}
.phv.drag{cursor:grabbing}
.phv .stage{position:absolute;inset:0;transform-origin:0 0;will-change:transform}
.phv .stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;will-change:opacity,transform}
.phv .bar{position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:linear-gradient(#000a,#0000);pointer-events:none}
.phv .bar > *{pointer-events:auto}
.phv .cap{font-weight:600}.phv .cap small{display:block;font-weight:400;opacity:.75}
.phv .acts{display:flex;gap:8px}
.phv button,.phv a.btn{font:inherit;cursor:pointer;border:1px solid #fff4;background:#0006;color:#fff;border-radius:999px;padding:7px 13px;text-decoration:none;backdrop-filter:blur(6px)}
.phv button:hover,.phv a.btn:hover{background:#fff2}
.phv .nav{position:absolute;top:50%;transform:translateY(-50%);width:48px;height:48px;padding:0;font-size:22px;display:grid;place-items:center}
.phv .prev{left:16px}.phv .next{right:16px}
.phv .foot{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;background:#0007;padding:6px 10px;border-radius:999px;backdrop-filter:blur(6px)}
.phv .dot{width:54px;height:34px;border-radius:6px;overflow:hidden;padding:0;border:2px solid transparent;opacity:.6}
.phv .dot.on{border-color:#fff;opacity:1}
.phv .dot img{width:100%;height:100%;object-fit:cover;display:block}
.phv .hint{position:absolute;right:16px;bottom:20px;font-size:11px;opacity:.6}
`;

export function openPhotoViewer(host, shots, startIndex = 0) {
  if (!document.getElementById("phv-css")) {
    const st = document.createElement("style"); st.id = "phv-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  // order around the house by camera azimuth so "next" means "walk further around"
  const list = shots.map((s, i) => ({ ...s, i })).filter((s) => s.url).sort((a, b) => a.azimuth - b.azimuth);
  if (!list.length) return null;
  const n = list.length;
  let pos = Math.max(0, list.findIndex((s) => s.i === startIndex)); // continuous index
  let zoom = 1, panX = 0, panY = 0, anim = 0;

  const el = document.createElement("div");
  el.className = "phv"; el.tabIndex = 0;
  el.innerHTML = `
    <div class="stage">${list.map((s) => `<img src="${s.url}" alt="${s.title}" draggable="false" />`).join("")}</div>
    <div class="bar"><div class="cap"></div><div class="acts"><a class="btn dl" download>Download</a><button type="button" class="x">Close ✕</button></div></div>
    ${n > 1 ? `<button type="button" class="nav prev" aria-label="Previous view">‹</button><button type="button" class="nav next" aria-label="Next view">›</button>` : ""}
    <div class="foot">${list.map((s, k) => `<button type="button" class="dot" data-k="${k}" aria-label="${s.title}"><img src="${s.url}" alt="" /></button>`).join("")}</div>
    <div class="hint">Drag or ← → to walk around · scroll to zoom · double-click 2×</div>`;
  host.appendChild(el);
  el.focus();
  const stage = el.querySelector(".stage"), imgs = [...stage.querySelectorAll("img")], dots = [...el.querySelectorAll(".dot")];

  const wrap = (k) => ((k % n) + n) % n;
  const clampPan = () => {
    const w = el.clientWidth, h = el.clientHeight;
    panX = Math.min(0, Math.max(w - w * zoom, panX)); panY = Math.min(0, Math.max(h - h * zoom, panY));
  };
  const draw = () => {
    const base = Math.floor(pos), f = pos - base, a = wrap(base), b = wrap(base + 1);
    imgs.forEach((im, k) => {
      let o = 0, x = 0;
      if (k === a) { o = 1; x = -f * 4; }            // current view slides away...
      if (k === b && n > 1) { o = f; x = (1 - f) * 4; } // ...as the next one fades in from the side
      im.style.opacity = o; im.style.zIndex = k === b ? 2 : 1;
      im.style.transform = `translateX(${x}%) scale(${1 + 0.03 * (k === a ? f : 1 - f)})`;
    });
    clampPan();
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const cur = list[wrap(Math.round(pos))];
    el.querySelector(".cap").innerHTML = `${cur.title}<small>${wrap(Math.round(pos)) + 1} of ${n}</small>`;
    const dl = el.querySelector(".dl"); dl.href = cur.url; dl.download = `walkthru-view-${cur.i + 1}.png`;
    dots.forEach((d, k) => d.classList.toggle("on", k === wrap(Math.round(pos))));
  };
  const goTo = (target) => {
    cancelAnimationFrame(anim);
    const from = pos, t0 = performance.now(), dur = 420;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      pos = from + (target - from) * e; draw();
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  };
  const step = (d) => goTo(Math.round(pos) + d);
  const setZoom = (z, cx = el.clientWidth / 2, cy = el.clientHeight / 2) => {
    const nz = Math.min(4, Math.max(1, z));
    panX = cx - ((cx - panX) / zoom) * nz; panY = cy - ((cy - panY) / zoom) * nz; zoom = nz; draw();
  };

  // drag: sideways = walk between views (when not zoomed), otherwise pan
  let drag = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, a")) return;
    cancelAnimationFrame(anim);
    drag = { x: e.clientX, y: e.clientY, pos, panX, panY, moved: false };
    el.setPointerCapture(e.pointerId); el.classList.add("drag");
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (zoom > 1.01) { panX = drag.panX + dx; panY = drag.panY + dy; }
    else if (n > 1) pos = drag.pos - (dx / el.clientWidth) * 1.6;
    draw();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null; el.classList.remove("drag");
    if (zoom <= 1.01) goTo(Math.round(pos));
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  el.addEventListener("dblclick", (e) => {
    const r = el.getBoundingClientRect();
    setZoom(zoom > 1.01 ? 1 : 2, e.clientX - r.left, e.clientY - r.top);
  });
  el.querySelector(".prev")?.addEventListener("click", () => step(-1));
  el.querySelector(".next")?.addEventListener("click", () => step(1));
  dots.forEach((d) => d.addEventListener("click", () => {
    const k = Number(d.dataset.k), cur = wrap(Math.round(pos));
    let delta = k - cur; if (delta > n / 2) delta -= n; if (delta < -n / 2) delta += n; // shortest way round
    goTo(Math.round(pos) + delta);
  }));
  const close = () => { cancelAnimationFrame(anim); el.remove(); removeEventListener("resize", draw); };
  el.querySelector(".x").addEventListener("click", close);
  el.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep keys away from the 3D view and the mockup underneath
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "+" || e.key === "=") setZoom(zoom * 1.25);
    else if (e.key === "-") setZoom(zoom / 1.25);
    else if (e.key === "0") { zoom = 1; panX = panY = 0; draw(); }
  });
  addEventListener("resize", draw);
  draw();
  return { close, el };
}
