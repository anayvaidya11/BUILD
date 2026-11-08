import { Vector3 } from "three";
import sample from "@/lib/sample-layout.json";
import type { Layout } from "@/lib/types";
import { buildWalls } from "@/lib/walls";

export const layout = sample as Layout;
export const walls = buildWalls(layout);
// All coordinates are feet. The path descends OUTSIDE the house, then crosses
// actual openings. Smoothstep segments stay inside their axis-aligned corridors.
export const stops = [
  { position: [60, 43, 54], target: [30, 0, 14], label: "The whole picture", detail: "A shared geometric model. Every room in its place." },
  { position: [14, 5.5, 35], target: [14, 5.5, 18], label: "At your front door", detail: "A human perspective, 5′6″ above the floor." },
  { position: [14, 5.5, 20], target: [8, 5, 12], label: "Room to live", detail: "Living room · 28 × 15 ft · 420 sq ft" },
  { position: [8, 5.5, 20], target: [8, 5, 5], label: "Connected spaces", detail: "A 14 ft opening connects living and kitchen." },
  { position: [8, 5.5, 7], target: [23, 5, 7], label: "The heart of your home", detail: "Kitchen · 16.5 × 13 ft · open to dining" },
  { position: [22, 5.5, 7], target: [22, 5, 20], label: "Made for gathering", detail: "Dining · 11.5 × 13 ft" },
  { position: [22, 5.5, 15], target: [40, 5.5, 15], label: "Everything connects", detail: "Real doorways connect the public rooms to the hall." },
  { position: [40, 5.5, 15], target: [57, 5.5, 15], label: "Space that makes sense", detail: "A 4 ft hallway connects the private rooms." },
];
export function cameraAt(progress: number) {
  const t = Math.max(0, Math.min(1, progress)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i, eased = f * f * (3 - 2 * f);
  return {
    position: new Vector3(...stops[i].position).lerp(new Vector3(...stops[i + 1].position), eased),
    target: new Vector3(...stops[i].target).lerp(new Vector3(...stops[i + 1].target), eased),
  };
}
