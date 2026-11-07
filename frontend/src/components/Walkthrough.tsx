"use client";
// Role 5: first-person walkthrough. 1 three.js unit = 1 ft. Plan (x, y) -> three (x, z).
// Collision: axis-aligned wall boxes from lib/walls.ts, resolved per axis (slides along walls).
// TODO(role 5): door frames/headers, nicer materials, furniture placeholders, perf overlay.
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PointerLockControls } from "@react-three/drei";
import * as THREE from "three";
import { EYE_HEIGHT_FT, WALL_HEIGHT_FT, type Layout, type Point } from "@/lib/types";
import { buildWalls, wallBoxes, WALL_THICKNESS_FT, type Box } from "@/lib/walls";

const SPEED_FT_S = 6;
const RADIUS_FT = 0.8;

export type PlayerPos = Point & { heading: number };

function Walls({ layout }: { layout: Layout }) {
  const segs = useMemo(() => buildWalls(layout), [layout]);
  return (
    <group>
      {segs.map((s, i) => {
        const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
        const horiz = s.y1 === s.y2;
        return (
          <mesh key={i} position={[(s.x1 + s.x2) / 2, WALL_HEIGHT_FT / 2, (s.y1 + s.y2) / 2]}>
            <boxGeometry args={horiz ? [len + WALL_THICKNESS_FT, WALL_HEIGHT_FT, WALL_THICKNESS_FT] : [WALL_THICKNESS_FT, WALL_HEIGHT_FT, len + WALL_THICKNESS_FT]} />
            <meshStandardMaterial color={s.exterior ? "#d8d4cc" : "#f2efe9"} />
          </mesh>
        );
      })}
    </group>
  );
}

function Floors({ layout }: { layout: Layout }) {
  const color: Record<string, string> = { bathroom: "#cfe3e2", kitchen: "#e8dcc4", laundry: "#dddddd" };
  return (
    <group>
      {layout.rooms.map((r) => (
        <mesh key={r.id} rotation-x={-Math.PI / 2} position={[r.x + r.w / 2, 0, r.y + r.h / 2]}>
          <planeGeometry args={[r.w, r.h]} />
          <meshStandardMaterial color={color[r.type] ?? "#b89b74"} />
        </mesh>
      ))}
      <mesh rotation-x={-Math.PI / 2} position={[layout.footprint.width_ft / 2, -0.01, layout.footprint.depth_ft / 2]}>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#7fa36b" />
      </mesh>
    </group>
  );
}

function blocked(x: number, z: number, boxes: Box[]) {
  return boxes.some((b) => x > b.minX - RADIUS_FT && x < b.maxX + RADIUS_FT && z > b.minY - RADIUS_FT && z < b.maxY + RADIUS_FT);
}

function Player({ layout, onMove }: { layout: Layout; onMove?: (p: PlayerPos) => void }) {
  const get = useThree((s) => s.get);
  const keys = useRef<Record<string, boolean>>({});
  const boxes = useMemo(() => wallBoxes(buildWalls(layout)), [layout]);
  const lastReport = useRef(0);

  useEffect(() => {
    const { camera } = get();
    // Start just inside the front door, facing into the house (north = -z).
    camera.position.set(layout.entrance.x, EYE_HEIGHT_FT, layout.entrance.y - 1.5);
    camera.lookAt(layout.entrance.x, EYE_HEIGHT_FT, 0);
  }, [get, layout]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => (keys.current[e.code] = true);
    const up = (e: KeyboardEvent) => (keys.current[e.code] = false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const fwd = useRef(new THREE.Vector3()).current;
  useFrame((state, dt) => {
    const { camera } = state;
    const k = keys.current;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const right = { x: -fwd.z, z: fwd.x };
    const f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    const s = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    const step = SPEED_FT_S * Math.min(dt, 0.05);
    const dx = (fwd.x * f + right.x * s) * step;
    const dz = (fwd.z * f + right.z * s) * step;
    const p = camera.position;
    if (!blocked(p.x + dx, p.z, boxes)) p.x += dx;
    if (!blocked(p.x, p.z + dz, boxes)) p.z += dz;
    p.y = EYE_HEIGHT_FT;

    if (onMove && state.clock.elapsedTime - lastReport.current > 0.1) {
      lastReport.current = state.clock.elapsedTime;
      onMove({ x: p.x, y: p.z, heading: Math.atan2(fwd.x, -fwd.z) });
    }
  });
  return null;
}

export default function Walkthrough({ layout, onMove }: { layout: Layout; onMove?: (p: PlayerPos) => void }) {
  return (
    <Canvas camera={{ fov: 70, near: 0.1, far: 500 }} className="h-full w-full bg-sky-200">
      <ambientLight intensity={0.6} />
      <directionalLight position={[30, 60, 20]} intensity={1.2} />
      <Floors layout={layout} />
      <Walls layout={layout} />
      <Player layout={layout} onMove={onMove} />
      <PointerLockControls />
    </Canvas>
  );
}
