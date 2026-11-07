"use client";
// Role 4: 2D SVG floor plan with names and dimensions. Also used (small) as the minimap.
import { useMemo } from "react";
import type { Layout, Point } from "@/lib/types";
import { buildWalls } from "@/lib/walls";

const FILL: Record<string, string> = {
  living: "#f3efe6", kitchen: "#fdf1d6", dining: "#f7e7d3", bedroom: "#e4ecf7",
  primary_bedroom: "#dbe5f5", bathroom: "#ddf1f0", office: "#ece6f5", laundry: "#eeeeee",
  hall: "#fafafa", entry: "#f3efe6", closet: "#eeeeee",
};

const ftIn = (ft: number) => {
  const f = Math.floor(ft), i = Math.round((ft - f) * 12);
  return i ? `${f}'${i}"` : `${f}'`;
};

export function PlanView({ layout, player, compact = false }: {
  layout: Layout; player?: (Point & { heading: number }) | null; compact?: boolean;
}) {
  const walls = useMemo(() => buildWalls(layout), [layout]);
  const { width_ft: W, depth_ft: D } = layout.footprint;
  const pad = compact ? 1 : 3;
  return (
    <svg viewBox={`${-pad} ${-pad} ${W + 2 * pad} ${D + 2 * pad}`} className="h-full w-full">
      {layout.rooms.map((r) => (
        <g key={r.id}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={FILL[r.type] ?? "#fff"} />
          {!compact && r.type !== "hall" && (
            <>
              <text x={r.x + r.w / 2} y={r.y + r.h / 2 - 0.4} fontSize={Math.min(1.3, r.w / 7)} textAnchor="middle" fill="#222">{r.name}</text>
              <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 1.1} fontSize={Math.min(1, r.w / 9)} textAnchor="middle" fill="#666">
                {ftIn(r.w)} × {ftIn(r.h)}
              </text>
            </>
          )}
        </g>
      ))}
      {walls.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="#222" strokeWidth={s.exterior ? 0.5 : 0.25} strokeLinecap="square" />
      ))}
      {layout.windows.map((w, i) => {
        const r = layout.rooms.find((x) => x.id === w.room);
        if (!r) return null;
        const horiz = w.wall === "north" || w.wall === "south";
        const y = w.wall === "north" ? r.y : r.y + r.h, x = w.wall === "west" ? r.x : r.x + r.w;
        return horiz
          ? <line key={i} x1={r.x + w.offset_ft} y1={y} x2={r.x + w.offset_ft + w.width_ft} y2={y} stroke="#4a90d9" strokeWidth={0.35} />
          : <line key={i} x1={x} y1={r.y + w.offset_ft} x2={x} y2={r.y + w.offset_ft + w.width_ft} stroke="#4a90d9" strokeWidth={0.35} />;
      })}
      <circle cx={layout.entrance.x} cy={layout.entrance.y} r={0.6} fill="#d9534f" />
      {player && (
        <g transform={`translate(${player.x} ${player.y}) rotate(${(player.heading * 180) / Math.PI})`}>
          <circle r={compact ? 1 : 0.7} fill="#d9534f" />
          <path d="M0,-2.2 L-0.9,-0.6 L0.9,-0.6 Z" fill="#d9534f" />
        </g>
      )}
    </svg>
  );
}
