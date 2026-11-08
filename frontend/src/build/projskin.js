// Photoreal skin: projects Gemini renders back onto the 3D house.
//
// Each photoreal shot was rendered from a capture camera whose pose we know exactly. Gemini keeps
// the framing (verified: house edges land within a few pixels), so we can treat each returned
// image as a slide projector placed at that camera:
//
//   - captureProjector(i, cam): remember the camera RELATIVE TO THE HOUSE (so the skin follows
//     the house when it is rotated or dropped onto the ground) and render a depth map of the house
//     from it. The depth map is the projector's "shadow map": a surface only receives image i if
//     camera i could actually see it (no front photo smeared onto the back wall).
//   - setImage(i, url): the Gemini render for that camera.
//   - enable(true): swap every house mesh to a shader that blends the projected images, weighted
//     by how squarely each projector faces the surface; falls back to the model's own color where
//     no camera saw it (e.g. under the eaves).
//
// Photos already contain lighting, so the skin is unlit.
import * as THREE from "three";

export const N = 6; // projectors: 6 photos + 6 depth maps = 12 texture units (WebGL2 guarantees 16)
const NEAR = 5, FAR = 200; // capture cameras must use these so depth stays precise at house range

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vW;
varying vec3 vN;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
${[...Array(N).keys()].map((i) => `uniform sampler2D map${i}, dep${i}; uniform mat4 vp${i}; uniform vec3 pp${i}; uniform float on${i};`).join("\n")}
uniform vec3 baseColor;
varying vec3 vW;
varying vec3 vN;

vec4 project(sampler2D img, sampler2D dep, mat4 vp, vec3 pp, float on, vec3 n) {
  if (on < 0.5) return vec4(0.0);
  vec4 c = vp * vec4(vW, 1.0);
  if (c.w <= 0.0) return vec4(0.0);
  vec3 ndc = c.xyz / c.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) return vec4(0.0);
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float z = ndc.z * 0.5 + 0.5;
  float seen = unpackRGBAToDepth(texture2D(dep, uv));
  if (z - seen > 0.004) return vec4(0.0);          // hidden from this camera
  float facing = abs(dot(n, normalize(pp - vW)));  // double-sided roof faces: use |cos|
  float edge = smoothstep(0.0, 0.06, 1.0 - max(abs(ndc.x), abs(ndc.y)));
  float w = pow(facing, 3.0) * edge;
  return vec4(texture2D(img, uv).rgb * w, w);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vN);
  vec4 acc = vec4(0.0);
  ${[...Array(N).keys()].map((i) => `acc += project(map${i}, dep${i}, vp${i}, pp${i}, on${i}, n);`).join("\n  ")}
  vec3 shaded = baseColor * (0.55 + 0.45 * max(dot(n, normalize(vec3(-0.4, 0.8, -0.3))), 0.0));
  vec3 col = acc.w > 1e-4 ? acc.rgb / acc.w : shaded;
  col = mix(shaded, col, smoothstep(0.0, 0.12, acc.w));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class ProjectionSkin {
  constructor(renderer, root) {
    this.renderer = renderer;
    this.root = root;
    this.enabled = false;
    this.u = {};
    for (let i = 0; i < N; i++) {
      this.u[`map${i}`] = { value: null };
      this.u[`dep${i}`] = { value: null };
      this.u[`vp${i}`] = { value: new THREE.Matrix4() };
      this.u[`pp${i}`] = { value: new THREE.Vector3() };
      this.u[`on${i}`] = { value: 0 };
    }
    this.proj = []; // { camLocal, projection, depthRT }
    this.mats = new Map(); // original material -> skin material
    this.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    this._m = new THREE.Matrix4();
  }

  static configureCamera(cam) { cam.near = NEAR; cam.far = FAR; cam.updateProjectionMatrix(); }

  /** Call right after rendering capture i with `cam` (same pose and projection). */
  captureProjector(i, cam, width = 1024, height = 640) {
    const { renderer, root } = this;
    root.updateMatrixWorld(true); cam.updateMatrixWorld(true);
    const camLocal = root.matrixWorld.clone().invert().multiply(cam.matrixWorld);
    const rt = this.proj[i]?.depthRT ?? new THREE.WebGLRenderTarget(width, height);
    // depth pass: house only, every mesh drawn with the packed-depth material
    const swapped = [];
    root.traverse((o) => { if (o.isMesh && o.visible) { swapped.push([o, o.material]); o.material = this.depthMat; } });
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0xffffff, 1); renderer.clear();
    renderer.render(root, cam);
    renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha);
    for (const [o, m] of swapped) o.material = m;
    this.proj[i] = { camLocal, projection: cam.projectionMatrix.clone(), depthRT: rt };
    this.u[`dep${i}`].value = rt.texture;
    this.u[`on${i}`].value = 0; // until its image arrives
  }

  setImage(i, url) {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        this.u[`map${i}`].value?.dispose();
        this.u[`map${i}`].value = tex;
        this.u[`on${i}`].value = this.proj[i] ? 1 : 0;
        resolve();
      }, undefined, reject);
    });
  }

  get ready() { return [...Array(N).keys()].some((i) => this.u[`on${i}`].value > 0.5); }

  _skinFor(mat) {
    let m = this.mats.get(mat);
    if (!m) {
      const base = mat.color ? mat.color.clone() : new THREE.Color(0xcccccc);
      m = new THREE.ShaderMaterial({
        uniforms: { ...this.u, baseColor: { value: base } },
        vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
      });
      this.mats.set(mat, m);
    }
    return m;
  }

  enable(on) {
    this.enabled = on && this.ready;
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      if (this.enabled) {
        if (!o.userData.skinOrig) o.userData.skinOrig = o.material;
        o.material = this._skinFor(o.userData.skinOrig);
      } else if (o.userData.skinOrig) {
        o.material = o.userData.skinOrig; delete o.userData.skinOrig;
      }
    });
    return this.enabled;
  }

  /** Per frame: re-derive projector matrices from the house's current transform. */
  update() {
    if (!this.enabled) return;
    this.root.updateMatrixWorld();
    for (let i = 0; i < N; i++) {
      const p = this.proj[i];
      if (!p) continue;
      const world = this._m.multiplyMatrices(this.root.matrixWorld, p.camLocal);
      this.u[`pp${i}`].value.setFromMatrixPosition(world);
      this.u[`vp${i}`].value.multiplyMatrices(p.projection, world.clone().invert());
    }
  }

  /** House geometry changed (new exterior): old projections no longer fit. */
  invalidate() {
    this.enable(false);
    for (let i = 0; i < N; i++) {
      this.u[`on${i}`].value = 0;
      this.u[`map${i}`].value?.dispose(); this.u[`map${i}`].value = null;
    }
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }

  dispose() {
    this.invalidate();
    for (const p of this.proj) p?.depthRT.dispose();
    this.depthMat.dispose();
  }
}
