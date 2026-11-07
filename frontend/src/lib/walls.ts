// Role 5 (shared with role 4): turn a Layout into wall segments with door gaps.
// Rooms tile on a GRID-ft lattice, so we cut every room edge into unit segments,
// dedupe shared walls, remove segments a door opening covers, then merge runs.
import type { Layout } from "./types";

export const GRID = 0.5;
export const WALL_THICKNESS_FT = 0.33;

export interface WallSeg { x1: number; y1: number; x2: number; y2: number; exterior: boolean }

const k = (n: number) => Math.round(n / GRID);

export function buildWalls(layout: Layout): WallSeg[] {
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const H = new Set<string>(); // "row,col" horizontal unit at y=row*GRID from x=col*GRID
  const V = new Set<string>(); // "col,row" vertical unit at x=col*GRID from y=row*GRID

  for (const r of layout.rooms) {
    const [x0, x1, y0, y1] = [k(r.x), k(r.x + r.w), k(r.y), k(r.y + r.h)];
    for (let c = x0; c < x1; c++) { H.add(`${y0},${c}`); H.add(`${y1},${c}`); }
    for (let rr = y0; rr < y1; rr++) { V.add(`${x0},${rr}`); V.add(`${x1},${rr}`); }
  }

  // Door openings: horizontal if a horizontal wall exists under the door center.
  for (const d of layout.doors) {
    const half = d.width_ft / 2;
    const row = k(d.y), col = Math.floor(d.x / GRID);
    if (H.has(`${row},${col}`) || H.has(`${row},${col - 1}`)) {
      for (let c = k(d.x - half); c < k(d.x + half); c++) H.delete(`${row},${c}`);
    } else {
      const vcol = k(d.x);
      for (let rr = k(d.y - half); rr < k(d.y + half); rr++) V.delete(`${vcol},${rr}`);
    }
  }

  const segs: WallSeg[] = [];
  const merge = (set: Set<string>, horizontal: boolean) => {
    const lines = new Map<number, number[]>();
    for (const key of set) {
      const [line, pos] = key.split(",").map(Number);
      (lines.get(line) ?? lines.set(line, []).get(line)!).push(pos);
    }
    for (const [line, ps] of lines) {
      ps.sort((a, b) => a - b);
      let start = ps[0], prev = ps[0];
      const flush = () => {
        const a = start * GRID, b = (prev + 1) * GRID, l = line * GRID;
        const exterior = horizontal ? l === 0 || l === D : l === 0 || l === W;
        segs.push(horizontal ? { x1: a, y1: l, x2: b, y2: l, exterior } : { x1: l, y1: a, x2: l, y2: b, exterior });
      };
      for (const p of ps.slice(1)) {
        if (p !== prev + 1) { flush(); start = p; }
        prev = p;
      }
      flush();
    }
  };
  merge(H, true);
  merge(V, false);
  return segs;
}

// Axis-aligned collision boxes in plan coords (role 5 collision uses these).
export interface Box { minX: number; maxX: number; minY: number; maxY: number }
export function wallBoxes(segs: WallSeg[]): Box[] {
  const t = WALL_THICKNESS_FT / 2;
  return segs.map((s) => ({
    minX: Math.min(s.x1, s.x2) - t, maxX: Math.max(s.x1, s.x2) + t,
    minY: Math.min(s.y1, s.y2) - t, maxY: Math.max(s.y1, s.y2) + t,
  }));
}
