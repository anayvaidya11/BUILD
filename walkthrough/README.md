# Photoreal 360° walkthrough (prototype)

Street-View-style walkthrough of a simulated house: Blender **Cycles** renders an equirectangular
360° panorama at each viewpoint on **Modal** GPUs, and a **Pannellum** viewer links them with
floor arrows and a minimap.

Right now the house is a hard-coded mock (6 rooms, 8 viewpoints). It does not read the layout JSON
from [docs/CONTRACTS.md](../docs/CONTRACTS.md) yet. Wiring it to the solver output is the next step.

![before / after](before_after.jpg)

## How it works

`render_modal.py` runs the whole thing in one command:

1. **Assets.** Downloads free CC0 assets from Poly Haven (HDRI sky, PBR textures, scanned furniture,
   plants, trees, grass) into a Modal Volume `house-assets` once (~1.2 GB) and reuses them on later runs.
2. **Scene.** Builds walls, windows, doors, a floor, ceiling, curtains and furniture with `bpy`.
   The yard gets 3D trees, shrubs, a fence and grass scattered with geometry nodes.
3. **Lighting.** Uses the `meadow_2` HDRI. The script finds the sun in the image, rotates the sky so
   sunlight comes through the south windows, clamps the sun out of the HDRI and re-adds it as a sun
   lamp with matching energy. Window portals, warm interior lights, and compositor bloom plus
   distance haze finish it.
4. **Render.** Puts a panoramic (equirectangular) camera at each viewpoint at 1.6 m eye height and
   renders all viewpoints in parallel on L40S GPUs: 4096×2048, 640 samples with denoising, about
   2.7 min per room and roughly $1 for the whole house.
5. **Output.** Writes `panos/*.jpg` plus `tour.json`, which holds the viewpoints, the arrow
   direction (yaw) for each link, and the room rectangles for the minimap.

## Run

```bash
pip install modal && modal setup
modal run render_modal.py --test                         # 2 rooms, 1536 px, quick check
modal run render_modal.py --width 4096 --samples 640     # all 8 rooms (what's committed)
modal run render_modal.py                                # 8K + 4K copies, 512 samples
modal run render_modal.py --only living,kitchen          # re-render specific rooms
```

## View

```bash
python3 -m http.server 4391    # from this folder, then open http://127.0.0.1:4391
```

Drag to look around. Click the floor arrows or the minimap dots to walk between rooms.

## Conventions

- Units are metres, +Y = north. The panorama centre (yaw 0) faces +Y, and positive yaw turns toward +X.
- Poly Haven `.blend` files contain LOD copies, leaf/branch parts and geometry-node helpers. Nature
  assets keep only their LOD0 variants; furniture and props are imported whole.

## Next

- Read rooms, doors and windows from the solver's layout JSON instead of the mock house.
- Speed: fewer samples with GPU denoise, split each panorama across GPUs, warm containers, render the
  first room first and cache by layout hash. Target: first view in about 15 s, full house under 1 min.
- Depth-based parallax transitions between viewpoints.

## Sharper and faster (Nov 8)

What changed, and why the panoramas looked soft before:

- **Resolution.** The committed panos were 4096x2048. A 360 image that wide gives only ~1100 px across
  a 100 degree view, under half of a Retina laptop's pixels. The viewer now loads `panos_8k/` when
  `tour.json` says `hires` and the GPU allows an 8192 px texture, and opens at 85 degrees instead of 100.
- **Device pixel ratio.** Pannellum 2.5 renders in CSS pixels, so Retina screens got half resolution.
  `index.html` lays the viewer out at `devicePixelRatio` times the viewport and scales it back down.
- **Cycles.** Pixel filter width 1.0 (was 1.5) and the accurate denoiser prefilter keep edges and
  texture detail; JPEGs are written at quality 95.
- **Speed: strips across GPUs.** `--strips N` splits each panorama into N vertical strips rendered on
  N GPUs at once (`StripRenderer`, scene built once per warm container, 48 px overlap blended on the
  laptop). One room at 8K/256 spp is ~45 s of GPU time per strip with 8 strips.

```bash
modal run render_modal.py --only kitchen --strips 8                   # re-render one room, 8 GPUs
modal run render_modal.py --only kitchen --strips 16 --samples 192    # faster still
modal run render_modal.py                                             # all rooms, one GPU each, ~8 min
```

Measured on 2026-11-08 (anay-vaidya11 workspace, Starter plan):

| run | GPUs seen | wall |
|---|---|---|
| all 8 rooms, 1 GPU each, 8K / 512 spp | 8 | ~8 min |
| kitchen, 16 strips, 8K / 192 spp | ~5 | 118 s |
| kitchen, 8 strips, 8K / 192 spp, warm | 5 | 103 s |
| kitchen, 5 strips, 8K / 128 spp, warm | 5 | 62 s render, 82 s incl. client |

The workspace only ever ran **5 GPU containers at once**, whatever the strip count, so that is the
plan's concurrency limit, not a code limit. Raising it in the Modal dashboard (Settings, Usage
limits / plan) cuts the wall time almost linearly: 10 GPUs puts one room at 8K under 40 s.
Until then, `--strips 5` matches the cap and `--samples 128` is the fastest setting that still
denoises cleanly indoors; use `--samples 192` or more for the final set.
