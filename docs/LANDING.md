# BUILD landing page

The public product story lives at `/welcome`. The existing application stays at `/`;
all Try BUILD and Launch BUILD links open that same-origin application. No external
production URL is assumed, and no backend is required to view the landing page.

From `frontend/`:

```sh
npm ci
npm run dev
# Open http://localhost:3000/welcome
npx eslint src/components/landing src/app/welcome scripts/check-landing-path.mjs
npx tsc --noEmit
node scripts/check-landing-path.mjs
npm run build -- --webpack
```

Run the build before a standalone type check on a fresh checkout, so Next generates
its route types. The existing app needs its normal API configuration for generation.

## Implementation

- `src/app/welcome/page.tsx` and `welcome.css`: isolated route, metadata and scoped
  responsive styles. The `:has(.lp)` overflow override only applies on this route.
- `src/components/landing/Landing.tsx`: narrative, original uncropped 2:1 logo,
  preview toggle, sourced statistics, semantic navigation, manual tour controls.
- `HouseScene.tsx`: React Three Fiber scene, original wall builder, room floors,
  real window/door openings and illustrative furnishings. Rendering runs on demand,
  DPR is capped at 1.5, and R3F disposes declarative geometry/materials on unmount.
- `geometry.ts`: actual bundled sample and eight camera keyframes in feet.
  Smoothstep interpolation stays within doorway-aligned segments. The camera
  descends outside the house, then enters at 5.5 ft eye height. Scroll drives
  progress; the range input supports keyboard navigation. Reduced motion removes
  the extended scroll sequence and leaves manual viewpoint selection.
- `scripts/check-landing-path.mjs`: samples 4,001 positions against actual walls
  with 0.4 ft clearance and verifies interior eye height.

The sample has 1,708 sq ft (the requested brief is approximately 1,800 sq ft).
The preview is explicitly labeled as a bundled layout; it does not imply a fresh
AI generation. Statistics cite the 2024 U.S. Houzz & Home Study and describe 2023
renovation activity among surveyed Houzz users, not custom-home design costs.

## Verification and limits

Production webpack build and type check pass. Landing-specific lint passes.
Repository-wide lint has an existing anchor-navigation error in `SiteModel.tsx`
and nine existing unused-variable warnings in the app's JavaScript modules.

Chromium checks at 1440×1000 and 390×844 verified initial canvases, original logo,
2D/3D toggle, no horizontal overflow, tour progression, reduced-motion manual
controls and the app CTA. No page exceptions occurred. Screenshots were visually
reviewed. Geometry is architectural/schematic, not photorealistic. No live backend
AI request was made, and Safari and physical mobile GPU performance were not tested.
