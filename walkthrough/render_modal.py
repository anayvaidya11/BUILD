"""
Photoreal mock house -> Cycles equirectangular 360 panoramas, rendered on Modal GPUs.

v2: Poly Haven CC0 assets (HDRI sky, PBR textures, scanned furniture/plants/trees/grass),
auto sun alignment to the HDRI, geometry-node grass scatter, curtains, fence, mist + glare.
Assets are downloaded once into a Modal Volume ("house-assets") and reused.

Usage:
  modal run render_modal.py --test                 # 2 nodes, 1536x768, 128 spp
  modal run render_modal.py                        # all nodes, 8192x4096 (+4096 copy), 512 spp
  modal run render_modal.py --only living,kitchen --width 4096 --samples 256
"""
import json
import math
import pathlib

import modal

OUT = pathlib.Path(__file__).parent

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libxrender1", "libxxf86vm1", "libxfixes3", "libxi6",
        "libxkbcommon0", "libsm6", "libgl1", "libegl1",
    )
    .pip_install("bpy==4.2.0", "pillow")
)
app = modal.App("house-walkthrough", image=image)
assets_vol = modal.Volume.from_name("house-assets", create_if_missing=True)
ASSETS = "/assets"

EYE = 1.6   # camera height (m)
H = 2.7     # wall height (m)

# ---------------------------------------------------------------- Poly Haven assets (all CC0)
HDRI = "meadow_2"
TEXTURES = {
    "floor": "laminate_floor_02",
    "plaster": "plastered_wall_04",
    "marble": "marble_01",
    "tile": "floor_tiles_06",
    "oak": "oak_veneer_01",
    "walnut": "smoked_walnut_veneer",
    "linen": "rough_linen",
    "rugfab": "fabric_pattern_05",
    "grass": "leafy_grass",
    "patio": "patio_tiles",
    "planks": "oak_wood_planks",
}
SCATTER = {"grass_bermuda_01", "grass_medium_01", "celandine_01", "dandelion_01"}
MODELS = [
    "Sofa_01", "modern_arm_chair_01", "modern_coffee_table_01", "side_table_01",
    "potted_plant_01", "potted_plant_02", "potted_plant_04", "throw_pillows_01",
    "modern_ceiling_lamp_01", "dining_chair_02", "bar_chair_round_01", "ceramic_vase_01",
    "standing_picture_frame_01", "wooden_bowl_01", "food_apple_01", "tea_set_01",
    "outdoor_table_chair_set_01", "planter_box_01",
    "tree_small_02", "jacaranda_tree", "island_tree_01", "island_tree_02",
    "shrub_02", "shrub_03", "shrub_04",
    "grass_bermuda_01", "grass_medium_01", "celandine_01", "dandelion_01",
]

# ---------------------------------------------------------------- tour graph
NODES = {
    "living":   (2.2, 3.4, "Living room"),
    "kitchen":  (8.3, 3.0, "Kitchen & dining"),
    "hall_w":   (2.5, 5.75, "Entry hall"),
    "hall_mid": (6.45, 5.75, "Hallway"),
    "hall_e":   (9.45, 5.75, "Hallway (east)"),
    "bedroom":  (3.3, 8.2, "Bedroom"),
    "bath":     (6.5, 8.2, "Bathroom"),
    "office":   (9.9, 8.3, "Office"),
}
LINKS = [
    ("living", "kitchen", (6.0, 2.8)),
    ("living", "hall_w", (2.5, 5.0)),
    ("kitchen", "hall_e", (9.0, 5.0)),
    ("hall_w", "hall_mid", None),
    ("hall_mid", "hall_e", None),
    ("hall_w", "bedroom", (4.05, 6.5)),
    ("hall_mid", "bath", (6.45, 6.5)),
    ("hall_e", "office", (9.45, 6.5)),
]


# ================================================================= asset download (CPU)
@app.function(volumes={ASSETS: assets_vol}, timeout=3600, cpu=4)
def fetch_assets():
    import concurrent.futures as cf
    import os
    import urllib.request

    UA = {"User-Agent": "house-walkthrough-render/1.0"}

    def get_json(url):
        return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read())

    def dl(url, path):
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return 0
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600).read()
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
        return len(data)

    jobs, manifest = [], {"hdri": None, "textures": {}, "models": {}}

    # HDRI (4k .hdr)
    f = get_json(f"https://api.polyhaven.com/files/{HDRI}")
    url = f["hdri"]["4k"]["hdr"]["url"]
    p = f"{ASSETS}/hdri/{HDRI}_4k.hdr"
    jobs.append((url, p))
    manifest["hdri"] = p

    # textures (2k jpg; normal = nor_gl; roughness or packed arm)
    for key, tid in TEXTURES.items():
        f = get_json(f"https://api.polyhaven.com/files/{tid}")
        info = get_json(f"https://api.polyhaven.com/info/{tid}")
        maps = {}
        for m, src in (("Diffuse", ("Diffuse", "col_01", "col_1")), ("Rough", ("Rough",)),
                       ("nor_gl", ("nor_gl",)), ("arm", ("arm",))):
            k = next((s for s in src if s in f and "2k" in f[s]), None)
            if k:
                fmt = "jpg" if "jpg" in f[k]["2k"] else next(iter(f[k]["2k"]))
                u = f[k]["2k"][fmt]["url"]
                lp = f"{ASSETS}/textures/{tid}/{os.path.basename(u)}"
                jobs.append((u, lp))
                maps[m] = lp
        dims = info.get("dimensions") or [2000, 2000]
        manifest["textures"][key] = {"id": tid, "maps": maps, "size_m": [d / 1000 for d in dims]}

    # models (.blend + included textures, 2k)
    for mid in MODELS:
        f = get_json(f"https://api.polyhaven.com/files/{mid}")
        res = "2k" if "2k" in f["blend"] else next(iter(f["blend"]))
        b = f["blend"][res]["blend"]
        base = f"{ASSETS}/models/{mid}"
        bp = f"{base}/{os.path.basename(b['url'])}"
        jobs.append((b["url"], bp))
        for rel, inc in b.get("include", {}).items():
            jobs.append((inc["url"], f"{base}/{rel}"))
        manifest["models"][mid] = bp

    total = 0
    with cf.ThreadPoolExecutor(16) as ex:
        for n in ex.map(lambda j: dl(*j), jobs):
            total += n
    with open(f"{ASSETS}/manifest.json", "w") as fh:
        json.dump(manifest, fh, indent=1)
    assets_vol.commit()
    return {"files": len(jobs), "downloaded_mb": round(total / 1e6, 1)}


# ================================================================= scene
def build_scene(manifest):
    import os
    import random

    import bmesh
    import bpy
    import numpy as np
    from mathutils import Matrix, Vector

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    coll = scene.collection
    TEX = manifest["textures"]

    # ------------------------------------------------------------ materials
    def principled(name, color, rough=0.5, metal=0.0, **kw):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (*color, 1)
        b.inputs["Roughness"].default_value = rough
        b.inputs["Metallic"].default_value = metal
        for k, v in kw.items():
            if k in b.inputs:
                b.inputs[k].default_value = v
        return m

    def emissive(name, color, strength):
        m = principled(name, color, 0.5)
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Emission Color"].default_value = (*color, 1)
        b.inputs["Emission Strength"].default_value = strength
        return m

    def load_img(path, color=True):
        img = bpy.data.images.load(path, check_existing=True)
        if not color:
            img.colorspace_settings.name = "Non-Color"
        return img

    def pbr(name, key, tint=None, tint_amt=0.0, scale_mul=1.0, rough_mul=1.0, rough_add=0.0,
            normal_strength=1.0, rot90=False):
        """Poly Haven PBR texture, box-projected in world space at real-world scale."""
        t = TEX[key]
        maps = t["maps"]
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        b = nt.nodes["Principled BSDF"]
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        sx, sy = t["size_m"]
        s = 1.0 / (max(sx, 0.1) * scale_mul)
        mp.inputs["Scale"].default_value = (s, s, s)
        if rot90:
            mp.inputs["Rotation"].default_value = (0, 0, math.pi / 2)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])

        def tex(path, color=True):
            n = nt.nodes.new("ShaderNodeTexImage")
            n.image = load_img(path, color)
            n.projection = "BOX"
            n.projection_blend = 0.25
            nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
            return n

        diff = tex(maps["Diffuse"])
        col_out = diff.outputs["Color"]
        if tint is not None:
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY" if tint_amt < 0 else "MIX"
            mix.inputs["Factor"].default_value = abs(tint_amt) if tint_amt else 1.0
            nt.links.new(col_out, mix.inputs["A"])
            mix.inputs["B"].default_value = (*tint, 1)
            col_out = mix.outputs["Result"]
        nt.links.new(col_out, b.inputs["Base Color"])

        rough_src = None
        if "Rough" in maps:
            rough_src = tex(maps["Rough"], False).outputs["Color"]
        elif "arm" in maps:
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(tex(maps["arm"], False).outputs["Color"], sep.inputs["Color"])
            rough_src = sep.outputs["Green"]
        if rough_src is not None:
            mr = nt.nodes.new("ShaderNodeMath")
            mr.operation = "MULTIPLY_ADD"
            mr.use_clamp = True
            nt.links.new(rough_src, mr.inputs[0])
            mr.inputs[1].default_value = rough_mul
            mr.inputs[2].default_value = rough_add
            nt.links.new(mr.outputs[0], b.inputs["Roughness"])
        if "nor_gl" in maps:
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.inputs["Strength"].default_value = normal_strength
            nt.links.new(tex(maps["nor_gl"], False).outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
        return m

    def glass_mat():
        """Thin window glass: transparent + fresnel reflection (lets sun/mist pass through)."""
        m = bpy.data.materials.new("glass")
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        tr.inputs["Color"].default_value = (0.96, 0.98, 0.97, 1)
        gl = nt.nodes.new("ShaderNodeBsdfGlossy")
        gl.inputs["Roughness"].default_value = 0.0
        lw = nt.nodes.new("ShaderNodeLayerWeight")
        lw.inputs["Blend"].default_value = 0.08
        mx = nt.nodes.new("ShaderNodeMixShader")
        nt.links.new(lw.outputs["Fresnel"], mx.inputs["Fac"])
        nt.links.new(tr.outputs[0], mx.inputs[1])
        nt.links.new(gl.outputs[0], mx.inputs[2])
        nt.links.new(mx.outputs[0], out.inputs["Surface"])
        return m

    M = {
        "wall": pbr("wall", "plaster", tint=(0.80, 0.77, 0.72), tint_amt=0.85, rough_mul=0.4, rough_add=0.55,
                    normal_strength=0.35),
        "accent": pbr("accent_wall", "plaster", tint=(0.30, 0.38, 0.35), tint_amt=0.85, rough_mul=0.4,
                      rough_add=0.55, normal_strength=0.35),
        "ceiling": pbr("ceiling", "plaster", tint=(0.95, 0.94, 0.92), tint_amt=0.95, rough_mul=0.3,
                       rough_add=0.65, normal_strength=0.2),
        "trim": principled("trim", (0.90, 0.90, 0.88), 0.35),
        "floor": pbr("oak_floor", "floor", rough_mul=0.8),
        "tile": pbr("bath_tile", "tile"),
        "marble": pbr("marble", "marble", rough_mul=0.5),
        "oak": pbr("oak", "oak"),
        "walnut": pbr("walnut", "walnut"),
        "linen": pbr("linen", "linen", tint=(0.92, 0.91, 0.88), tint_amt=0.5),
        "duvet": pbr("duvet", "linen", tint=(0.36, 0.45, 0.58), tint_amt=0.75),
        "curtain": pbr("curtain", "linen", tint=(0.86, 0.83, 0.76), tint_amt=0.6),
        "rug": pbr("rug", "linen", tint=(0.30, 0.27, 0.24), tint_amt=0.9, scale_mul=0.12, normal_strength=1.5),
        "runner": pbr("runner", "rugfab", tint=(0.45, 0.16, 0.12), tint_amt=-0.9, scale_mul=0.4),
        "grass": pbr("lawn", "grass", tint=(0.42, 0.62, 0.30), tint_amt=-1.0, scale_mul=1.5),
        "patio": pbr("patio", "patio"),
        "fence": pbr("fence", "planks", tint=(0.55, 0.45, 0.35), tint_amt=-0.6, rot90=True),
        "glass": glass_mat(),
        "frame": principled("window_frame", (0.05, 0.05, 0.05), 0.4),
        "fabric": principled("sofa_fabric", (0.42, 0.44, 0.46), 0.95),
        "black": principled("black_gloss", (0.01, 0.01, 0.01), 0.08),
        "cabinet": principled("cabinet", (0.88, 0.88, 0.86), 0.32),
        "steel": principled("steel", (0.8, 0.8, 0.8), 0.22, 1.0),
        "brass": principled("brass", (0.85, 0.65, 0.35), 0.3, 1.0),
        "mirror": principled("mirror", (0.95, 0.95, 0.95), 0.01, 1.0),
        "porcelain": principled("porcelain", (0.93, 0.93, 0.92), 0.08),
        "fixture": emissive("fixture", (1.0, 0.85, 0.65), 0.6),
        "shade": emissive("lampshade", (1.0, 0.86, 0.70), 2.0),
        "screen": principled("tv_screen", (0.005, 0.005, 0.006), 0.05),
    }
    rnd = random.Random(3)
    book_colors = [(0.45, 0.12, 0.08), (0.08, 0.18, 0.32), (0.75, 0.66, 0.48), (0.12, 0.28, 0.16),
                   (0.22, 0.22, 0.22), (0.62, 0.42, 0.18), (0.82, 0.80, 0.76)]
    M["books"] = [principled(f"book{i}", c, rnd.uniform(0.45, 0.8)) for i, c in enumerate(book_colors)]
    art_colors = [(0.70, 0.38, 0.25), (0.22, 0.32, 0.45), (0.80, 0.68, 0.40), (0.30, 0.42, 0.36)]
    M["art"] = [principled(f"art{i}", c, 0.85) for i, c in enumerate(art_colors)]

    # ------------------------------------------------------------ primitives
    def _obj(name, bm, mat, bevel=0.0, smooth=False):
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        if smooth:
            for p in me.polygons:
                p.use_smooth = True
        ob = bpy.data.objects.new(name, me)
        ob.data.materials.append(mat)
        coll.objects.link(ob)
        if bevel > 0:
            md = ob.modifiers.new("bevel", "BEVEL")
            md.width = bevel
            md.segments = 3
            md.limit_method = "ANGLE"
        return ob

    def box(name, x0, y0, z0, x1, y1, z1, mat, bevel=0.0):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        sx, sy, sz = abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)
        cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
        for v in bm.verts:
            v.co.x = v.co.x * sx + cx
            v.co.y = v.co.y * sy + cy
            v.co.z = v.co.z * sz + cz
        return _obj(name, bm, mat, min(bevel, sx / 2.1, sy / 2.1, sz / 2.1))

    def plane(name, x0, y0, x1, y1, z, mat=None):
        me = bpy.data.meshes.new(name)
        me.from_pydata([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], [], [(0, 1, 2, 3)])
        ob = bpy.data.objects.new(name, me)
        if mat:
            ob.data.materials.append(mat)
        coll.objects.link(ob)
        return ob

    def cyl(name, x, y, z0, z1, r, mat, segs=48):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                              radius1=r, radius2=r, depth=z1 - z0)
        for v in bm.verts:
            v.co += Vector((x, y, (z0 + z1) / 2))
        for f in bm.faces:
            f.smooth = abs(f.normal.z) < 0.5
        return _obj(name, bm, mat)

    def cone(name, x, y, z0, z1, r0, r1, mat, segs=48):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                              radius1=r0, radius2=r1, depth=z1 - z0)
        for v in bm.verts:
            v.co += Vector((x, y, (z0 + z1) / 2))
        for f in bm.faces:
            f.smooth = abs(f.normal.z) < 0.9
        return _obj(name, bm, mat)

    def sphere(name, x, y, z, r, mat, sz=1.0):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r)
        for v in bm.verts:
            v.co.z *= sz
            v.co += Vector((x, y, z))
        return _obj(name, bm, mat, smooth=True)

    def curtain(name, axis, c, s, e, inward, z0=0.02, z1=2.58, folds=5, depth=0.05):
        """Pleated fabric panel hanging just inside a wall."""
        nx, nz = 64, 2
        verts, faces = [], []
        for j in range(nz):
            z = z0 + (z1 - z0) * j / (nz - 1)
            for i in range(nx):
                u = i / (nx - 1)
                along = s + (e - s) * u
                off = inward * (0.16 + depth * 0.5 * (1 + math.sin(u * folds * 2 * math.pi)))
                verts.append((along, c + off, z) if axis == "x" else (c + off, along, z))
        for j in range(nz - 1):
            for i in range(nx - 1):
                a = j * nx + i
                faces.append((a, a + 1, a + nx + 1, a + nx))
        me = bpy.data.meshes.new(name)
        me.from_pydata(verts, [], faces)
        for p in me.polygons:
            p.use_smooth = True
        ob = bpy.data.objects.new(name, me)
        ob.data.materials.append(M["curtain"])
        coll.objects.link(ob)
        sol = ob.modifiers.new("thick", "SOLIDIFY")
        sol.thickness = 0.004

    # ------------------------------------------------------------ Poly Haven model import
    # source models live only in bpy.data (NOT linked to the scene) -> only placed instances render
    asset_root = bpy.data.collections.new("polyhaven_assets")
    asset_root.use_fake_user = True
    model_cache = {}
    baked = set()

    def pick_variants(names):
        """Poly Haven files hold LOD copies, leaf/branch parts and scatter helpers. Keep full-detail variants."""
        def bad(n):
            n = n.lower()
            return any(k in n for k in ("geometry", "geonodes", "leaves", "branches", "trunk", "_lod1", "_lod2", "_lod3"))
        lod0 = [n for n in names if n.lower().endswith("_lod0")]
        pool = lod0 or names
        good = [n for n in pool if not bad(n)]
        if not good:
            good = [n for n in pool if "_lod1" not in n.lower() and "_lod2" not in n.lower()] or pool
        return good, bool(lod0)

    def keep_whole(names):
        """Props/furniture: keep every part (pot + leaves etc.), drop only LOD copies and helpers."""
        return [n for n in names if not any(k in n.lower() for k in ("geometry", "geonodes", "_lod1", "_lod2", "_lod3"))] or names

    def model(mid):
        """Append only full-detail variant objects; return (list of per-variant collections, max dims)."""
        if mid in model_cache:
            return model_cache[mid]
        path = manifest["models"][mid]
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            names = list(src.objects)
            keep, has_lod = pick_variants(names)
            split = has_lod or mid in SCATTER
            if not split:
                keep = keep_whole(names)
            dst.objects = keep
        objs = [o for o in dst.objects if o is not None and o.type == "MESH"]
        base = os.path.dirname(path)
        for img in bpy.data.images:
            if img.filepath and not os.path.exists(bpy.path.abspath(img.filepath)):
                cand = os.path.join(base, "textures", os.path.basename(img.filepath))
                if os.path.exists(cand):
                    img.filepath = cand
        variants, dmax = [], Vector((0, 0, 0))
        parent = bpy.data.collections.new(f"M_{mid}")
        asset_root.children.link(parent)
        groups = [[o] for o in objs] if split else [objs]
        for grp in groups:
            c = bpy.data.collections.new(f"V_{grp[0].name}")
            parent.children.link(c)
            lo = Vector((1e9, 1e9, 1e9))
            hi = Vector((-1e9, -1e9, -1e9))
            for o in grp:
                if any(m.type == "NODES" for m in o.modifiers):
                    o.modifiers.clear()
                c.objects.link(o)
                for corner in o.bound_box:
                    w = o.matrix_world @ Vector(corner)
                    lo = Vector(map(min, lo, w))
                    hi = Vector(map(max, hi, w))
            off = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
            if mid in SCATTER:
                for o in grp:
                    if o.data.name not in baked:
                        o.data.transform(Matrix.Translation(o.matrix_world.inverted().to_3x3() @ -off))
                        baked.add(o.data.name)
                c.instance_offset = (0, 0, 0)
            else:
                c.instance_offset = off
            d = hi - lo
            dmax = Vector(map(max, dmax, d))
            variants.append((c, d))
        model_cache[mid] = (variants, dmax, parent)
        return model_cache[mid]

    placed = {}

    def place(mid, x, y, z=0.0, rot=0.0, fit="h", size=None, name=None, hang=False):
        """Instance a model. rot (deg): 0 = model front faces -Y; -90 faces -X; 90 faces +X; 180 faces +Y.
        fit: 'h' height, 'len' longest horizontal side. hang=True: z is the TOP of the object."""
        variants, _, _ = model(mid)
        c, d = variants[len(placed) % len(variants)]
        if size is None:
            s = 1.0
        elif fit == "h":
            s = size / max(d.z, 1e-3)
        else:
            s = size / max(d.x, d.y, 1e-3)
        ob = bpy.data.objects.new(name or f"I_{mid}", None)
        ob.instance_type = "COLLECTION"
        ob.instance_collection = c
        ob.location = (x, y, z - (d.z * s if hang else 0))
        ob.rotation_euler = (0, 0, math.radians(rot))
        ob.scale = (s, s, s)
        coll.objects.link(ob)
        top = ob.location.z + d.z * s
        placed[ob.name] = top
        return ob, top

    # ------------------------------------------------------------ walls
    T = 0.15
    portals = []

    def wall(name, axis, c, a, b, openings=(), mat=None):
        mat = mat or M["wall"]

        def seg(s, e, z0, z1, tag):
            if e - s < 1e-4 or z1 - z0 < 1e-4:
                return
            if axis == "x":
                box(f"{name}_{tag}", s, c - T / 2, z0, e, c + T / 2, z1, mat)
            else:
                box(f"{name}_{tag}", c - T / 2, s, z0, c + T / 2, e, z1, mat)

        def baseboard(s, e, tag):
            if e - s < 1e-4:
                return
            for side in (-1, 1):
                off = side * (T / 2 + 0.008)
                if axis == "x":
                    box(f"{name}_bb{tag}{side}", s, c + off - 0.008, 0, e, c + off + 0.008, 0.1, M["trim"], 0.003)
                else:
                    box(f"{name}_bb{tag}{side}", c + off - 0.008, s, 0, c + off + 0.008, e, 0.1, M["trim"], 0.003)

        ops = sorted(openings)
        cur = a - T / 2
        end = b + T / 2
        for i, (s, e, z0, z1, kind) in enumerate(ops):
            seg(cur, s, 0, H, f"s{i}")
            baseboard(cur, s, f"s{i}")
            seg(s, e, 0, z0, f"below{i}")
            if z0 > 0:
                baseboard(s, e, f"b{i}")
            seg(s, e, z1, H, f"above{i}")
            if kind in ("window", "glass_door"):
                add_window(f"{name}_w{i}", axis, c, s, e, z0, z1, kind)
            cur = e
        seg(cur, end, 0, H, "end")
        baseboard(cur, end, "end")

    def add_window(name, axis, c, s, e, z0, z1, kind):
        fw = 0.05

        def rect(tag, s0, s1, za, zb, depth, mat, bevel=0.0):
            if axis == "x":
                return box(f"{name}_{tag}", s0, c - depth / 2, za, s1, c + depth / 2, zb, mat, bevel)
            return box(f"{name}_{tag}", c - depth / 2, s0, za, c + depth / 2, s1, zb, mat, bevel)

        rect("fl", s, s + fw, z0, z1, T * 0.6, M["frame"], 0.004)
        rect("fr", e - fw, e, z0, z1, T * 0.6, M["frame"], 0.004)
        rect("ft", s, e, z1 - fw, z1, T * 0.6, M["frame"], 0.004)
        rect("fb", s, e, z0, z0 + fw, T * 0.6, M["frame"], 0.004)
        mid = (s + e) / 2
        rect("fm", mid - fw / 2, mid + fw / 2, z0, z1, T * 0.6, M["frame"], 0.004)
        g = rect("glass", s + fw, e - fw, z0 + fw, z1 - fw, 0.01, M["glass"])
        g.visible_shadow = False
        if kind == "window":
            rect("sill", s - 0.05, e + 0.05, z0 - 0.03, z0, T + 0.08, M["marble"], 0.005)
        portals.append((axis, c, s, e, z0, z1))

    W, D = 12.0, 10.0
    wall("south", "x", 0, 0, W, [
        (1.0, 2.6, 0.8, 2.25, "window"), (3.4, 5.0, 0.8, 2.25, "window"),
        (6.6, 8.2, 0.0, 2.3, "glass_door"),
    ])
    wall("north", "x", D, 0, W, [
        (1.5, 3.5, 0.9, 2.2, "window"), (6.1, 7.0, 1.55, 2.2, "window"),
        (9.5, 11.0, 0.9, 2.2, "window"),
    ])
    wall("west", "y", 0, 0, D, [(5.15, 6.35, 0.0, 2.2, "door")])
    wall("east", "y", W, 0, D, [
        (1.5, 3.5, 1.15, 2.15, "window"), (7.5, 9.0, 0.9, 2.2, "window"),
    ])
    wall("liv_kit", "y", 6.0, 0, 5.0, [(0.8, 4.2, 0.0, 2.4, "open")])
    wall("hall_s", "x", 5.0, 0, W, [(1.5, 3.5, 0.0, 2.4, "open"), (8.0, 10.0, 0.0, 2.4, "open")])
    wall("hall_n", "x", 6.5, 0, W, [
        (3.6, 4.5, 0.0, 2.1, "open"), (6.0, 6.9, 0.0, 2.1, "open"), (9.0, 9.9, 0.0, 2.1, "open"),
    ])
    wall("bed_bath", "y", 5.0, 6.5, D)
    wall("bath_off", "y", 8.0, 6.5, D)

    box("accent_bed", T / 2, 6.5 + T / 2, 0.1, T / 2 + 0.005, D - T / 2, H, M["accent"])

    for i, (s, e) in enumerate([(3.6, 4.5), (6.0, 6.9), (9.0, 9.9)]):
        for side in (-1, 1):
            y = 6.5 + side * (T / 2 + 0.01)
            box(f"case{i}{side}l", s - 0.06, y - 0.01, 0, s, y + 0.01, 2.16, M["trim"], 0.003)
            box(f"case{i}{side}r", e, y - 0.01, 0, e + 0.06, y + 0.01, 2.16, M["trim"], 0.003)
            box(f"case{i}{side}t", s - 0.06, y - 0.01, 2.1, e + 0.06, y + 0.01, 2.16, M["trim"], 0.003)

    box("front_door", -0.04, 5.15, 0, 0.02, 6.35, 2.2, M["walnut"], 0.005)
    cyl("door_knob", 0.05, 6.15, 1.0, 1.06, 0.03, M["brass"])

    box("floor", -0.2, -0.2, -0.1, W + 0.2, D + 0.2, 0.0, M["floor"])
    box("bath_tile", 5.0, 6.5, 0.0, 8.0, D, 0.004, M["tile"])
    box("ceiling", -0.2, -0.2, H, W + 0.2, D + 0.2, H + 0.12, M["ceiling"])
    box("roof_slab", -0.6, -0.6, H + 0.12, W + 0.6, D + 0.6, H + 0.35, principled("fascia", (0.15, 0.15, 0.15), 0.6))
    box("ground", -150, -150, -0.4, 150, 150, -0.1, M["grass"])
    box("patio", 5.6, -3.4, -0.1, 9.4, -0.08, -0.03, M["patio"], 0.01)

    # curtains
    for i, (s, e) in enumerate([(0.55, 1.05), (2.62, 3.38), (4.95, 5.45)]):
        curtain(f"curtain_liv{i}", "x", 0, s, e, +1)
    for i, (s, e) in enumerate([(1.05, 1.55), (3.45, 3.95)]):
        curtain(f"curtain_bed{i}", "x", D, s, e, -1)
    box("rod_liv", 0.5, 0.2, 2.6, 5.5, 0.22, 2.62, M["black"])
    box("rod_bed", 1.0, D - 0.22, 2.6, 4.0, D - 0.2, 2.62, M["black"])

    # ------------------------------------------------------------ interior furniture
    # LIVING
    box("tv_console", 0.1, 1.5, 0, 0.5, 3.5, 0.5, M["walnut"], 0.01)
    box("tv", 0.09, 1.8, 1.0, 0.14, 3.2, 1.8, M["black"], 0.005)
    box("tv_screen", 0.141, 1.83, 1.03, 0.143, 3.17, 1.77, M["screen"])
    box("rug", 1.3, 1.2, 0.0, 4.6, 3.9, 0.012, M["rug"], 0.005)
    place("Sofa_01", 4.55, 2.5, 0, -90, "len", 2.3)
    place("modern_arm_chair_01", 2.0, 0.95, 0, 180, "h", 0.85)
    _, ct = place("modern_coffee_table_01", 3.3, 2.5, 0.012, 90, "len", 1.15)
    box("table_book", 3.05, 2.3, ct, 3.35, 2.52, ct + 0.035, M["books"][1], 0.003)
    box("table_book2", 3.08, 2.33, ct + 0.035, 3.3, 2.5, ct + 0.06, M["books"][2], 0.003)
    place("ceramic_vase_01", 3.55, 2.75, ct, 0, "h", 0.22, name="table_vase")
    _, st = place("side_table_01", 4.6, 0.95, 0, 0, "len", 0.5)
    cyl("lamp_base", 5.45, 0.55, 0, 0.03, 0.15, M["black"])
    cyl("lamp_pole", 5.45, 0.55, 0.03, 1.5, 0.012, M["black"], 12)
    cone("lamp_shade", 5.45, 0.55, 1.45, 1.75, 0.22, 0.16, M["shade"])
    place("potted_plant_02", 0.5, 0.55, 0, 0, "h", 1.15)
    place("potted_plant_01", 5.5, 4.25, 0, 0, "h", 0.9)
    place("potted_plant_04", 0.3, 3.2, 0.5, 0, "h", 0.28)
    place("standing_picture_frame_01", 0.3, 1.75, 0.5, 90, "h", 0.24)
    # bookshelf
    box("shelf_back", 4.0, 4.89, 0, 5.7, 4.92, 2.0, M["oak"])
    box("shelf_side_l", 4.0, 4.6, 0, 4.03, 4.92, 2.0, M["oak"], 0.003)
    box("shelf_side_r", 5.67, 4.6, 0, 5.7, 4.92, 2.0, M["oak"], 0.003)
    box("shelf_top", 4.0, 4.6, 1.97, 5.7, 4.92, 2.0, M["oak"], 0.003)
    box("shelf_bottom", 4.0, 4.6, 0, 5.7, 4.92, 0.08, M["oak"], 0.003)
    for lvl in range(4):
        z = 0.08 + lvl * 0.48
        box(f"shelf_board{lvl}", 4.02, 4.58, z + 0.36, 5.68, 4.6, z + 0.38, M["oak"])
        x = 4.08
        while x < 5.55:
            w = rnd.uniform(0.025, 0.06)
            h = rnd.uniform(0.2, 0.31)
            if rnd.random() < 0.8:
                box(f"book{lvl}_{x:.2f}", x, 4.62 + rnd.uniform(0, 0.03), z, x + w, 4.85, z + h,
                    rnd.choice(M["books"]), 0.003)
            x += w + 0.004

    # KITCHEN
    box("base_cab", 11.35, 0.6, 0.08, 11.925, 3.9, 0.86, M["cabinet"], 0.005)
    box("toe_kick", 11.4, 0.6, 0, 11.925, 3.9, 0.08, M["black"])
    box("counter", 11.3, 0.58, 0.86, 11.925, 3.92, 0.9, M["marble"], 0.004)
    box("backsplash", 11.915, 0.6, 0.9, 11.925, 3.9, 1.15, M["marble"])
    for i in range(5):
        y = 0.6 + i * 0.66
        box(f"cab_gap{i}", 11.345, y - 0.003, 0.1, 11.35, y + 0.003, 0.84, M["black"])
        box(f"cab_pull{i}", 11.33, y + 0.25, 0.75, 11.345, y + 0.41, 0.77, M["steel"], 0.003)
    box("upper_cab1", 11.6, 0.6, 1.45, 11.925, 1.42, 2.25, M["cabinet"], 0.005)
    box("upper_cab2", 11.6, 3.6, 1.45, 11.925, 3.92, 2.25, M["cabinet"], 0.005)
    box("sink", 11.45, 2.1, 0.86, 11.8, 2.9, 0.905, M["steel"], 0.01)
    cyl("faucet", 11.85, 2.5, 0.9, 1.25, 0.015, M["steel"], 16)
    box("faucet_spout", 11.65, 2.485, 1.22, 11.86, 2.515, 1.25, M["steel"], 0.005)
    box("stove", 11.4, 0.85, 0.905, 11.85, 1.45, 0.91, M["black"])
    box("fridge", 11.25, 4.0, 0, 11.925, 4.85, 2.05, M["steel"], 0.01)
    box("fridge_gap", 11.245, 4.0, 1.3, 11.25, 4.85, 1.31, M["black"])
    box("island", 9.65, 1.6, 0, 10.35, 3.4, 0.86, M["walnut"], 0.005)
    box("island_top", 9.4, 1.55, 0.86, 10.4, 3.45, 0.9, M["marble"], 0.004)
    for i, sy in enumerate([1.9, 2.5, 3.1]):
        place("bar_chair_round_01", 9.05, sy, 0, -90, "h", 0.72, name=f"stool{i}")
        place("modern_ceiling_lamp_01", 9.9, sy, H, 0, "h", 1.0, name=f"pendant{i}", hang=True)
    _, bt = place("wooden_bowl_01", 10.0, 2.5, 0.9, 0, "len", 0.34)
    for i, (dx, dy) in enumerate([(-0.05, 0.0), (0.05, 0.03), (0.0, -0.06)]):
        place("food_apple_01", 10.0 + dx, 2.5 + dy, 0.92, rnd.uniform(0, 360), "len", 0.08, name=f"apple{i}")
    # dining
    box("dining_top", 6.7, 1.0, 0.72, 7.9, 2.3, 0.76, M["oak"], 0.01)
    for i, (lx, ly) in enumerate([(6.78, 1.08), (7.82, 1.08), (6.78, 2.22), (7.82, 2.22)]):
        box(f"dining_leg{i}", lx - 0.03, ly - 0.03, 0, lx + 0.03, ly + 0.03, 0.72, M["oak"], 0.004)
    for i, (cx, cy, r) in enumerate([(7.0, 0.72, 180), (7.6, 0.72, 180), (7.0, 2.58, 0), (7.6, 2.58, 0)]):
        place("dining_chair_02", cx, cy, 0, r, "h", 0.98, name=f"dchair{i}")
    place("ceramic_vase_01", 7.3, 1.65, 0.76, 0, "h", 0.3)

    # HALLWAY
    box("runner", 0.8, 5.45, 0.0, 11.4, 6.05, 0.01, M["runner"], 0.004)
    box("console", 1.0, 6.12, 0.75, 2.2, 6.42, 0.79, M["walnut"], 0.005)
    for i, lx in enumerate([1.05, 2.15]):
        box(f"console_leg{i}", lx - 0.02, 6.14, 0, lx + 0.02, 6.4, 0.75, M["walnut"])
    place("ceramic_vase_01", 1.4, 6.27, 0.79, 0, "h", 0.36, name="hall_vase")
    box("hall_mirror", 1.2, 6.415, 1.1, 2.0, 6.42, 1.9, M["mirror"])
    arts = [(4.6, 5.6, 5.08, "s"), (6.4, 7.6, 5.08, "s"), (10.4, 11.4, 5.08, "s"), (7.2, 8.6, 6.42, "n")]
    for i, (a, b, y, side) in enumerate(arts):
        d = 0.03 if side == "s" else -0.03
        y0, y1 = sorted((y, y + d))
        box(f"art_frame{i}", a, y0, 1.25, b, y1, 2.0, M["black"], 0.003)
        yy0, yy1 = (y1, y1 + 0.003) if side == "s" else (y0 - 0.003, y0)
        box(f"art_canvas{i}", a + 0.05, yy0, 1.3, b - 0.05, yy1, 1.95, M["art"][i % 4])

    # BEDROOM
    box("headboard", 0.09, 7.3, 0, 0.2, 9.1, 1.15, M["fabric"], 0.03)
    box("bed_frame", 0.2, 7.35, 0.15, 2.3, 9.05, 0.4, M["oak"], 0.01)
    box("mattress", 0.22, 7.4, 0.4, 2.25, 9.0, 0.62, M["linen"], 0.05)
    box("duvet", 0.85, 7.36, 0.6, 2.3, 9.04, 0.68, M["duvet"], 0.04)
    box("pillow_a", 0.3, 7.5, 0.62, 0.75, 8.15, 0.78, M["linen"], 0.07)
    box("pillow_b", 0.3, 8.25, 0.62, 0.75, 8.9, 0.78, M["linen"], 0.07)
    place("throw_pillows_01", 0.62, 8.2, 0.7, 90, "len", 0.6)
    for i, ny in enumerate([(6.8, 7.25), (9.15, 9.6)]):
        box(f"nightstand{i}", 0.1, ny[0], 0, 0.55, ny[1], 0.55, M["walnut"], 0.01)
        cx, cy = 0.33, (ny[0] + ny[1]) / 2
        cyl(f"bedlamp_base{i}", cx, cy, 0.55, 0.85, 0.05, M["porcelain"])
        cone(f"bedlamp_shade{i}", cx, cy, 0.85, 1.08, 0.14, 0.11, M["shade"])
    box("wardrobe", 4.3, 8.0, 0, 4.92, 9.8, 2.25, M["oak"], 0.006)
    box("wardrobe_gap", 4.295, 8.895, 0.05, 4.3, 8.905, 2.2, M["black"])
    for i, wy in enumerate([8.8, 9.0]):
        box(f"wardrobe_pull{i}", 4.28, wy - 0.01, 1.0, 4.3, wy + 0.01, 1.3, M["brass"])
    box("bed_rug", 1.4, 7.0, 0.0, 3.3, 9.5, 0.012, M["rug"], 0.004)
    place("potted_plant_01", 4.55, 7.05, 0, 0, "h", 0.95, name="bed_plant")

    # BATH
    box("tub_outer", 5.08, 9.15, 0, 6.85, 9.92, 0.56, M["porcelain"], 0.04)
    box("tub_inner", 5.18, 9.25, 0.12, 6.75, 9.82, 0.565, principled("water", (0.8, 0.85, 0.9), 0.02))
    box("bath_wainscot", 5.08, 9.92, 0, 7.92, 9.925, 1.25, M["tile"])
    box("vanity", 7.45, 7.2, 0.1, 7.92, 8.4, 0.82, M["walnut"], 0.006)
    box("vanity_top", 7.42, 7.18, 0.82, 7.925, 8.42, 0.86, M["marble"], 0.005)
    sphere("basin", 7.68, 7.8, 0.86, 0.17, M["porcelain"], 0.35)
    cyl("bath_faucet", 7.88, 7.8, 0.86, 1.05, 0.012, M["steel"], 12)
    box("bath_mirror", 7.9, 7.3, 1.15, 7.925, 8.3, 2.05, M["mirror"])
    box("toilet_bowl", 5.1, 7.0, 0, 5.65, 7.42, 0.42, M["porcelain"], 0.08)
    box("toilet_tank", 5.08, 6.98, 0.42, 5.28, 7.44, 0.8, M["porcelain"], 0.03)
    box("towel_bar", 6.2, 9.9, 1.2, 6.9, 9.92, 1.22, M["steel"])
    box("towel", 6.25, 9.86, 0.85, 6.85, 9.9, 1.22, pbr("towel", "linen", tint=(0.85, 0.80, 0.72), tint_amt=0.7), 0.01)
    place("potted_plant_04", 7.7, 8.25, 0.86, 0, "h", 0.25, name="bath_succ")

    # OFFICE
    box("desk_top", 11.1, 7.5, 0.72, 11.9, 9.0, 0.76, M["oak"], 0.006)
    for i, (lx, ly) in enumerate([(11.15, 7.55), (11.85, 7.55), (11.15, 8.95), (11.85, 8.95)]):
        box(f"desk_leg{i}", lx - 0.02, ly - 0.02, 0, lx + 0.02, ly + 0.02, 0.72, M["black"])
    box("monitor", 11.75, 7.9, 0.95, 11.78, 8.6, 1.35, M["black"], 0.004)
    box("monitor_screen", 11.745, 7.92, 0.97, 11.75, 8.58, 1.33, M["screen"])
    box("monitor_stand", 11.74, 8.22, 0.76, 11.8, 8.28, 0.95, M["black"])
    place("modern_arm_chair_01", 10.65, 8.25, 0, 90, "h", 0.85, name="office_chair")
    box("oshelf_back", 8.08, 7.0, 0, 8.11, 9.5, 2.0, M["walnut"])
    box("oshelf_side_a", 8.08, 7.0, 0, 8.4, 7.03, 2.0, M["walnut"], 0.003)
    box("oshelf_side_b", 8.08, 9.47, 0, 8.4, 9.5, 2.0, M["walnut"], 0.003)
    box("oshelf_top", 8.08, 7.0, 1.97, 8.4, 9.5, 2.0, M["walnut"], 0.003)
    box("oshelf_bottom", 8.08, 7.0, 0, 8.4, 9.5, 0.08, M["walnut"], 0.003)
    for lvl in range(4):
        z = 0.08 + lvl * 0.48
        box(f"oshelf_board{lvl}", 8.4, 7.02, z + 0.36, 8.42, 9.48, z + 0.38, M["walnut"])
        y = 7.06
        while y < 9.4:
            w = rnd.uniform(0.025, 0.06)
            h = rnd.uniform(0.2, 0.31)
            if rnd.random() < 0.8:
                box(f"obook{lvl}_{y:.2f}", 8.12 + rnd.uniform(0, 0.03), y, z, 8.38, y + w, z + h,
                    rnd.choice(M["books"]), 0.003)
            y += w + 0.004
    place("potted_plant_02", 11.5, 9.5, 0, 0, "h", 1.2, name="office_plant")

    # ------------------------------------------------------------ exterior
    place("outdoor_table_chair_set_01", 7.4, -1.8, -0.03, 0, "len", 1.5)
    place("planter_box_01", 5.0, -0.7, -0.1, 0, "len", 0.9)
    erng = random.Random(21)
    # foundation shrubs hugging the house (seen just outside the windows)
    shrubs = ["shrub_02", "shrub_02", "shrub_04"]
    for i, (sx, sy) in enumerate([(0.6, -0.9), (2.0, -0.9), (3.0, -1.0), (4.4, -0.9), (10.4, -0.9), (11.4, -1.0),
                                  (1.0, 10.9), (2.5, 10.9), (3.6, 11.0), (6.6, 10.9), (9.8, 10.9), (11.0, 10.9),
                                  (12.9, 1.0), (12.9, 2.5), (12.9, 3.8), (12.9, 7.6), (12.9, 9.0),
                                  (-0.9, 1.5), (-0.9, 3.5), (-0.9, 8.0)]):
        place(erng.choice(shrubs), sx, sy, -0.1, erng.uniform(0, 360), "h", erng.uniform(0.7, 1.15), name=f"shrub{i}")
    # yard trees (mid-ground parallax through the windows)
    trees = [("jacaranda_tree", 7.5), ("tree_small_02", 6.0), ("island_tree_01", 8.0), ("island_tree_02", 7.0)]
    tree_spots = [(-6, -8), (3, -11), (14, -9), (20, -3), (19, 6), (17, 15), (8, 17), (-2, 16), (-8, 9),
                  (-9, 1), (-14, -14), (26, -12), (25, 20), (-12, 22), (10, 26), (-20, 5)]
    for i, (tx, ty) in enumerate(tree_spots):
        mid, hgt = trees[i % len(trees)]
        place(mid, tx + erng.uniform(-1, 1), ty + erng.uniform(-1, 1), -0.1, erng.uniform(0, 360), "h",
              hgt * erng.uniform(0.8, 1.2), name=f"tree{i}")
    # wooden privacy fence around the yard
    fx0, fy0, fx1, fy1 = -12.0, -14.0, 24.0, 24.0
    fmat = M["fence"]

    def fence_run(axis, c, a, b):
        n = int((b - a) / 2.4)
        for k in range(n + 1):
            p = a + (b - a) * k / n
            if axis == "x":
                box(f"fpost_{axis}{c}_{k}", p - 0.05, c - 0.05, -0.1, p + 0.05, c + 0.05, 1.85, fmat, 0.005)
            else:
                box(f"fpost_{axis}{c}_{k}", c - 0.05, p - 0.05, -0.1, c + 0.05, p + 0.05, 1.85, fmat, 0.005)
        if axis == "x":
            box(f"fboard_{axis}{c}", a, c + 0.05, -0.05, b, c + 0.07, 1.8, fmat)
        else:
            box(f"fboard_{axis}{c}", c + 0.05, a, -0.05, c + 0.07, b, 1.8, fmat)

    fence_run("x", fy0, fx0, fx1)
    fence_run("x", fy1, fx0, fx1)
    fence_run("y", fx0, fy0, fy1)
    fence_run("y", fx1, fy0, fy1)

    # ------------------------------------------------------------ geometry-node scatter (lawn)
    def scatter(emitter, mid, density, smin, smax, seed):
        _, d, c = model(mid)
        ng = bpy.data.node_groups.new(f"scatter_{mid}_{seed}", "GeometryNodeTree")
        ng.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        ng.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
        n = ng.nodes
        gi = n.new("NodeGroupInput")
        go = n.new("NodeGroupOutput")
        dist = n.new("GeometryNodeDistributePointsOnFaces")
        dist.inputs["Density"].default_value = density
        dist.inputs["Seed"].default_value = seed
        ci = n.new("GeometryNodeCollectionInfo")
        ci.inputs["Collection"].default_value = c
        ci.transform_space = "ORIGINAL"
        ci.inputs["Separate Children"].default_value = True
        ci.inputs["Reset Children"].default_value = True
        iop = n.new("GeometryNodeInstanceOnPoints")
        iop.inputs["Pick Instance"].default_value = True
        rr = n.new("FunctionNodeRandomValue")
        rr.data_type = "FLOAT_VECTOR"
        rr.inputs[0].default_value = (0, 0, 0)
        rr.inputs[1].default_value = (0.08, 0.08, 2 * math.pi)
        rr.inputs["Seed"].default_value = seed + 1
        rs = n.new("FunctionNodeRandomValue")
        rs.data_type = "FLOAT"
        rs.inputs[2].default_value = smin
        rs.inputs[3].default_value = smax
        rs.inputs["Seed"].default_value = seed + 2
        join = n.new("GeometryNodeJoinGeometry")
        L = ng.links
        L.new(gi.outputs["Geometry"], dist.inputs["Mesh"])
        L.new(dist.outputs["Points"], iop.inputs["Points"])
        L.new(ci.outputs["Instances"], iop.inputs["Instance"])
        L.new(rr.outputs[0], iop.inputs["Rotation"])
        L.new(rs.outputs[1], iop.inputs["Scale"])
        L.new(iop.outputs["Instances"], join.inputs["Geometry"])
        L.new(join.outputs["Geometry"], go.inputs["Geometry"])
        md = emitter.modifiers.new(f"scatter_{mid}", "NODES")
        md.node_group = ng

    lawn_rects = [(-12, -14, 5.4, -1.2), (9.6, -14, 24, -1.2), (5.4, -14, 9.6, -4.2),
                  (-12, 11.2, 24, 24), (-12, -1.2, -1.2, 11.2), (13.2, -1.2, 24, 11.2)]
    gv, _, _ = model("grass_bermuda_01")
    clump_area = max(sum(v[1].x * v[1].y for v in gv) / len(gv), 0.002)
    # dense lawn ring within ~8 m of the house (what the windows see), sparser beyond
    near = [(-8, -8, 5.4, -1.2), (9.6, -8, 20, -1.2), (5.4, -8, 9.6, -4.2),
            (-8, 11.2, 20, 18), (-8, -1.2, -1.2, 11.2), (13.2, -1.2, 20, 11.2)]
    for i, (x0, y0, x1, y1) in enumerate(near):
        em = plane(f"lawn_near{i}", x0, y0, x1, y1, -0.099)
        scatter(em, "grass_bermuda_01", min(2.5 / clump_area, 1100.0), 1.0, 1.8, 200 + i)
    for i, (x0, y0, x1, y1) in enumerate(lawn_rects):
        em = plane(f"lawn_emit{i}", x0, y0, x1, y1, -0.1)
        scatter(em, "grass_bermuda_01", min(1.0 / clump_area, 250.0), 1.0, 1.8, 10 + i)
        scatter(em, "celandine_01", 0.05, 0.6, 1.0, 40 + i)
        scatter(em, "dandelion_01", 0.08, 0.7, 1.1, 70 + i)
    # taller grass tufts along the fence line
    for i, (x0, y0, x1, y1) in enumerate([(fx0, fy0, fx1, fy0 + 1.2), (fx0, fy1 - 1.2, fx1, fy1),
                                          (fx0, fy0, fx0 + 1.2, fy1), (fx1 - 1.2, fy0, fx1, fy1)]):
        em = plane(f"fence_emit{i}", x0, y0, x1, y1, -0.1)
        scatter(em, "grass_medium_01", 0.25, 0.6, 1.0, 100 + i)

    # ------------------------------------------------------------ HDRI sky + auto sun alignment
    world = bpy.data.worlds.new("sky")
    scene.world = world
    world.use_nodes = True
    wn = world.node_tree.nodes
    wl = world.node_tree.links
    env = wn.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(manifest["hdri"])
    img = env.image
    w_, h_ = img.size
    px = np.empty(w_ * h_ * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h_, w_, 4)[:, :, :3]
    lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    vi, ui = np.unravel_index(np.argmax(lum), lum.shape)
    u, v = (ui + 0.5) / w_, (vi + 0.5) / h_          # Blender pixels: row 0 = bottom
    phi = (u - 0.5) * 2 * math.pi
    elev = (v - 0.5) * math.pi
    sun_dir = Vector((-math.cos(phi) * math.cos(elev), math.sin(phi) * math.cos(elev), math.sin(elev)))
    # irradiance hidden in the sun hotspot -> sun lamp strength/colour (energy-consistent)
    CLAMP = 25.0
    mask = lum > CLAMP
    rows = np.nonzero(mask)[0]
    row_elev = ((rows + 0.5) / h_ - 0.5) * math.pi
    d_omega = (2 * math.pi / w_) * (math.pi / h_) * np.cos(row_elev)
    excess = np.clip(px[mask] - CLAMP, 0, None)
    sun_rgb = (excess * d_omega[:, None]).sum(axis=0)
    sun_E = float(sun_rgb @ np.array([0.2126, 0.7152, 0.0722]))
    sun_col = tuple(float(c) for c in (sun_rgb / max(sun_rgb.max(), 1e-6)))
    # rotate the HDRI so its sun sits south-south-west (shines through the south windows)
    want_az = math.radians(-115)                 # azimuth of sun position (from +X, CCW)
    have_az = math.atan2(sun_dir.y, sun_dir.x)
    rot = have_az - want_az
    tc = wn.new("ShaderNodeTexCoord")
    mp = wn.new("ShaderNodeMapping")
    mp.inputs["Rotation"].default_value = (0, 0, rot)
    wl.new(tc.outputs["Generated"], mp.inputs["Vector"])
    wl.new(mp.outputs["Vector"], env.inputs["Vector"])
    clamp = wn.new("ShaderNodeVectorMath")
    clamp.operation = "MINIMUM"
    clamp.inputs[1].default_value = (CLAMP, CLAMP, CLAMP)
    wl.new(env.outputs["Color"], clamp.inputs[0])
    bg = wn["Background"]
    bg.inputs["Strength"].default_value = 1.0
    wl.new(clamp.outputs["Vector"], bg.inputs["Color"])
    world.mist_settings.start = 25
    world.mist_settings.depth = 180
    world.mist_settings.falloff = "QUADRATIC"

    def light(name, kind, loc, direction, energy, color=(1, 1, 1), size=1.0, size_y=None, portal=False):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        if kind == "AREA":
            ld.shape = "RECTANGLE" if size_y else "DISK"
            ld.size = size
            if size_y:
                ld.size_y = size_y
            if portal:
                try:
                    ld.cycles.is_portal = True
                except AttributeError:
                    pass
        elif kind == "SUN":
            ld.angle = math.radians(0.8)
        ob = bpy.data.objects.new(name, ld)
        ob.location = loc
        up = "Y" if abs(direction[2]) < 0.99 else "X"
        ob.rotation_euler = Vector(direction).to_track_quat("-Z", up).to_euler()
        coll.objects.link(ob)
        return ob

    sun_pos = Vector((math.cos(want_az) * math.cos(elev), math.sin(want_az) * math.cos(elev), math.sin(elev)))
    light("sun", "SUN", (0, 0, 30), tuple(-sun_pos), max(sun_E, 1.0), sun_col)

    for i, (axis, c, s, e, z0, z1) in enumerate(portals):
        mid, zc = (s + e) / 2, (z0 + z1) / 2
        if axis == "x":
            inward = (0, 1, 0) if c < 5 else (0, -1, 0)
            loc = (mid, c + inward[1] * 0.1, zc)
        else:
            inward = (1, 0, 0) if c < 5 else (-1, 0, 0)
            loc = (c + inward[0] * 0.1, mid, zc)
        light(f"portal{i}", "AREA", loc, inward, 1.0, size=e - s, size_y=z1 - z0, portal=True)

    warm = (1.0, 0.80, 0.60)
    for name, (x, y), energy in [
        ("living", (3.0, 2.5), 40), ("kitchen", (8.0, 2.5), 40),
        ("hall_a", (2.5, 5.75), 30), ("hall_b", (6.45, 5.75), 30), ("hall_c", (9.5, 5.75), 30),
        ("bedroom", (2.6, 8.25), 30), ("bath", (6.5, 8.25), 35), ("office", (10.0, 8.25), 30),
    ]:
        cyl(f"fixture_{name}", x, y, H - 0.03, H, 0.18, M["fixture"])
        light(f"ceil_{name}", "AREA", (x, y, H - 0.04), (0, 0, -1), energy, warm, size=0.34)
    for name, loc, e in [("floorlamp", (5.45, 0.55, 1.6), 20), ("bedlamp0", (0.33, 7.03, 0.97), 8),
                         ("bedlamp1", (0.33, 9.38, 0.97), 8)] + \
                        [(f"pend{i}", (9.9, sy, H - 0.95), 10) for i, sy in enumerate([1.9, 2.5, 3.1])]:
        ld = bpy.data.lights.new(name, "POINT")
        ld.energy = e
        ld.color = warm
        ld.shadow_soft_size = 0.04
        ob = bpy.data.objects.new(name, ld)
        ob.location = loc
        coll.objects.link(ob)

    # ------------------------------------------------------------ render setup
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.008
    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"
    cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    cy.max_bounces = 12
    cy.diffuse_bounces = 6
    cy.glossy_bounces = 6
    cy.transmission_bounces = 12
    cy.transparent_max_bounces = 32
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.blur_glossy = 1.0
    cy.sample_clamp_indirect = 10.0
    scene.view_settings.view_transform = "AgX"
    try:
        scene.view_settings.look = "AgX - Base Contrast"
    except TypeError:
        pass
    scene.view_settings.exposure = 0.35
    scene.render.use_persistent_data = True

    # compositor: subtle bloom around windows/lamps + distance haze through the windows
    vl = scene.view_layers[0]
    vl.use_pass_mist = True
    scene.use_nodes = True
    ct = scene.node_tree
    ct.nodes.clear()
    rl = ct.nodes.new("CompositorNodeRLayers")
    glare = ct.nodes.new("CompositorNodeGlare")
    glare.glare_type = "FOG_GLOW"
    glare.quality = "HIGH"
    glare.threshold = 1.2
    glare.size = 7
    glare.mix = -0.88
    mul = ct.nodes.new("CompositorNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = 0.22
    haze = ct.nodes.new("CompositorNodeMixRGB")
    haze.blend_type = "MIX"
    haze.inputs[2].default_value = (0.78, 0.84, 0.90, 1)
    comp = ct.nodes.new("CompositorNodeComposite")
    ct.links.new(rl.outputs["Image"], haze.inputs[1])
    ct.links.new(rl.outputs["Mist"], mul.inputs[0])
    ct.links.new(mul.outputs[0], haze.inputs["Fac"])
    ct.links.new(haze.outputs["Image"], glare.inputs["Image"])
    ct.links.new(glare.outputs["Image"], comp.inputs["Image"])

    cam_data = bpy.data.cameras.new("pano")
    cam_data.type = "PANO"
    try:
        cam_data.panorama_type = "EQUIRECTANGULAR"
    except AttributeError:
        cam_data.cycles.panorama_type = "EQUIRECTANGULAR"
    cam_data.clip_start = 0.05
    cam_data.clip_end = 1000
    cam = bpy.data.objects.new("pano_cam", cam_data)
    cam.rotation_euler = (math.radians(90), 0, 0)  # image centre = +Y (north)
    coll.objects.link(cam)
    scene.camera = cam
    info = {"sun_E": round(sun_E, 2), "sun_elev_deg": round(math.degrees(elev), 1),
            "hdri_rot_deg": round(math.degrees(rot), 1), "sun_col": [round(c, 3) for c in sun_col],
            "models": {k: [len(v[0])] + [round(x, 3) for x in v[1]] for k, v in model_cache.items()}}
    return scene, cam, info


def enable_gpu(scene):
    import bpy
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            devs = [d for d in prefs.devices if d.type == backend]
            if devs:
                for d in prefs.devices:
                    d.use = d.type == backend
                scene.cycles.device = "GPU"
                return backend, [d.name for d in devs]
        except TypeError:
            continue
    return "CPU", []


@app.function(gpu="L40S", timeout=3600, cpu=8, memory=65536, volumes={ASSETS: assets_vol})
def render_node(name: str, x: float, y: float, width: int, samples: int, save_blend: bool = False):
    import io
    import time

    import bpy
    from PIL import Image

    t0 = time.time()
    manifest = json.loads(pathlib.Path(f"{ASSETS}/manifest.json").read_text())
    scene, cam, info = build_scene(manifest)
    t_build = time.time() - t0
    backend, devs = enable_gpu(scene)
    cam.location = (x, y, EYE)
    scene.render.resolution_x = width
    scene.render.resolution_y = width // 2
    scene.render.resolution_percentage = 100
    scene.cycles.samples = samples
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 92
    scene.render.filepath = f"/tmp/{name}.jpg"
    blend = None
    if save_blend:
        bpy.ops.wm.save_as_mainfile(filepath="/tmp/house.blend")
        blend = pathlib.Path("/tmp/house.blend").read_bytes()
    bpy.ops.render.render(write_still=True)
    img = pathlib.Path(f"/tmp/{name}.jpg").read_bytes()
    small = None
    if width > 4096:
        im = Image.open(io.BytesIO(img))
        im = im.resize((4096, 2048), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90)
        small = buf.getvalue()
    return {"name": name, "jpg": img, "small": small, "blend": blend, "backend": backend,
            "devices": devs, "build_s": round(t_build, 1), "seconds": round(time.time() - t0, 1),
            "info": info}


def yaw_to(ax, ay, bx, by):
    return math.degrees(math.atan2(bx - ax, by - ay))


def tour_json(hi_res=False):
    scenes = {k: {"x": v[0], "y": v[1], "label": v[2], "links": []} for k, v in NODES.items()}
    for a, b, via in LINKS:
        for src, dst in ((a, b), (b, a)):
            sx, sy = NODES[src][:2]
            tx, ty = via if via else NODES[dst][:2]
            if via and abs(tx - sx) < 0.05 and abs(ty - sy) < 0.05:
                tx, ty = NODES[dst][:2]
            dist = math.hypot(tx - sx, ty - sy)
            pitch = -max(14.0, min(40.0, math.degrees(math.atan2(EYE, max(dist, 0.5))) * 0.7))
            scenes[src]["links"].append({"to": dst, "yaw": round(yaw_to(sx, sy, tx, ty), 2),
                                         "pitch": round(pitch, 2)})
    rooms = [
        (0, 0, 6, 5, "Living"), (6, 0, 12, 5, "Kitchen"), (0, 5, 12, 6.5, "Hall"),
        (0, 6.5, 5, 10, "Bedroom"), (5, 6.5, 8, 10, "Bath"), (8, 6.5, 12, 10, "Office"),
    ]
    return {"start": "living", "scenes": scenes, "rooms": rooms, "size": [12, 10], "hires": hi_res}


@app.function(volumes={ASSETS: assets_vol}, timeout=900, cpu=4, memory=16384)
def inspect_models(mids):
    import bpy
    m = json.load(open(f"{ASSETS}/manifest.json"))
    out = {}
    for mid in mids:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        with bpy.data.libraries.load(m["models"][mid], link=False) as (src, dst):
            dst.objects = list(src.objects)
            colls = list(src.collections)
        rows = [(o.name, o.type, o.parent.name if o.parent else None,
                 [round(v, 2) for v in o.matrix_world.translation],
                 [round(v, 2) for v in o.dimensions], o.hide_render, o.instance_type)
                for o in dst.objects if o is not None]
        out[mid] = {"collections": colls, "objects": rows[:30], "n": len(rows)}
    return out


@app.function(volumes={ASSETS: assets_vol}, timeout=900, cpu=8, memory=65536)
def debug_scene():
    import collections as C
    import bpy
    manifest = json.loads(pathlib.Path(f"{ASSETS}/manifest.json").read_text())
    scene, cam, info = build_scene(manifest)
    dg = bpy.context.evaluated_depsgraph_get()
    inside = C.Counter()
    examples = {}
    for inst in dg.object_instances:
        if not inst.is_instance:
            continue
        loc = inst.matrix_world.translation
        if 0.1 < loc.x < 11.9 and 0.1 < loc.y < 9.9 and -0.2 < loc.z < 2.6:
            key = (inst.parent.name if inst.parent else "?", inst.object.name)
            inside[key] += 1
            examples.setdefault(key, [round(loc.x, 2), round(loc.y, 2), round(loc.z, 2)])
    return [(k, v, examples[k]) for k, v in inside.most_common(40)]


@app.local_entrypoint()
def main(test: bool = False, only: str = "", width: int = 0, samples: int = 0, inspect: str = ""):
    if inspect == "scene":
        for row in debug_scene.remote():
            print("IN", row)
        return
    if inspect:
        for k, v in inspect_models.remote(inspect.split(",")).items():
            print("==", k, "n=", v["n"], "colls=", v["collections"])
            for row in v["objects"]:
                print("   ", row)
        return
    print("fetching assets ->", fetch_assets.remote())
    if test:
        names, w, s = ["living", "kitchen"], 1536, 128
    else:
        names, w, s = list(NODES), 8192, 512
    if only:
        names = only.split(",")
    w = width or w
    s = samples or s
    jobs = [(n, NODES[n][0], NODES[n][1], w, s, (not test and i == 0)) for i, n in enumerate(names)]
    panos = OUT / "panos"
    hires = OUT / "panos_8k"
    panos.mkdir(exist_ok=True)
    first = True
    for r in render_node.starmap(jobs):
        if r["small"]:
            hires.mkdir(exist_ok=True)
            (hires / f"{r['name']}.jpg").write_bytes(r["jpg"])
            (panos / f"{r['name']}.jpg").write_bytes(r["small"])
        else:
            (panos / f"{r['name']}.jpg").write_bytes(r["jpg"])
        if r["blend"]:
            (OUT / "house.blend").write_bytes(r["blend"])
        if first:
            print("scene info:", json.dumps(r["info"]))
            first = False
        print(f"{r['name']}: build {r['build_s']}s, total {r['seconds']}s on {r['backend']} {r['devices']} "
              f"({len(r['jpg']) / 1e6:.1f} MB)")
    (OUT / "tour.json").write_text(json.dumps(tour_json(hi_res=(hires.exists() and not test)), indent=2))
    print("wrote", OUT / "tour.json")
