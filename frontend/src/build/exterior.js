// Exterior design for the generated house: one small spec drives roof, colors and porch.
//
//   ExteriorSpec = { style, roof: "gable"|"hip"|"flat"|"shed", pitch (rise per 12),
//                    siding, trim, roofColor (hex strings), porch: "none"|"stoop"|"covered" }
//
// STYLES are presets; every field stays editable. Roof type x pitch x 3 colors x porch already
// gives thousands of distinct exteriors, so there is no need for a library of 3D models: the
// geometry always comes from the floor plan, so it always matches the walls and windows.
//
// parseExteriorPrompt() is a keyword stand-in for the mockups (they run on mock data). In the real
// app, Claude fills the same ExteriorSpec with structured output ("make it a modern farmhouse
// with a red door") and code renders it, the same split as the room program.
import * as THREE from "three";
import { buildHouse, WALL_H } from "./core.js";

export const STYLES = {
  "Modern farmhouse": { roof: "gable", pitch: 10, siding: "#f5f3ee", trim: "#1d1d1f", roofColor: "#2b2b2e", porch: "covered" },
  Craftsman: { roof: "gable", pitch: 6, siding: "#6f7d62", trim: "#f2ece0", roofColor: "#5a4a3c", porch: "covered" },
  Colonial: { roof: "gable", pitch: 9, siding: "#e9e4da", trim: "#ffffff", roofColor: "#3c3f44", porch: "stoop" },
  Ranch: { roof: "hip", pitch: 4, siding: "#c9b79c", trim: "#ffffff", roofColor: "#6b6258", porch: "stoop" },
  Mediterranean: { roof: "hip", pitch: 4, siding: "#ead8b8", trim: "#7a4a2a", roofColor: "#b5562f", porch: "none" },
  "Modern box": { roof: "flat", pitch: 0, siding: "#f7f7f5", trim: "#2b45f5", roofColor: "#f7f7f5", porch: "stoop" },
  Coastal: { roof: "gable", pitch: 8, siding: "#a9c4d6", trim: "#ffffff", roofColor: "#8a9097", porch: "covered" },
  Scandinavian: { roof: "shed", pitch: 5, siding: "#2e2f31", trim: "#c8a675", roofColor: "#2e2f31", porch: "none" },
};

export const defaultExterior = () => ({ style: "Modern farmhouse", ...STYLES["Modern farmhouse"] });

const OVERHANG = 1.5;
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...extra });

/** Builds a roof surface from triangles (flat-shaded, double-sided so it reads from below too). */
function triMesh(points, color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat(color, { side: THREE.DoubleSide, flatShading: true, roughness: 0.95 }));
}

/**
 * Roof in an "along X" frame: ridge runs along X (the long side), house spans [-L/2, L/2] x [-S/2, S/2]
 * at wall height H. Returns a group the caller rotates 90 deg if the house is deeper than wide.
 */
function roofAlongX(type, L, S, H, pitch, ext) {
  const g = new THREE.Group(), o = OVERHANG, p = pitch / 12;
  const x = L / 2 + o, z = S / 2 + o, eave = H - o * (type === "shed" ? p * 0.4 : p), rise = (S / 2) * p, top = H + rise;
  const rc = ext.roofColor;

  if (type === "flat") {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * x, 0.8, 2 * z), mat(rc));
    slab.position.y = H + 0.4; g.add(slab);
    for (const [px, pz, lx, lz] of [[0, z, 2 * x + 0.3, 0.3], [0, -z, 2 * x + 0.3, 0.3], [x, 0, 0.3, 2 * z + 0.3], [-x, 0, 0.3, 2 * z + 0.3]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(lx, 1.1, lz), mat(ext.trim, { roughness: 0.6 }));
      m.position.set(px, H + 0.55, pz); g.add(m);
    }
    return g;
  }

  if (type === "gable") {
    g.add(triMesh([[-x, eave, z], [x, eave, z], [x, top, 0], [-x, eave, z], [x, top, 0], [-x, top, 0]], rc));
    g.add(triMesh([[-x, eave, -z], [-x, top, 0], [x, top, 0], [-x, eave, -z], [x, top, 0], [x, eave, -z]], rc));
    // gable-end wall triangles in siding color
    for (const sx of [L / 2, -L / 2]) g.add(triMesh([[sx, H, S / 2], [sx, H, -S / 2], [sx, top, 0]], ext.siding));
  } else if (type === "hip") {
    const r = Math.max(x - z, 0); // hip ridge is inset by the short half-span on each end
    g.add(triMesh([[-x, eave, z], [x, eave, z], [r, top, 0], [-x, eave, z], [r, top, 0], [-r, top, 0]], rc));
    g.add(triMesh([[-x, eave, -z], [-r, top, 0], [r, top, 0], [-x, eave, -z], [r, top, 0], [x, eave, -z]], rc));
    g.add(triMesh([[x, eave, z], [x, eave, -z], [r, top, 0]], rc));
    g.add(triMesh([[-x, eave, -z], [-x, eave, z], [-r, top, 0]], rc));
  } else if (type === "shed") {
    // single slope rising from the front (+z) to the back (-z)
    // A shed spans the whole depth in one slope, so use 40% of the nominal pitch (6/12 -> ~7 ft rise
    // on a 35 ft house) instead of the full rise a gable would split over two halves.
    const sp = p * 0.4, hi = H + S * sp, eHi = hi + o * sp;
    g.add(triMesh([[-x, eave, z], [x, eave, z], [x, eHi, -z], [-x, eave, z], [x, eHi, -z], [-x, eHi, -z]], rc));
    for (const sx of [L / 2, -L / 2]) g.add(triMesh([[sx, H, S / 2], [sx, H, -S / 2], [sx, hi, -S / 2]], ext.siding));
    g.add(triMesh([[-L / 2, H, -S / 2], [L / 2, H, -S / 2], [L / 2, hi, -S / 2], [-L / 2, H, -S / 2], [L / 2, hi, -S / 2], [-L / 2, hi, -S / 2]], ext.siding));
  }
  // fascia boards along the eaves
  for (const sz of type === "shed" ? [z] : [z, -z]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(2 * x, 0.5, 0.15), mat(ext.trim, { roughness: 0.6 }));
    f.position.set(0, eave - 0.1, sz); g.add(f);
  }
  return g;
}

function roof(W, D, H, ext) {
  const alongX = W >= D;
  const g = roofAlongX(ext.roof, alongX ? W : D, alongX ? D : W, H, ext.roof === "flat" ? 0 : ext.pitch, ext);
  if (!alongX) g.rotation.y = Math.PI / 2;
  return g;
}

function porch(layout, ext) {
  const g = new THREE.Group();
  if (ext.porch === "none") return g;
  const { width_ft: W, depth_ft: D } = layout.footprint, e = layout.entrance;
  const horiz = Math.abs(e.y - D) < 0.01 || Math.abs(e.y) < 0.01;
  const covered = ext.porch === "covered";
  const pw = covered ? 14 : 8, pd = covered ? 7 : 5;
  const out = Math.abs(e.y - D) < 0.01 || Math.abs(e.x - W) < 0.01 ? 1 : -1; // which way is outside
  const [lx, lz] = horiz ? [pw, pd] : [pd, pw];
  const cx = (horiz ? e.x : (out > 0 ? W : 0) + out * pd / 2) - W / 2;
  const cz = (horiz ? (out > 0 ? D : 0) + out * pd / 2 : e.y) - D / 2;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(lx, 0.5, lz), mat(0xc9c5bc, { roughness: 1 }));
  slab.position.set(cx, -0.25, cz); g.add(slab);
  if (covered) {
    const ph = 8.2;
    const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(lx + 0.6, 0.4, lz + 0.6), mat(ext.roofColor));
    roofSlab.position.set(cx, ph + 0.2, cz); g.add(roofSlab);
    // two posts on the outer edge
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, ph, 0.5), mat(ext.trim, { roughness: 0.6 }));
      const along = s * ((horiz ? lx : lz) / 2 - 0.6);
      post.position.set(horiz ? cx + along : cx + out * (lx / 2 - 0.4), ph / 2, horiz ? cz + out * (lz / 2 - 0.4) : cz + along);
      g.add(post);
    }
  }
  return g;
}

/** Full exterior house (feet, centered on the footprint) for a layout + ExteriorSpec. */
export function buildExteriorHouse(layout, ext) {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const siding = new THREE.Color(ext.siding).getHex(), trim = new THREE.Color(ext.trim).getHex();
  const h = buildHouse(layout, { exteriorWallColor: siding, wallColor: 0xfaf9f6, frameColor: trim });
  const g = new THREE.Group(); g.add(h.group);
  const found = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 3, D + 0.6), mat(0xa9a69f, { roughness: 1 }));
  found.position.y = -1.76; g.add(found);
  g.add(porch(layout, ext));
  g.add(roof(W, D, WALL_H, ext));
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ---------- plain-English edits (mock stand-in for Claude structured output) ----------

const COLORS = {
  white: "#f5f3ee", black: "#1d1d1f", charcoal: "#2e2f31", gray: "#8a8d91", grey: "#8a8d91",
  navy: "#1f2f4f", blue: "#4f78a8", "light blue": "#a9c4d6", red: "#9b2f2a", brick: "#8e3b2c",
  green: "#3f5f45", sage: "#6f7d62", olive: "#6b6a3a", tan: "#c9b79c", beige: "#e3d6bd",
  cream: "#f2ece0", brown: "#5a4a3c", wood: "#c8a675", yellow: "#e8c95a", terracotta: "#b5562f",
};
const PART = [
  [/\b(roof|shingles?)\b/, "roofColor"],
  [/\b(trim|windows?|frames?|fascia|shutters?|door)\b/, "trim"],
  [/\b(siding|walls?|house|exterior|paint)\b/, "siding"],
];

/** Applies an edit like "craftsman, steeper hip roof, navy siding and white trim" to a spec. */
export function parseExteriorPrompt(text, ext) {
  const next = { ...ext }, changes = [];
  const t = text.toLowerCase();
  for (const name of Object.keys(STYLES)) {
    if (t.includes(name.toLowerCase())) { Object.assign(next, STYLES[name], { style: name }); changes.push(name); }
  }
  for (const r of ["gable", "hip", "flat", "shed"]) {
    if (new RegExp(`\\b${r}\\b`).test(t)) { next.roof = r; if (r !== "flat" && !next.pitch) next.pitch = 6; changes.push(`${r} roof`); }
  }
  if (/steeper|taller roof|higher pitch/.test(t)) { next.pitch = Math.min(12, next.pitch + 3); changes.push("steeper"); }
  if (/flatter|lower pitch|shallower/.test(t)) { next.pitch = Math.max(2, next.pitch - 3); changes.push("lower pitch"); }
  if (/no porch|remove (the )?porch/.test(t)) { next.porch = "none"; changes.push("no porch"); }
  else if (/covered porch|front porch|wraparound|veranda/.test(t)) { next.porch = "covered"; changes.push("covered porch"); }
  else if (/\bstoop\b/.test(t)) { next.porch = "stoop"; changes.push("stoop"); }
  // colors: per clause, "navy siding", "roof in red", "white trim"
  for (const clause of t.split(/,|;|\band\b|\bwith\b/)) {
    const color = Object.keys(COLORS).sort((a, b) => b.length - a.length).find((c) => new RegExp(`\\b${c}\\b`).test(clause));
    if (!color) continue;
    const part = PART.find(([re]) => re.test(clause))?.[1] ?? "siding";
    next[part] = COLORS[color]; changes.push(`${color} ${part === "roofColor" ? "roof" : part}`);
  }
  if (changes.length && !changes.some((c) => STYLES[c])) next.style = "Custom";
  return { spec: next, changes };
}
