"use client";
// Site view: the generated house placed on its real lot.
//
// With NEXT_PUBLIC_GOOGLE_MAPS_KEY set, the ground is Google Photorealistic 3D Tiles
// (streamed via 3d-tiles-renderer). ReorientationPlugin recenters the globe so the chosen
// lat/lon sits at the three.js origin with +Y up, -X east, +Z north. Units there are METERS,
// so the house (feet) is wrapped in a 0.3048 scale group and rotated 180 deg so plan east/south
// line up with real east/south.
//
// Ground height: tiles are positioned on the ellipsoid, so real ground can be tens of meters
// above/below y=0. GroundFinder raycasts straight down onto the loaded tiles under the
// footprint and drops the house to the lowest hit. TileFlatteningPlugin then flattens the
// photo mesh under the lot, which removes whatever building or trees are there today.
//
// Without a key, the same house renders on a plain lawn so the view still works offline.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Sky } from "@react-three/drei";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { TilesRenderer, TilesPlugin, TilesRendererContext } from "3d-tiles-renderer/r3f";
import {
  GoogleCloudAuthPlugin, ReorientationPlugin, GLTFExtensionsPlugin, TileFlatteningPlugin,
  TilesFadePlugin, UpdateOnChangePlugin,
} from "3d-tiles-renderer/plugins";
import type { Layout } from "@/lib/types";
import { HouseExterior, type RoofType } from "./HouseExterior";

const FT = 0.3048;
const DEG = Math.PI / 180;
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
const LOT_MARGIN_FT = 12; // flattened yard around the house

export interface SiteLocation { lat: number; lon: number; label: string }

export interface SiteViewProps {
  layout: Layout;
  location: SiteLocation | null;
  rotationDeg: number;
  roof: RoofType;
  flatten: boolean;
  /** Double-click on the map moves the house there. */
  onLocationChange?: (loc: SiteLocation) => void;
}

const dracoLoader = typeof window === "undefined" ? null : new DRACOLoader().setDecoderPath(
  "https://www.gstatic.com/draco/versioned/decoders/1.5.7/",
);

/**
 * Ground sample points in meters: a ring just OUTSIDE the cleared lot. Sampling outside the
 * flattened pad matters: inside it, the raycast would just return our own flatten height and
 * never refine as sharper tiles stream in.
 */
function samplePoints(layout: Layout) {
  const hw = (layout.footprint.width_ft / 2 + LOT_MARGIN_FT) * FT;
  const hd = (layout.footprint.depth_ft / 2 + LOT_MARGIN_FT + 5) * FT;
  const r = Math.hypot(hw, hd) + SKIRT_RUN_M + 2; // outside the pad AND its sloped skirt
  return Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
  });
}

// Heights are relative to the WGS84 ellipsoid. Real ground sits roughly between the Dead Sea
// (about -430 m) and high mountain towns; anything outside this is a coarse low-detail tile
// (the root tiles are rough polyhedra that can be kilometers below the surface).
const MIN_GROUND_M = -500;
const MAX_GROUND_M = 6000;

/** Raycasts onto the tiles around the lot and reports the ground height as it refines. */
function GroundFinder({ layout, onGround }: { layout: Layout; onGround: (y: number) => void }) {
  const tiles = useContext(TilesRendererContext);
  const ray = useMemo(() => new THREE.Raycaster(), []);
  const last = useRef<number | null>(null);
  const t = useRef(0);
  const pts = useMemo(() => samplePoints(layout), [layout]);
  const down = useMemo(() => new THREE.Vector3(0, -1, 0), []);
  const origin = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, dt) => {
    if (!tiles) return;
    t.current += dt;
    // Sample often while tiles stream in, then back off.
    const every = t.current < 30 ? 0.5 : 3;
    if ((t.current % every) > dt) return;
    const heights: number[] = [];
    for (const p of pts) {
      origin.set(p.x, MAX_GROUND_M + 500, p.y);
      ray.set(origin, down);
      const hit = ray.intersectObject(tiles.group, true).find((h) => h.point.y > MIN_GROUND_M && h.point.y < MAX_GROUND_M);
      if (hit) heights.push(hit.point.y);
    }
    if (heights.length < 4) return; // not enough of the surface loaded yet
    // Low quantile: trees, cars and roofs only push samples UP, so the lower values are ground.
    heights.sort((a, b) => a - b);
    const ground = heights[Math.floor(heights.length * 0.25)];
    if (last.current === null || Math.abs(ground - last.current) > 0.25) {
      last.current = ground;
      onGround(ground);
    }
  });
  return null;
}

/**
 * Flattening shape: a flat pad (w x d meters) with a skirt rising SKIRT_RISE_M over SKIRT_RUN_M.
 * Anything above it is pressed down onto it. A plain flat pad leaves vertical "curtains" where
 * flattened points connect to tree tops just outside; the skirt makes those taper instead.
 */
const SKIRT_RUN_M = 14;
const SKIRT_RISE_M = 12;
function lotBowl(w: number, d: number) {
  const iw = w / 2, id = d / 2, ow = iw + SKIRT_RUN_M, od = id + SKIRT_RUN_M, h = SKIRT_RISE_M;
  const pos = [
    -iw, 0, -id, iw, 0, -id, iw, 0, id, -iw, 0, id, // 0-3 inner pad
    -ow, h, -od, ow, h, -od, ow, h, od, -ow, h, od, // 4-7 outer rim
  ];
  const idx = [0, 2, 1, 0, 3, 2]; // pad
  for (let i = 0; i < 4; i++) { // one trapezoid per side
    const a = i, b = (i + 1) % 4;
    idx.push(a, b, b + 4, a, b + 4, a + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Flattens the photo mesh to a horizontal pad under the lot (removes the existing building). */
function LotFlattener({ plugin, layout, rotation, groundY, enabled }: {
  plugin: TileFlatteningPlugin | null; layout: Layout; rotation: number; groundY: number | null; enabled: boolean;
}) {
  const tiles = useContext(TilesRendererContext);
  const shapeRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    if (!plugin || !tiles) return;
    if (shapeRef.current) { plugin.deleteShape(shapeRef.current); shapeRef.current = null; }
    if (!enabled || groundY === null) return;

    const w = (layout.footprint.width_ft + 2 * LOT_MARGIN_FT) * FT;
    const d = (layout.footprint.depth_ft + 2 * LOT_MARGIN_FT + 10) * FT; // + porch side
    const mesh = new THREE.Mesh(lotBowl(w, d));
    // Shape must be in the tileset's LOCAL frame: world transform, then undo the reorientation.
    tiles.group.updateMatrixWorld(true);
    const world = new THREE.Matrix4().compose(
      new THREE.Vector3(0, groundY, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation),
      new THREE.Vector3(1, 1, 1),
    );
    const local = world.premultiply(tiles.group.matrixWorld.clone().invert());
    local.decompose(mesh.position, mesh.quaternion, mesh.scale);
    // `direction` is the way vertices get pushed: anything ABOVE the pad (houses, trees) is pressed
    // DOWN onto it; terrain below the pad is left alone. So it is local "down", not "up".
    const down = new THREE.Vector3(0, -1, 0).transformDirection(tiles.group.matrixWorld.clone().invert());
    // Package .d.ts still declares the old (number) signature; runtime takes an options object.
    plugin.addShape(mesh, down, { threshold: Infinity } as never);
    shapeRef.current = mesh;
    return () => {
      if (shapeRef.current) { plugin.deleteShape(shapeRef.current); shapeRef.current = null; }
    };
  }, [plugin, tiles, layout, rotation, groundY, enabled]);
  return null;
}

/** Keeps the orbit target on the house as the ground height resolves. */
function CameraRig({ groundY, location }: { groundY: number; location: SiteLocation | null }) {
  const get = useThree((s) => s.get);
  const controls = useThree((s) => s.controls);
  const placed = useRef<string | null>(null);
  const lastGround = useRef(groundY);
  useEffect(() => {
    const { camera, controls: c } = get();
    const ctl = c as unknown as { target: THREE.Vector3; update: () => void } | null;
    if (!ctl) return;
    const key = location ? `${location.lat},${location.lon}` : "none";
    ctl.target.set(0, groundY + 3, 0);
    if (placed.current !== key) {
      // Three-quarter view from the south-east, ~30 m out.
      camera.position.set(-22, groundY + 18, -24);
      placed.current = key;
    } else {
      // Ground estimate refined: move the camera with it so we keep the same view of the house.
      camera.position.setY(camera.position.y + groundY - lastGround.current);
    }
    lastGround.current = groundY;
    ctl.update();
  }, [get, controls, groundY, location]);
  return null;
}

/** Double-click on the photo terrain: convert the hit back to lat/lon and move the house there. */
function DoubleClickMover({ label, onPick }: { label: string; onPick?: (loc: SiteLocation) => void }) {
  const tiles = useContext(TilesRendererContext);
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { gl } = get();
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const onDbl = (e: MouseEvent) => {
      if (!tiles || !onPick) return;
      const { camera } = get();
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(tiles.group, true)[0];
      if (!hit) return;
      // World -> tileset local (Earth-centered) -> geographic.
      const local = hit.point.clone().applyMatrix4(tiles.group.matrixWorld.clone().invert());
      const cart = tiles.ellipsoid.getPositionToCartographic(local, { lat: 0, lon: 0, height: 0 });
      onPick({ lat: cart.lat / DEG, lon: cart.lon / DEG, label: label.replace(/ \(moved\)$/, "") + " (moved)" });
    };
    el.addEventListener("dblclick", onDbl);
    return () => el.removeEventListener("dblclick", onDbl);
  }, [get, tiles, onPick, label]);
  return null;
}

/** Polls the tileset's data attributions (Google requires showing them on screen). */
function AttributionReporter({ onChange }: { onChange: (a: { type: string; value: string }[]) => void }) {
  const tiles = useContext(TilesRendererContext);
  const last = useRef("");
  const t = useRef(0);
  useFrame((_, dt) => {
    t.current += dt;
    if (!tiles || t.current < 1) return;
    t.current = 0;
    const list = tiles.getAttributions().map((x) => ({ type: x.type, value: String(x.value) }));
    const key = JSON.stringify(list);
    if (key !== last.current) { last.current = key; onChange(list); }
  });
  return null;
}

function GoogleGround({ props, locKey, onGround, groundY, onAttributions }: {
  props: SiteViewProps; locKey: string; onGround: (y: number) => void; groundY: number | null;
  onAttributions: (a: { type: string; value: string }[]) => void;
}) {
  const { location, layout, flatten } = props;
  const rotation = Math.PI + props.rotationDeg * DEG;
  const [flattener, setFlattener] = useState<TileFlatteningPlugin | null>(null);
  const orienter = useRef<ReorientationPlugin | null>(null);
  const [orienterReady, setOrienterReady] = useState(false);
  const lat = location?.lat ?? 0, lon = location?.lon ?? 0;
  // TilesPlugin re-creates a plugin whenever `args` changes (shallow), so keep these stable.
  // The Google tileset covers the whole globe, so a new address only re-aims the same renderer
  // (no remount, no re-auth): see the effect below.
  const authArgs = useMemo(() => [{ apiToken: GOOGLE_KEY, autoRefreshToken: true }], []);
  const gltfArgs = useMemo(() => [{ dracoLoader }], []);
  const [firstLoc] = useState({ lat, lon });
  const orientArgs = useMemo(() => [{ lat: firstLoc.lat * DEG, lon: firstLoc.lon * DEG, height: 0, recenter: true }], [firstLoc]);
  const flattenRef = useCallback((p: unknown) => setFlattener(p as TileFlatteningPlugin | null), []);
  const orientRef = useCallback((p: unknown) => { orienter.current = p as ReorientationPlugin | null; setOrienterReady(Boolean(p)); }, []);

  useEffect(() => {
    const plugin = orienter.current;
    if (!orienterReady || !plugin) return;
    // The plugin re-applies its own lat/lon when the root tileset loads, so keep them in sync.
    Object.assign(plugin, { lat: lat * DEG, lon: lon * DEG });
    plugin.transformLatLonHeightToOrigin(lat * DEG, lon * DEG, 0);
  }, [orienterReady, lat, lon]);

  return (
    <TilesRenderer errorTarget={4}>
      <TilesPlugin plugin={GoogleCloudAuthPlugin} args={authArgs} />
      <TilesPlugin plugin={GLTFExtensionsPlugin} args={gltfArgs} />
      <TilesPlugin plugin={ReorientationPlugin} args={orientArgs} ref={orientRef} />
      <TilesPlugin plugin={TileFlatteningPlugin} ref={flattenRef} />
      <TilesPlugin plugin={TilesFadePlugin} />
      <TilesPlugin plugin={UpdateOnChangePlugin} />
      <GroundFinder key={locKey} layout={layout} onGround={onGround} />
      <LotFlattener plugin={flattener} layout={layout} rotation={rotation} groundY={groundY} enabled={flatten} />
      <AttributionReporter onChange={onAttributions} />
      <DoubleClickMover label={location?.label ?? ""} onPick={props.onLocationChange} />
    </TilesRenderer>
  );
}

export default function SiteView(props: SiteViewProps) {
  const { layout, roof, rotationDeg, location } = props;
  const useTiles = Boolean(GOOGLE_KEY && location);
  // Ground height is per location: a new address starts unresolved until tiles report it.
  const locKey = location ? `${location.lat},${location.lon}` : "";
  const [ground, setGround] = useState<{ key: string; y: number } | null>(null);
  const groundY = ground?.key === locKey ? ground.y : null;
  const setGroundY = useCallback((y: number) => setGround({ key: locKey, y }), [locKey]);
  const y = useTiles ? groundY ?? 0 : 0;
  const [attributions, setAttributions] = useState<{ type: string; value: string }[]>([]);

  return (
    <div className="relative h-full w-full">
      <Canvas shadows camera={{ fov: 50, near: 0.5, far: 40000, position: [-22, 18, -24] }} className="h-full w-full">
        <Sky sunPosition={[-60, 40, -30]} turbidity={4} />
        <hemisphereLight args={["#dfeaff", "#8a8070", 0.7]} />
        <directionalLight position={[-60, 80, -30]} intensity={2.2} castShadow
          shadow-mapSize={[2048, 2048]} shadow-camera-left={-40} shadow-camera-right={40}
          shadow-camera-top={40} shadow-camera-bottom={-40} shadow-camera-near={1} shadow-camera-far={300} />

        {useTiles ? (
          <GoogleGround props={props} locKey={locKey} onGround={setGroundY} groundY={groundY} onAttributions={setAttributions} />
        ) : (
          <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]} receiveShadow>
            <planeGeometry args={[400, 400]} />
            <meshStandardMaterial color="#86a872" roughness={1} />
          </mesh>
        )}

        <group position={[0, y, 0]} rotation-y={Math.PI + rotationDeg * DEG} scale={FT}>
          <HouseExterior layout={layout} roof={roof} />
        </group>

        <OrbitControls makeDefault enableDamping maxPolarAngle={Math.PI / 2 - 0.08} minDistance={8} maxDistance={800} />
        <CameraRig groundY={y} location={location} />
      </Canvas>

      {useTiles && (
        <div className="pointer-events-none absolute bottom-1 right-2 flex max-w-[70%] items-center gap-2 text-[10px] text-white [text-shadow:0_0_3px_#000]">
          {attributions.map((a, i) => a.type === "image"
            // eslint-disable-next-line @next/next/no-img-element -- tiny provider logo URL from the tileset
            ? <img key={i} src={a.value} alt="Google" className="h-4" />
            : <span key={i}>{a.value}</span>)}
        </div>
      )}
      {!GOOGLE_KEY && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-xs rounded bg-white/90 px-3 py-2 text-xs text-neutral-700 shadow">
          Showing a plain lot. Add <code>NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> to <code>frontend/.env.local</code> to place the
          house on real Google 3D terrain.
        </div>
      )}
      {GOOGLE_KEY && !location && (
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-white/90 px-3 py-2 text-xs text-neutral-700 shadow">
          Search an address to place the house on its lot.
        </div>
      )}
      {useTiles && groundY !== null && (
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/55 px-2 py-1 text-xs text-white">
          Drag to orbit · scroll to zoom · double-click the map to move the house
        </div>
      )}
      {useTiles && groundY === null && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-black/60 px-3 py-1 text-xs text-white">
          Loading terrain…
        </div>
      )}
    </div>
  );
}
