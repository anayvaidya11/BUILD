// build — drag-and-drop furniture.
// Requires furniture built with buildFurniture(..., { items: true }). Pick an item up (it lifts and casts a
// footprint ring), drag it anywhere in the house — into another room too — then drop it (it lands with a
// small bounce). R rotates 90° (while dragging or hovering), Esc cancels a drag. Motion is smoothed with a
// critically damped follow plus a slight tilt in the direction of travel, so pieces feel physical.
import * as THREE from "three";
import { smoothDamp, tween, ease } from "./core.js";

export function createFurnitureDrag({
  camera, dom, furniture, layout, controls = null, grid = 0.5, liftHeight = 1.3,
  ringColor = 0x2b45f5, okColor = 0x2b45f5, onPick, onMove, onDrop, onHover,
} = {}) {
  let F = furniture, L = layout, enabled = true;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(), hitW = new THREE.Vector3();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // footprint ring (rounded rectangle) shown under hovered / dragged items
  const ringGeo = (() => {
    const s = new THREE.Shape(), r = 0.18, w = 1, h = 1, x = -0.5, y = -0.5;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    const g = new THREE.ShapeGeometry(s, 6); g.rotateX(-Math.PI / 2); return g;
  })();
  const ringMat = new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat); ring.renderOrder = 2; ring.position.y = 0.06; ring.visible = false;
  F.group.add(ring);
  const edgeMat = new THREE.LineBasicMaterial({ color: ringColor, transparent: true, opacity: 0 });
  const edge = new THREE.LineLoop(new THREE.EdgesGeometry(ringGeo), edgeMat); ring.add(edge);

  let hover = null, drag = null, ringOpacity = 0, ringTarget = 0;
  const pos = new THREE.Vector3(), target = new THREE.Vector3();
  const vx = {}, vz = {}, vy = {}, vr = {};

  const itemOf = (o) => { while (o && o.userData?.kind !== "item") o = o.parent; return o; };
  const localExtents = (item) => {
    const b = new THREE.Box3(), t = new THREE.Box3(), inv = new THREE.Matrix4().copy(item.matrixWorld).invert(), m = new THREE.Matrix4();
    item.updateMatrixWorld(true);
    item.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); t.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)); b.union(t); } });
    return { hx: (b.max.x - b.min.x) / 2, hz: (b.max.z - b.min.z) / 2, cx: (b.max.x + b.min.x) / 2, cz: (b.max.z + b.min.z) / 2 };
  };
  const setNDC = (e) => { const r = dom.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  const pickItem = (e) => {
    setNDC(e); ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(F.items.filter((i) => !i.userData.wall && i.visible), true);
    return hits.length ? itemOf(hits[0].object) : null;
  };
  // pointer -> point on the floor plane (house space = furniture.group local)
  const floorPoint = (e, y = 0) => {
    setNDC(e); ray.setFromCamera(ndc, camera);
    F.group.updateMatrixWorld(true);
    const n = new THREE.Vector3(0, 1, 0).transformDirection(F.group.matrixWorld);
    const p0 = F.group.localToWorld(new THREE.Vector3(0, y, 0));
    plane.setFromNormalAndCoplanarPoint(n, p0);
    if (!ray.ray.intersectPlane(plane, hitW)) return null;
    return F.group.worldToLocal(hitW.clone());
  };
  const roomAt = (x, z) => {
    const px = x + L.footprint.width_ft / 2, py = z + L.footprint.depth_ft / 2;
    return L.rooms.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
  };
  const snap = (v) => Math.round(v / grid) * grid;
  const placeRing = (item, ext, x, z, rotY) => {
    const swap = Math.abs(Math.round(rotY / (Math.PI / 2))) % 2 === 1;
    const w = (swap ? ext.hz : ext.hx) * 2 + 0.6, d = (swap ? ext.hx : ext.hz) * 2 + 0.6;
    ring.scale.set(w, 1, d); ring.position.set(x, 0.06, z); ring.visible = true;
  };
  const setHover = (item) => {
    if (item === hover) return; hover = item;
    dom.style.cursor = item ? "grab" : "";
    ringTarget = item ? 0.22 : 0;
    if (item) { const e = localExtents(item), p = item.getWorldPosition(new THREE.Vector3()); F.group.worldToLocal(p); placeRing(item, e, p.x + e.cx, p.z + e.cz, item.rotation.y); }
    onHover?.(item);
  };

  const onDown = (e) => {
    if (!enabled || e.button > 0 || drag) return;
    const item = pickItem(e); if (!item) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (controls) { drag = { controlsWas: controls.enabled }; controls.enabled = false; } else drag = {};
    dom.setPointerCapture?.(e.pointerId);
    // detach to house space so it can cross rooms freely
    const from = item.userData.roomId;
    F.group.attach(item);
    const ext = localExtents(item);
    const fp = floorPoint(e) ?? item.position.clone();
    Object.assign(drag, {
      item, from, ext, room: from, start: item.position.clone(), startRot: item.rotation.y,
      offset: new THREE.Vector3(item.position.x - fp.x, 0, item.position.z - fp.z), rot: item.rotation.y,
    });
    // footprints of the other solid pieces (house space), so the dragged piece slides around them
    drag.obstacles = [];
    const bb = new THREE.Box3();
    for (const o of F.items) {
      if (o === item || !o.userData.collide || !o.visible) continue;
      bb.setFromObject(o); const a = F.group.worldToLocal(bb.min.clone()), b = F.group.worldToLocal(bb.max.clone());
      drag.obstacles.push({ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) });
    }
    drag.solid = !!item.userData.collide;
    target.copy(item.position); pos.copy(item.position);
    vx.v = vz.v = vy.v = vr.v = 0;
    dom.style.cursor = "grabbing"; ringTarget = 0.35;
    onPick?.({ item, roomId: from });
  };
  const onMoveEv = (e) => {
    if (!enabled) return;
    if (!drag) { setHover(pickItem(e)); return; }
    const fp = floorPoint(e); if (!fp) return;
    const swap = Math.abs(Math.round(drag.rot / (Math.PI / 2))) % 2 === 1;
    const hx = swap ? drag.ext.hz : drag.ext.hx, hz = swap ? drag.ext.hx : drag.ext.hz;
    let x = snap(fp.x + drag.offset.x), z = snap(fp.z + drag.offset.z);
    const r = roomAt(x, z);
    if (!r) return; // outside the house: hold the last valid spot
    // keep the whole piece inside the room it is over (0.3 ft off the walls)
    const ox = -L.footprint.width_ft / 2, oz = -L.footprint.depth_ft / 2, m = 0.3;
    const cx = drag.ext.cx, cz = drag.ext.cz; // item origin vs. its bbox centre
    const rcx = swap ? cz : cx, rcz = swap ? cx : cz;
    x = THREE.MathUtils.clamp(x + rcx, ox + r.x + hx + m, ox + r.x + r.w - hx - m) - rcx;
    z = THREE.MathUtils.clamp(z + rcz, oz + r.y + hz + m, oz + r.y + r.h - hz - m) - rcz;
    // don't sink into other furniture: try the move, then each axis alone (slide along the obstacle)
    if (drag.solid && drag.obstacles.length) {
      const hit = (tx, tz) => drag.obstacles.some((o) => tx + rcx + hx > o.minX + 0.05 && tx + rcx - hx < o.maxX - 0.05 && tz + rcz + hz > o.minZ + 0.05 && tz + rcz - hz < o.maxZ - 0.05);
      if (hit(x, z)) {
        if (!hit(x, target.z)) z = target.z;
        else if (!hit(target.x, z)) x = target.x;
        else return;
      }
    }
    target.set(x, 0, z);
    if (r.id !== drag.room) { drag.room = r.id; onMove?.({ item: drag.item, roomId: r.id }); }
  };
  const finish = (cancel) => {
    if (!drag) return;
    const { item, from } = drag;
    if (cancel) { target.copy(drag.start); drag.rot = drag.startRot; drag.room = from; }
    const to = drag.room, landY = { y: item.position.y };
    // land: settle x/z/rotation on the target, then drop with a bounce
    item.position.x = target.x; item.position.z = target.z; item.rotation.set(0, drag.rot, 0);
    const y0 = item.position.y;
    tween(reduce ? 120 : 650, (k) => { item.position.y = y0 * (1 - k); }, reduce ? ease.outCubic : ease.drop);
    const rg = F.byRoom[to] ?? F.byRoom[from];
    rg.attach(item); item.userData.roomId = to;
    if (drag.controlsWas !== undefined) controls.enabled = drag.controlsWas;
    drag = null; ringTarget = 0; dom.style.cursor = "";
    setTimeout(() => F.recomputeBoxes?.(), reduce ? 150 : 700);
    onDrop?.({ item, from, to, cancelled: !!cancel, name: item.userData.name });
  };
  const onUp = () => finish(false);
  const onKey = (e) => {
    if (!enabled) return;
    if (e.key === "Escape" && drag) finish(true);
    if ((e.key === "r" || e.key === "R") && (drag || hover)) {
      if (drag) drag.rot += Math.PI / 2;
      else if (hover) {
        const it = hover, r0 = it.rotation.y;
        tween(reduce ? 100 : 420, (k) => (it.rotation.y = r0 + (Math.PI / 2) * k), ease.spring).then(() => F.recomputeBoxes?.());
      }
    }
  };
  dom.addEventListener("pointerdown", onDown, { capture: true });
  addEventListener("pointermove", onMoveEv, { passive: true });
  addEventListener("pointerup", onUp);
  addEventListener("keydown", onKey);

  return {
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; if (!v) { if (drag) finish(true); setHover(null); ring.visible = false; } },
    get dragging() { return !!drag; },
    // call every frame
    update(dt) {
      ringOpacity += (ringTarget - ringOpacity) * Math.min(1, dt * 10);
      ringMat.opacity = ringOpacity; edgeMat.opacity = Math.min(1, ringOpacity * 3);
      ring.visible = ringOpacity > 0.01;
      if (!drag) return;
      const it = drag.item, st = reduce ? 0.02 : 0.09;
      const px = it.position.x, pz = it.position.z;
      it.position.x = smoothDamp(it.position.x, target.x, vx, st, dt);
      it.position.z = smoothDamp(it.position.z, target.z, vz, st, dt);
      it.position.y = smoothDamp(it.position.y, liftHeight, vy, 0.12, dt);
      it.rotation.y = smoothDamp(it.rotation.y, drag.rot, vr, 0.12, dt);
      // lean into the motion, like something carried
      const sx = (it.position.x - px) / Math.max(dt, 1e-3), sz = (it.position.z - pz) / Math.max(dt, 1e-3);
      it.rotation.z = THREE.MathUtils.lerp(it.rotation.z, THREE.MathUtils.clamp(-sx * 0.012, -0.12, 0.12), 0.2);
      it.rotation.x = THREE.MathUtils.lerp(it.rotation.x, THREE.MathUtils.clamp(sz * 0.012, -0.12, 0.12), 0.2);
      const swap = Math.abs(Math.round(drag.rot / (Math.PI / 2))) % 2 === 1;
      placeRing(it, drag.ext, it.position.x + (swap ? drag.ext.cz : drag.ext.cx), it.position.z + (swap ? drag.ext.cx : drag.ext.cz), drag.rot);
    },
    // after an edit/regenerate: point at the new furniture + layout
    setTarget(furn, layout) { if (drag) finish(true); F.group.remove(ring); F = furn; L = layout; F.group.add(ring); hover = null; },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, { capture: true });
      removeEventListener("pointermove", onMoveEv); removeEventListener("pointerup", onUp); removeEventListener("keydown", onKey);
      ring.removeFromParent(); ringGeo.dispose(); ringMat.dispose(); edgeMat.dispose();
    },
  };
}
