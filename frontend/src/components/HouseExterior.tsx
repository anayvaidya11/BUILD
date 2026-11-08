"use client";
// Exterior house model built procedurally from the layout JSON (feet, 1 unit = 1 ft).
// The group is CENTERED on the footprint (footprint center = origin) so it can be dropped
// onto a map location and rotated around its middle. Plan (x, y) -> three (x - W/2, z - D/2).
//
// Pieces: foundation, floors, walls with real window openings (sill/head pieces + glass),
// door headers, roof (gable or flat), front porch.
import { useMemo } from "react";
import * as THREE from "three";
import { WALL_HEIGHT_FT, EXTERIOR, type Layout, type Room } from "@/lib/types";
import { buildWalls, WALL_THICKNESS_FT, type WallSeg } from "@/lib/walls";

export type RoofType = "gable" | "flat";

export const SILL_FT = 3;
export const HEAD_FT = 7;
const DOOR_HEAD_FT = 7;
const OVERHANG_FT = 1.5;
const GABLE_PITCH = 6 / 12;
const FOUNDATION_FT = 3; // depth below floor, hides uneven terrain on sloped lots

const COLORS = {
  siding: "#f4f2ed",
  interior: "#faf9f6",
  frame: "#2b45f5", // brand blue, matches the design mockups
  roof: "#3b3d42",
  flatRoof: "#f7f7f5",
  foundation: "#a9a69f",
  porch: "#c9c5bc",
  glass: "#9fc3ff",
};

const FLOOR: Partial<Record<Room["type"], string>> = {
  bathroom: "#cfe3e2", kitchen: "#e8dcc4", laundry: "#dddddd", hall: "#d9c7a8", entry: "#d9c7a8",
};

/** A piece of wall as a box: center + size in plan feet (y here is plan y = three z). */
interface Piece { cx: number; cy: number; z0: number; z1: number; lenX: number; lenY: number; exterior: boolean }

interface Opening { a: number; b: number; kind: "window" | "door" }

/** Windows and exterior doors that sit on a wall line, as spans along that line. */
function openingsFor(seg: WallSeg, layout: Layout): Opening[] {
  const horiz = seg.y1 === seg.y2;
  const line = horiz ? seg.y1 : seg.x1;
  const lo = horiz ? Math.min(seg.x1, seg.x2) : Math.min(seg.y1, seg.y2);
  const hi = horiz ? Math.max(seg.x1, seg.x2) : Math.max(seg.y1, seg.y2);
  const out: Opening[] = [];
  const eps = 0.01;
  for (const w of layout.windows) {
    const r = layout.rooms.find((rr) => rr.id === w.room);
    if (!r) continue;
    const wHoriz = w.wall === "north" || w.wall === "south";
    if (wHoriz !== horiz) continue;
    const wLine = w.wall === "north" ? r.y : w.wall === "south" ? r.y + r.h : w.wall === "west" ? r.x : r.x + r.w;
    if (Math.abs(wLine - line) > eps) continue;
    const start = (wHoriz ? r.x : r.y) + w.offset_ft;
    const a = Math.max(lo, start), b = Math.min(hi, start + w.width_ft);
    if (b - a > eps) out.push({ a, b, kind: "window" });
  }
  return out.sort((p, q) => p.a - q.a);
}

/** Split each wall segment around its window openings into solid / sill / head pieces. */
function wallPieces(layout: Layout, segs: WallSeg[], H: number) {
  const pieces: Piece[] = [];
  const glass: Piece[] = [];
  for (const s of segs) {
    const horiz = s.y1 === s.y2;
    const line = horiz ? s.y1 : s.x1;
    const lo = horiz ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2);
    const hi = horiz ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2);
    const push = (a: number, b: number, z0: number, z1: number, into = pieces) => {
      if (b - a <= 0.001 || z1 - z0 <= 0.001) return;
      const mid = (a + b) / 2;
      into.push({
        cx: horiz ? mid : line, cy: horiz ? line : mid, z0, z1,
        lenX: horiz ? b - a : WALL_THICKNESS_FT, lenY: horiz ? WALL_THICKNESS_FT : b - a, exterior: s.exterior,
      });
    };
    let cursor = lo;
    for (const o of openingsFor(s, layout)) {
      push(cursor, o.a, 0, H);
      push(o.a, o.b, 0, SILL_FT);
      push(o.a, o.b, HEAD_FT, H);
      push(o.a, o.b, SILL_FT, HEAD_FT, glass);
      cursor = o.b;
    }
    push(cursor, hi, 0, H);
  }
  // Pad solid pieces so corners overlap (same trick as the walkthrough walls).
  for (const p of pieces) {
    if (p.lenX > p.lenY) p.lenX += WALL_THICKNESS_FT; else p.lenY += WALL_THICKNESS_FT;
  }
  return { pieces, glass };
}

/** Is this door on a horizontal (east-west) wall? */
function doorIsHorizontal(layout: Layout, d: Layout["doors"][number]) {
  const eps = 0.01;
  const { width_ft: W, depth_ft: D } = layout.footprint;
  if (d.between.includes(EXTERIOR)) return Math.abs(d.y) < eps || Math.abs(d.y - D) < eps || !(Math.abs(d.x) < eps || Math.abs(d.x - W) < eps);
  const [a, b] = d.between.map((id) => layout.rooms.find((r) => r.id === id));
  if (!a || !b) return true;
  return Math.abs(a.y + a.h - b.y) < eps || Math.abs(b.y + b.h - a.y) < eps;
}

function Box({ p, color, ox, oz, ...mat }: { p: Piece; color: string; ox: number; oz: number } & Partial<THREE.MeshStandardMaterialParameters>) {
  return (
    <mesh position={[ox + p.cx, (p.z0 + p.z1) / 2, oz + p.cy]} castShadow receiveShadow>
      <boxGeometry args={[p.lenX, p.z1 - p.z0, p.lenY]} />
      <meshStandardMaterial color={color} roughness={0.9} {...mat} />
    </mesh>
  );
}

function GableRoof({ W, D, H }: { W: number; D: number; H: number }) {
  // Ridge runs along the long side. Build it for "ridge along x", rotate if the house is deeper than wide.
  const alongX = W >= D;
  const len = (alongX ? W : D) + 2 * OVERHANG_FT;
  const span = alongX ? D : W;
  const half = span / 2;
  const rise = half * GABLE_PITCH;
  const angle = Math.atan(GABLE_PITCH);
  const runOut = half + OVERHANG_FT; // horizontal run incl. eave overhang
  const slab = runOut / Math.cos(angle); // sloped length of each face
  const thick = 0.45;
  // Slab centers: halfway down each slope from the ridge (ridge sits at H + rise).
  const cy = H + rise - (runOut / 2) * Math.tan(angle) + thick / 2;
  const cz = runOut / 2;

  const gable = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-half, 0); s.lineTo(half, 0); s.lineTo(0, rise); s.closePath();
    return new THREE.ShapeGeometry(s);
  }, [half, rise]);

  const endOffset = (alongX ? W : D) / 2;
  return (
    <group rotation-y={alongX ? 0 : Math.PI / 2}>
      {[1, -1].map((side) => (
        <mesh key={side} position={[0, cy, side * cz]} rotation-x={side * angle} castShadow receiveShadow>
          <boxGeometry args={[len, thick, slab]} />
          <meshStandardMaterial color={COLORS.roof} roughness={0.95} />
        </mesh>
      ))}
      {/* Gable end triangles in siding color, sitting on top of the end walls. */}
      {[1, -1].map((side) => (
        <mesh key={`g${side}`} geometry={gable} position={[side * endOffset, H, 0]} rotation-y={Math.PI / 2} castShadow>
          <meshStandardMaterial color={COLORS.siding} side={THREE.DoubleSide} roughness={0.9} />
        </mesh>
      ))}
      {/* Fascia boards along both eaves. */}
      {[1, -1].map((side) => (
        <mesh key={`f${side}`} position={[0, H - OVERHANG_FT * GABLE_PITCH + 0.1, side * runOut]}>
          <boxGeometry args={[len, 0.6, 0.15]} />
          <meshStandardMaterial color={COLORS.frame} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

function FlatRoof({ W, D, H }: { W: number; D: number; H: number }) {
  const o = OVERHANG_FT;
  return (
    <group position={[0, H, 0]}>
      <mesh position={[0, 0.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[W + 2 * o, 0.8, D + 2 * o]} />
        <meshStandardMaterial color={COLORS.flatRoof} roughness={0.9} />
      </mesh>
      {/* Thick colored frame around the slab edge: the "modern box" look. */}
      {[
        [0, D / 2 + o, W + 2 * o + 0.3, 0.3],
        [0, -(D / 2 + o), W + 2 * o + 0.3, 0.3],
        [W / 2 + o, 0, 0.3, D + 2 * o + 0.3],
        [-(W / 2 + o), 0, 0.3, D + 2 * o + 0.3],
      ].map(([x, z, lx, lz], i) => (
        <mesh key={i} position={[x, 0.55, z]} castShadow>
          <boxGeometry args={[lx, 1.1, lz]} />
          <meshStandardMaterial color={COLORS.frame} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

export function HouseExterior({ layout, roof = "gable" }: { layout: Layout; roof?: RoofType }) {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const H = WALL_HEIGHT_FT;
  const ox = -W / 2, oz = -D / 2;
  const segs = useMemo(() => buildWalls(layout), [layout]);
  const { pieces, glass } = useMemo(() => wallPieces(layout, segs, H), [layout, segs, H]);

  const headers = useMemo(() => layout.doors.map((d) => {
    const horiz = doorIsHorizontal(layout, d);
    const t = WALL_THICKNESS_FT + 0.02;
    return { x: d.x, y: d.y, lx: horiz ? d.width_ft : t, ly: horiz ? t : d.width_ft, front: d.between.includes(EXTERIOR) };
  }), [layout]);

  // Porch: a slab outside the front door, on whichever side of the footprint the entrance is.
  const e = layout.entrance;
  const porch = useMemo(() => {
    const pw = 8, pd = 5;
    if (Math.abs(e.y - D) < 0.01) return { x: e.x, y: D + pd / 2, lx: pw, ly: pd };
    if (Math.abs(e.y) < 0.01) return { x: e.x, y: -pd / 2, lx: pw, ly: pd };
    if (Math.abs(e.x) < 0.01) return { x: -pd / 2, y: e.y, lx: pd, ly: pw };
    return { x: W + pd / 2, y: e.y, lx: pd, ly: pw };
  }, [e.x, e.y, W, D]);

  return (
    <group>
      {/* Foundation: extends below grade so the house never floats on uneven ground. */}
      <mesh position={[0, -FOUNDATION_FT / 2, 0]} receiveShadow>
        <boxGeometry args={[W + 0.6, FOUNDATION_FT, D + 0.6]} />
        <meshStandardMaterial color={COLORS.foundation} roughness={1} />
      </mesh>

      {layout.rooms.map((r) => (
        <mesh key={r.id} rotation-x={-Math.PI / 2} position={[ox + r.x + r.w / 2, 0.02, oz + r.y + r.h / 2]} receiveShadow>
          <planeGeometry args={[r.w, r.h]} />
          <meshStandardMaterial color={FLOOR[r.type] ?? "#b89b74"} roughness={0.85} />
        </mesh>
      ))}

      {pieces.map((p, i) => <Box key={i} p={p} ox={ox} oz={oz} color={p.exterior ? COLORS.siding : COLORS.interior} />)}

      {glass.map((p, i) => (
        <group key={`w${i}`}>
          <Box p={{ ...p, lenX: p.lenX > p.lenY ? p.lenX : 0.08, lenY: p.lenY > p.lenX ? p.lenY : 0.08 }} ox={ox} oz={oz}
            color={COLORS.glass} transparent opacity={0.45} roughness={0.05} metalness={0.3} />
          {/* Window frame: thin colored sill + head trim, proud of the wall. */}
          {[SILL_FT, HEAD_FT].map((z) => (
            <Box key={z} p={{ ...p, z0: z - 0.12, z1: z + 0.12,
              lenX: p.lenX > p.lenY ? p.lenX + 0.3 : WALL_THICKNESS_FT + 0.2,
              lenY: p.lenY > p.lenX ? p.lenY + 0.3 : WALL_THICKNESS_FT + 0.2 }}
              ox={ox} oz={oz} color={COLORS.frame} roughness={0.6} />
          ))}
        </group>
      ))}

      {headers.map((h, i) => (
        <mesh key={`d${i}`} position={[ox + h.x, (DOOR_HEAD_FT + H) / 2, oz + h.y]} castShadow>
          <boxGeometry args={[h.lx, H - DOOR_HEAD_FT, h.ly]} />
          <meshStandardMaterial color={h.front ? COLORS.frame : COLORS.interior} roughness={0.8} />
        </mesh>
      ))}

      <mesh position={[ox + porch.x, -0.15, oz + porch.y]} receiveShadow castShadow>
        <boxGeometry args={[porch.lx, 0.5, porch.ly]} />
        <meshStandardMaterial color={COLORS.porch} roughness={1} />
      </mesh>

      {roof === "gable" ? <GableRoof W={W} D={D} H={H} /> : <FlatRoof W={W} D={D} H={H} />}
    </group>
  );
}
