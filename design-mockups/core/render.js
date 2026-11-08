// build — rendering upgrade: filmic tone mapping, soft shadows, image-based light from a studio
// environment (so materials get real reflections and soft bounce), and optional ambient occlusion.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Call once after creating the renderer and scene. Returns the env texture.
export function enhanceRenderer(renderer, scene, { exposure = 1.0, envIntensity = 0.55, shadows = true } = {}) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  if (shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  scene.environment = env;
  scene.environmentIntensity = envIntensity;
  return env;
}

// A soft key light whose shadow camera covers the house; call fitSun(sun, W, D) after (re)building.
export function fitSun(light, W, D, { size = 2048, bias = -0.0004, radius = 4 } = {}) {
  const r = Math.max(W, D) * 0.75 + 6, c = light.shadow.camera;
  light.castShadow = true;
  Object.assign(c, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 400 });
  c.updateProjectionMatrix();
  light.shadow.mapSize.set(size, size);
  light.shadow.bias = bias; light.shadow.normalBias = 0.02; light.shadow.radius = radius;
}

// Optional post stack with ground-truth ambient occlusion (contact shadows under furniture, in corners).
// Returns { composer, render(), setSize(w,h), aoPass }. Heavier than plain rendering: skip on phones.
export async function createComposer(renderer, scene, camera, { ao = true } = {}) {
  const { EffectComposer } = await import("three/addons/postprocessing/EffectComposer.js");
  const { RenderPass } = await import("three/addons/postprocessing/RenderPass.js");
  const { OutputPass } = await import("three/addons/postprocessing/OutputPass.js");
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  let aoPass = null;
  if (ao) {
    const { GTAOPass } = await import("three/addons/postprocessing/GTAOPass.js");
    const s = renderer.getSize(new THREE.Vector2());
    aoPass = new GTAOPass(scene, camera, s.x, s.y);
    aoPass.updateGtaoMaterial({ radius: 2.5, distanceExponent: 1.5, thickness: 2, scale: 1.2 });
    aoPass.blendIntensity = 0.85;
    composer.addPass(aoPass);
  }
  composer.addPass(new OutputPass());
  return { composer, aoPass, render: () => composer.render(), setSize: (w, h) => composer.setSize(w, h) };
}
