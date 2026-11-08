"""
build -> photoreal walkthrough. Turns a build layout (rooms, doors, windows, open-plan pairs) plus the
furniture the user arranged in the web UI into a Blender scene, and renders Cycles 360° panoramas on
Modal GPUs, one per room. The local bridge (render/bridge.py) calls render_layout_node() for every
viewpoint in parallel and serves the results to the UI.

Scene pipeline adapted from ~/Downloads/house-walkthrough/render_modal.py (Poly Haven CC0 HDRI,
PBR textures and scanned models, cached in the Modal Volume "house-assets").

Deploy once:  modal deploy render/blender_render.py
Smoke test:   modal run render/blender_render.py --payload design-mockups/renders/sample_payload.json
"""
import json
import math
import pathlib

import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libxrender1", "libxxf86vm1", "libxfixes3", "libxi6",
        "libxkbcommon0", "libsm6", "libgl1", "libegl1",
    )
    .pip_install("bpy==4.2.0", "pillow")
)
app = modal.App("build-render", image=image)
assets_vol = modal.Volume.from_name("house-assets", create_if_missing=False)
ASSETS = "/assets"

FT = 0.3048          # build layouts are in feet
EYE = 1.6            # camera height (m)
H = 9 * FT           # wall height (m), matches the web model
SCATTER = {"grass_bermuda_01", "grass_medium_01", "celandine_01", "dandelion_01"}


def build_scene(manifest, payload):
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
                # animated props (tambour doors on path curves etc.): freeze them at rest
                for m in [m for m in o.modifiers if m.type in ("CURVE", "ARMATURE", "HOOK")]:
                    o.modifiers.remove(m)
                o.constraints.clear()
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
    # ------------------------------------------------------------ house from the build layout
    L = payload["layout"]
    FW, FD = L["footprint"]["width_ft"], L["footprint"]["depth_ft"]
    Wm, Dm = FW * FT, FD * FT

    def P(px, py):
        """plan feet (x east, y south) -> Blender metres (x east, y north)."""
        return px * FT, (FD - py) * FT

    rooms = {r["id"]: r for r in L["rooms"]}
    G = 0.5
    k = lambda v: int(round(v / G))
    Hs, Vs = set(), set()
    for r in L["rooms"]:
        x0, x1, y0, y1 = k(r["x"]), k(r["x"] + r["w"]), k(r["y"]), k(r["y"] + r["h"])
        for c in range(x0, x1):
            Hs.add((y0, c)); Hs.add((y1, c))
        for rr in range(y0, y1):
            Vs.add((x0, rr)); Vs.add((x1, rr))
    for a, b in L.get("open", []):
        A, B = rooms.get(a), rooms.get(b)
        if not A or not B:
            continue
        for Pr, Q in ((A, B), (B, A)):
            if abs(Pr["x"] + Pr["w"] - Q["x"]) < 0.01:
                for rr in range(k(max(Pr["y"], Q["y"])), k(min(Pr["y"] + Pr["h"], Q["y"] + Q["h"]))):
                    Vs.discard((k(Q["x"]), rr))
            if abs(Pr["y"] + Pr["h"] - Q["y"]) < 0.01:
                for c in range(k(max(Pr["x"], Q["x"])), k(min(Pr["x"] + Pr["w"], Q["x"] + Q["w"]))):
                    Hs.discard((k(Q["y"]), c))

    def runs(units):
        lines = {}
        for line, pos in units:
            lines.setdefault(line, []).append(pos)
        out = []
        for line, ps in lines.items():
            ps.sort()
            s = p = ps[0]
            for q in ps[1:] + [None]:
                if q is not None and q == p + 1:
                    p = q
                    continue
                out.append((line * G, s * G, (p + 1) * G))
                if q is not None:
                    s = p = q
        return out

    # windows as plan lines
    wins = []
    for w in L["windows"]:
        r = rooms[w["room"]]
        o, wd = w["offset_ft"], w["width_ft"]
        if w["wall"] in ("north", "south"):
            ly = r["y"] if w["wall"] == "north" else r["y"] + r["h"]
            wins.append(("h", ly, r["x"] + o, r["x"] + o + wd, w["room"]))
        else:
            lx = r["x"] if w["wall"] == "west" else r["x"] + r["w"]
            wins.append(("v", lx, r["y"] + o, r["y"] + o + wd, w["room"]))

    def door_kind(d):
        return "front" if "exterior" in d["between"] else "open"

    DOOR_Z = 2.1
    front = None
    for i, (ly, a, b) in enumerate(runs(Hs)):
        ops = []
        for d in L["doors"]:
            if abs(d["y"] - ly) < 0.01 and a - 0.01 <= d["x"] <= b + 0.01:
                kind = door_kind(d)
                s, e = (d["x"] - d["width_ft"] / 2) * FT, (d["x"] + d["width_ft"] / 2) * FT
                ops.append((s, e, 0.0, DOOR_Z, "door" if kind == "front" else "open"))
                if kind == "front":
                    front = ("x", (FD - ly) * FT, s, e)
        for (o, l, s0, s1, _) in wins:
            if o == "h" and abs(l - ly) < 0.01 and a - 0.01 <= s0 and s1 <= b + 0.01:
                ops.append((s0 * FT, s1 * FT, 0.85, 2.15, "window"))
        wall(f"wh{i}", "x", (FD - ly) * FT, a * FT, b * FT, ops)
    for i, (lx, a, b) in enumerate(runs(Vs)):
        ops = []
        for d in L["doors"]:
            if abs(d["x"] - lx) < 0.01 and a - 0.01 <= d["y"] <= b + 0.01:
                kind = door_kind(d)
                s, e = (FD - (d["y"] + d["width_ft"] / 2)) * FT, (FD - (d["y"] - d["width_ft"] / 2)) * FT
                ops.append((s, e, 0.0, DOOR_Z, "door" if kind == "front" else "open"))
                if kind == "front":
                    front = ("y", lx * FT, s, e)
        for (o, l, s0, s1, _) in wins:
            if o == "v" and abs(l - lx) < 0.01 and a - 0.01 <= s0 and s1 <= b + 0.01:
                ops.append(((FD - s1) * FT, (FD - s0) * FT, 0.85, 2.15, "window"))
        wall(f"wv{i}", "y", lx * FT, (FD - b) * FT, (FD - a) * FT, ops)

    # interior door casings
    for i, d in enumerate(L["doors"]):
        if "exterior" in d["between"]:
            continue
        horiz = any(abs(d["y"] - r["y"]) < 0.01 or abs(d["y"] - r["y"] - r["h"]) < 0.01 for r in L["rooms"]) and \
            not any(abs(d["x"] - r["x"]) < 0.01 and r["y"] < d["y"] < r["y"] + r["h"] for r in L["rooms"])
        x, y = P(d["x"], d["y"])
        hw = d["width_ft"] * FT / 2
        for side in (-1, 1):
            off = side * (T / 2 + 0.01)
            if horiz:
                box(f"case{i}{side}l", x - hw - 0.06, y + off - 0.01, 0, x - hw, y + off + 0.01, DOOR_Z + 0.06, M["trim"], 0.003)
                box(f"case{i}{side}r", x + hw, y + off - 0.01, 0, x + hw + 0.06, y + off + 0.01, DOOR_Z + 0.06, M["trim"], 0.003)
                box(f"case{i}{side}t", x - hw - 0.06, y + off - 0.01, DOOR_Z, x + hw + 0.06, y + off + 0.01, DOOR_Z + 0.06, M["trim"], 0.003)
            else:
                box(f"case{i}{side}l", x + off - 0.01, y - hw - 0.06, 0, x + off + 0.01, y - hw, DOOR_Z + 0.06, M["trim"], 0.003)
                box(f"case{i}{side}r", x + off - 0.01, y + hw, 0, x + off + 0.01, y + hw + 0.06, DOOR_Z + 0.06, M["trim"], 0.003)
                box(f"case{i}{side}t", x + off - 0.01, y - hw - 0.06, DOOR_Z, x + off + 0.01, y + hw + 0.06, DOOR_Z + 0.06, M["trim"], 0.003)
    # front door (walnut slab, outer face) + patio path
    if front:
        ax, c, s, e = front
        if ax == "x":
            out = -1 if c < Dm / 2 else 1
            box("front_door", s, c + out * T / 2 - 0.02, 0, e, c + out * T / 2 + 0.03, DOOR_Z, M["walnut"], 0.005)
            cyl("door_knob", e - 0.12, c + out * (T / 2 + 0.06), 1.0, 1.06, 0.03, M["brass"])
            mid = (s + e) / 2
            box("path", mid - 0.7, min(c, c + out * 4.5), -0.1, mid + 0.7, max(c, c + out * 4.5), -0.03, M["patio"], 0.01)
        else:
            out = -1 if c < Wm / 2 else 1
            box("front_door", c + out * T / 2 - 0.02, s, 0, c + out * T / 2 + 0.03, e, DOOR_Z, M["walnut"], 0.005)
            mid = (s + e) / 2
            box("path", min(c, c + out * 4.5), mid - 0.7, -0.1, max(c, c + out * 4.5), mid + 0.7, -0.03, M["patio"], 0.01)

    # floors, ceiling, roof, ground
    for r in L["rooms"]:
        x0, y1 = P(r["x"], r["y"])
        x1, y0 = P(r["x"] + r["w"], r["y"] + r["h"])
        mat = M["tile"] if r["type"] in ("bathroom", "laundry") else M["floor"]
        box(f"floor_{r['id']}", x0, y0, -0.1, x1, y1, 0.0, mat)
    box("ceiling", -0.2, -0.2, H, Wm + 0.2, Dm + 0.2, H + 0.12, M["ceiling"])
    box("roof_slab", -0.6, -0.6, H + 0.12, Wm + 0.6, Dm + 0.6, H + 0.35, principled("fascia", (0.15, 0.15, 0.15), 0.6))
    box("ground", -150, -150, -0.4, 150, 150, -0.1, M["grass"])

    # curtains on living/bedroom/office windows
    for i, (o, l, s0, s1, rid) in enumerate(wins):
        if rooms[rid]["type"] not in ("living", "bedroom", "primary_bedroom", "office", "dining"):
            continue
        r = rooms[rid]
        # panels either side of the window, kept inside this room
        if o == "h":
            c = (FD - l) * FT
            inward = -1 if abs(l - r["y"]) < 0.01 else 1  # wall at the room's north edge -> room lies south (-Y)
            a, b = s0 * FT, s1 * FT
            lo, hi = r["x"] * FT + T / 2 + 0.02, (r["x"] + r["w"]) * FT - T / 2 - 0.02
            curtain(f"cur{i}a", "x", c, max(lo, a - 0.45), a + 0.05, inward)
            curtain(f"cur{i}b", "x", c, b - 0.05, min(hi, b + 0.45), inward)
        else:
            c = l * FT
            inward = 1 if abs(l - r["x"]) < 0.01 else -1
            a, b = (FD - s1) * FT, (FD - s0) * FT
            lo, hi = (FD - r["y"] - r["h"]) * FT + T / 2 + 0.02, (FD - r["y"]) * FT - T / 2 - 0.02
            curtain(f"cur{i}a", "y", c, max(lo, a - 0.45), a + 0.05, inward)
            curtain(f"cur{i}b", "y", c, b - 0.05, min(hi, b + 0.45), inward)

    # landscaping outside the windows (deterministic)
    trees = ["tree_small_02", "island_tree_01", "island_tree_02", "jacaranda_tree"]
    shrubs = ["shrub_02", "shrub_03", "shrub_04"]
    trng = random.Random(int(FW * 10 + FD))
    for i in range(14):
        side = i % 4
        t = trng.uniform(0.05, 0.95)
        dist = trng.uniform(4.5, 11.0)
        if side == 0:
            x, y = t * Wm, Dm + dist
        elif side == 1:
            x, y = t * Wm, -dist
        elif side == 2:
            x, y = -dist, t * Dm
        else:
            x, y = Wm + dist, t * Dm
        if front and front[0] == "x" and abs(x - (front[2] + front[3]) / 2) < 2.5 and side == 1:
            continue
        place(trng.choice(trees), x, y, -0.1, trng.uniform(0, 360), "h", trng.uniform(4.5, 8.0), name=f"tree{i}")
    for i in range(18):
        side = i % 4
        t = trng.uniform(0.05, 0.95)
        dist = trng.uniform(0.9, 2.2)
        x, y = [(t * Wm, Dm + dist), (t * Wm, -dist), (-dist, t * Dm), (Wm + dist, t * Dm)][side]
        if front and front[0] == "x" and abs(x - (front[2] + front[3]) / 2) < 1.6 and side == 1:
            continue
        place(trng.choice(shrubs), x, y, -0.1, trng.uniform(0, 360), "h", trng.uniform(0.6, 1.2), name=f"shrub{i}")

    # ------------------------------------------------------------ furniture from the build scene (v2: detailed)
    fab_cache = {}

    def hex2rgb(h):
        h = h.lstrip("#")
        return tuple((int(h[i:i + 2], 16) / 255.0) ** 2.2 for i in (0, 2, 4))

    def fabric(col, rough_add=0.55):
        key = f"f{col}"
        if key not in fab_cache:
            fab_cache[key] = pbr(f"fab_{col}", "linen", tint=hex2rgb(col), tint_amt=0.82, scale_mul=0.6, normal_strength=0.8)
        return fab_cache[key]

    def rugmat(col):
        key = "rug" + col
        if key not in fab_cache:
            fab_cache[key] = pbr(f"rug_{col}", "rugfab", tint=hex2rgb(col), tint_amt=-0.85, scale_mul=0.35, normal_strength=1.2)
        return fab_cache[key]

    def paint(col, rough=0.45):
        key = f"p{col}{rough}"
        if key not in fab_cache:
            fab_cache[key] = principled(f"paint_{col}_{rough}", hex2rgb(col) if isinstance(col, str) else col, rough)
        return fab_cache[key]

    M["chrome"] = principled("chrome", (0.9, 0.9, 0.9), 0.06, 1.0)
    M["glassblack"] = principled("glass_black", (0.01, 0.01, 0.012), 0.03)
    M["gap"] = principled("gap", (0.02, 0.02, 0.02), 0.9)

    def mat_for(part):
        ck, col = part["colorKey"], part["color"]
        lum = sum(hex2rgb(col)) / 3
        if ck == "wood":
            return M["walnut"] if lum < 0.2 else M["oak"]
        if ck == "stone":
            return M["marble"]
        if ck == "metal":
            return M["steel"]
        if ck == "white":
            return paint(col, 0.3) if lum < 0.75 else M["cabinet"]
        if ck == "rug":
            return rugmat(col)
        if ck == "glow":
            return M["shade"]
        if ck in ("leaf", "pot", "dark"):
            return paint(col, 0.55)
        return fabric(col)

    def bounds(part):
        (x0, y0, z0), (x1, y1, z1) = part["min"], part["max"]
        bx0, by1 = P(x0, y0)
        bx1, by0 = P(x1, y1)
        return bx0, by0, z0 * FT, bx1, by1, z1 * FT

    def pbox(part, mat=None, bevel=None, name=None):
        x0, y0, z0, x1, y1, z1 = bounds(part)
        bv = (part.get("round") or 0) * FT if bevel is None else bevel
        return box(name or f"f_{part['item']}_{part['name']}_{x0:.2f}", x0, y0, z0, x1, y1, z1, mat or mat_for(part), bv)

    def centre(part):
        x0, y0, z0, x1, y1, z1 = bounds(part)
        return (x0 + x1) / 2, (y0 + y1) / 2, z0, z1, x1 - x0, y1 - y0

    def soft(ob, levels=2):
        md = ob.modifiers.new("soft", "SUBSURF")
        md.levels = 1
        md.render_levels = levels
        for p in ob.data.polygons:
            p.use_smooth = True
        return ob

    def facing_rot(fx, fy):
        """plan-space front vector -> place() rotation (0 = faces -Y)."""
        return math.degrees(math.atan2(fx, fy))

    class Frame:
        """Item-local box builder: u across the item, v from its back (0) to its front (D), z up (metres)."""
        def __init__(self, x0, y0, x1, y1, front_plan):
            fx, fy = front_plan
            self.bx, self.by = fx, -fy               # Blender front direction
            self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1
            if abs(self.by) > 0.5:
                self.W, self.D = x1 - x0, y1 - y0
            else:
                self.W, self.D = y1 - y0, x1 - x0

        def pt(self, u, v):
            if self.by < -0.5:   # faces -Y: back edge at y1
                return self.x0 + u, self.y1 - v
            if self.by > 0.5:    # faces +Y: back at y0
                return self.x1 - u, self.y0 + v
            if self.bx > 0.5:    # faces +X: back at x0
                return self.x0 + v, self.y0 + u
            return self.x1 - v, self.y1 - u   # faces -X

        def box(self, name, u0, u1, v0, v1, z0, z1, mat, bevel=0.0):
            ax, ay = self.pt(u0, v0)
            bx_, by_ = self.pt(u1, v1)
            return box(name, min(ax, bx_), min(ay, by_), z0, max(ax, bx_), max(ay, by_), z1, mat, bevel)

        def world(self, u, v):
            return self.pt(u, v)

    def rcyl(name, loc, r, depth, mat, axis="Z", segs=48):
        """Cylinder centred on loc, axis X/Y/Z (for washer doors, knobs, burners)."""
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r, depth=depth)
        ob = _obj(name, bm, mat, smooth=False)
        ob.location = loc
        if axis == "X":
            ob.rotation_euler = (0, math.radians(90), 0)
        elif axis == "Y":
            ob.rotation_euler = (math.radians(90), 0, 0)
        return ob

    lamps = []
    warm = (1.0, 0.82, 0.64)

    def lamp_at(x, y, z, e=12):
        lamps.append((x, y, z, e))

    # window spans per room (Blender XY rectangles) so wall cabinets and art avoid them
    win_rects = {}
    for (o, l, s0, s1, rid) in wins:
        if o == "h":
            yy = (FD - l) * FT
            win_rects.setdefault(rid, []).append((s0 * FT, yy - 0.3, s1 * FT, yy + 0.3))
        else:
            xx = l * FT
            win_rects.setdefault(rid, []).append((xx - 0.3, (FD - s1) * FT, xx + 0.3, (FD - s0) * FT))

    def hits_window(rid, x0, y0, x1, y1):
        return any(x0 < b[2] and x1 > b[0] and y0 < b[3] and y1 > b[1] for b in win_rects.get(rid, []))

    # ---------------- builders ----------------
    def build_sofa(key, it, parts):
        base = next(p for p in parts if p["name"] == "sofa")
        allx = [bounds(p) for p in parts if p["name"] in ("sofa", "sofa back", "arm")]
        x0, y0 = min(b[0] for b in allx), min(b[1] for b in allx)
        x1, y1 = max(b[3] for b in allx), max(b[4] for b in allx)
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        mat = fabric(base["color"])
        arm = 0.17
        for i, u in enumerate((0.06, W - 0.06)):
            for v in (0.08, D - 0.08):
                F.box(f"sofa_leg{key[0]}{i}{v:.1f}", u - 0.025, u + 0.025, v - 0.025, v + 0.025, 0, 0.1, M["walnut"], 0.005)
        F.box(f"sofa_base{key[0]}", 0, W, 0, D, 0.1, 0.36, mat, 0.03)
        soft(F.box(f"sofa_armL{key[0]}", 0, arm, 0, D, 0.1, 0.62, mat, 0.06), 1)
        soft(F.box(f"sofa_armR{key[0]}", W - arm, W, 0, D, 0.1, 0.62, mat, 0.06), 1)
        F.box(f"sofa_back{key[0]}", arm, W - arm, 0, 0.2, 0.36, 0.8, mat, 0.05)
        n = 3 if W > 1.9 else 2
        cw = (W - 2 * arm) / n
        for i in range(n):
            u0 = arm + i * cw
            soft(F.box(f"sofa_seat{key[0]}{i}", u0 + 0.01, u0 + cw - 0.01, 0.2, D - 0.02, 0.36, 0.52, mat, 0.06))
            soft(F.box(f"sofa_bcush{key[0]}{i}", u0 + 0.015, u0 + cw - 0.015, 0.16, 0.36, 0.5, 0.86, mat, 0.08))
        for j, p in enumerate([p for p in parts if p["name"] == "cushion"]):
            u = arm + 0.12 if j % 2 == 0 else W - arm - 0.12
            soft(F.box(f"sofa_pil{key[0]}{j}", u - 0.2 if j % 2 else u - 0.02, u + 0.02 if j % 2 else u + 0.2, 0.28, 0.42, 0.5, 0.92, fabric(p["color"]), 0.08))

    def build_bed(key, it, parts):
        frame_p = next(p for p in parts if p["name"] == "bed")
        x0, y0, _, x1, y1, _ = bounds(frame_p)
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        col = {p["name"]: p["color"] for p in parts}
        F.box(f"bed_frame{key[0]}", 0, W, 0.02, D, 0.12, 0.32, M["walnut"], 0.01)
        for u in (0.05, W - 0.05):
            for v in (0.1, D - 0.05):
                F.box(f"bed_leg{key[0]}{u:.1f}{v:.1f}", u - 0.03, u + 0.03, v - 0.03, v + 0.03, 0, 0.12, M["walnut"], 0.004)
        soft(F.box(f"bed_mattress{key[0]}", 0.04, W - 0.04, 0.06, D - 0.04, 0.32, 0.56, M["linen"], 0.05), 1)
        duv = fabric(col.get("duvet", "#2e4a7a"))
        soft(F.box(f"bed_duvet{key[0]}", -0.02, W + 0.02, 0.62, D + 0.03, 0.3, 0.6, duv, 0.05), 1)
        soft(F.box(f"bed_fold{key[0]}", -0.02, W + 0.02, 0.55, 0.78, 0.5, 0.64, M["linen"], 0.05), 1)
        if "throw" in col:
            soft(F.box(f"bed_throw{key[0]}", -0.05, W + 0.05, D - 0.5, D - 0.12, 0.34, 0.615, fabric(col["throw"]), 0.03), 1)
        pw = min(0.7, (W - 0.2) / 2)
        for i, u in enumerate((W / 2 - pw - 0.02, W / 2 + 0.02)):
            soft(F.box(f"bed_pillow{key[0]}{i}", u, u + pw, 0.08, 0.5, 0.56, 0.74, M["linen"], 0.07))
        if "cushion" in col:
            soft(F.box(f"bed_cush{key[0]}", W / 2 - 0.25, W / 2 + 0.25, 0.42, 0.56, 0.58, 0.86, fabric(col["cushion"]), 0.07))
        hb = fabric(col.get("headboard", "#3a3d45"))
        F.box(f"bed_head{key[0]}", -0.06, W + 0.06, -0.09, 0.03, 0.0, 1.2, hb, 0.03)
        nch = max(4, int(W / 0.22))
        for i in range(nch):
            u0 = -0.06 + (W + 0.12) * i / nch
            soft(F.box(f"bed_chan{key[0]}{i}", u0 + 0.008, u0 + (W + 0.12) / nch - 0.008, 0.02, 0.07, 0.38, 1.16, hb, 0.025), 1)

    def build_nightstand(key, it, parts):
        body = next(p for p in parts if p["name"] == "nightstand")
        x0, y0, _, x1, y1, _ = bounds(body)
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        for u in (0.04, W - 0.04):
            for v in (0.04, D - 0.04):
                F.box(f"ns_leg{key}{u:.2f}{v:.2f}", u - 0.018, u + 0.018, v - 0.018, v + 0.018, 0, 0.16, M["walnut"], 0.003)
        F.box(f"ns_body{key}", 0, W, 0, D, 0.16, 0.58, M["walnut"], 0.008)
        F.box(f"ns_gap{key}", 0.03, W - 0.03, D - 0.002, D + 0.002, 0.4, 0.405, M["gap"])
        ux, uy = F.world(W / 2, D + 0.012)
        rcyl(f"ns_knob{key}", (ux, uy, 0.49), 0.014, 0.025, M["brass"], "X" if abs(F.bx) > 0.5 else "Y", 16)
        lp = next((p for p in parts if p["name"] == "lamp"), None)
        if lp:
            cx, cy = F.world(W / 2, D / 2)
            cyl(f"ns_lbase{key}", cx, cy, 0.58, 0.8, 0.07, paint((0.85, 0.8, 0.72), 0.3), 32)
            cone(f"ns_lshade{key}", cx, cy, 0.78, 0.98, 0.15, 0.11, M["shade"])
            lamp_at(cx, cy, 0.88, 7)

    def build_dresser(key, it, parts):
        x0, y0, _, x1, y1, _ = bounds(parts[0])
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        top = max(0.75, bounds(parts[0])[5])
        F.box(f"dr_body{key}", 0, W, 0, D, 0.12, top, M["walnut"], 0.008)
        for u in (0.05, W - 0.05):
            for v in (0.05, D - 0.05):
                F.box(f"dr_leg{key}{u:.2f}{v:.2f}", u - 0.02, u + 0.02, v - 0.02, v + 0.02, 0, 0.12, M["walnut"], 0.003)
        rows, cols = 3, 2 if W > 0.8 else 1
        for r_ in range(rows):
            z = 0.12 + (top - 0.12) * (r_ + 1) / rows
            if r_ < rows - 1:
                F.box(f"dr_hgap{key}{r_}", 0.02, W - 0.02, D - 0.002, D + 0.002, z - 0.003, z + 0.003, M["gap"])
            for c_ in range(cols):
                u = W * (c_ + 0.5) / cols
                zc = 0.12 + (top - 0.12) * (r_ + 0.5) / rows
                F.box(f"dr_pull{key}{r_}{c_}", u - 0.07, u + 0.07, D, D + 0.02, zc - 0.008, zc + 0.008, M["brass"], 0.003)
        if cols == 2:
            F.box(f"dr_vgap{key}", W / 2 - 0.003, W / 2 + 0.003, D - 0.002, D + 0.002, 0.12, top, M["gap"])
        cx, cy = F.world(W * 0.7, D / 2)
        try:
            place("ceramic_vase_02", cx, cy, top, 0, "h", 0.28, name=f"dr_vase{key}")
        except Exception:
            pass

    def build_cabinets(key, it, parts, rid, uppers=True, sink=True):
        body = next(p for p in parts if p["name"] in ("counters", "side counter", "island", "vanity"))
        x0, y0, _, x1, y1, _ = bounds(body)
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        island = body["name"] == "island"
        vanity = body["name"] == "vanity"
        top_z = 0.82 if vanity else 0.86
        cab = M["walnut"] if island or vanity else mat_for(body)
        F.box(f"cab_body{key}", 0, W, 0, D - 0.06 if not island else D, 0.1, top_z, cab, 0.004)
        F.box(f"cab_kick{key}", 0.02, W - 0.02, 0.0, D - 0.12, 0, 0.1, M["gap"])
        mods = max(1, round(W / 0.6))
        mw = W / mods
        for i in range(mods):
            u = i * mw
            F.box(f"cab_door{key}{i}", u + 0.004, u + mw - 0.004, D - 0.07, D - 0.05 if not island else D + 0.015, 0.12, top_z - 0.02, cab, 0.004)
            hu = u + (mw - 0.06 if i % 2 == 0 else 0.06)
            F.box(f"cab_pull{key}{i}", hu - 0.008, hu + 0.008, D - 0.05, D - 0.025, top_z - 0.25, top_z - 0.08, M["steel"], 0.003)
        top_mat = M["marble"]
        over = 0.25 if island else 0.03
        F.box(f"cab_top{key}", -0.01, W + 0.01, -0.01 if not island else -over, D + over, top_z, top_z + 0.04, top_mat, 0.004)
        if vanity:
            cx, cy = F.world(W / 2, D * 0.55)
            box(f"van_basin{key}", cx - 0.2, cy - 0.15, top_z + 0.0, cx + 0.2, cy + 0.15, top_z + 0.045, M["porcelain"], 0.03)
            box(f"van_bowl{key}", cx - 0.16, cy - 0.11, top_z + 0.02, cx + 0.16, cy + 0.11, top_z + 0.047, paint((0.75, 0.76, 0.77), 0.15), 0.02)
            fx, fy = F.world(W / 2, 0.06)
            cyl(f"van_tap{key}", fx, fy, top_z + 0.04, top_z + 0.28, 0.014, M["chrome"], 16)
            mx0, my0 = F.world(max(0.0, W / 2 - 0.4), -0.005)
            mx1, my1 = F.world(min(W, W / 2 + 0.4), 0.012)
            box(f"van_mirror{key}", min(mx0, mx1), min(my0, my1), 1.05, max(mx0, mx1), max(my0, my1), 1.85, M["mirror"], 0.004)
            sx, sy = F.world(W / 2, 0.06)
            box(f"van_sconce{key}", sx - 0.25, sy - 0.03, 1.92, sx + 0.25, sy + 0.03, 1.97, M["fixture"], 0.01)
            lamp_at(sx, sy + 0.0, 1.9, 6)
            return
        if body["name"] == "counters" and sink:
            cx, cy = F.world(W * 0.5, D * 0.45)
            box(f"sink{key}", cx - 0.38, cy - 0.22, top_z - 0.1, cx + 0.38, cy + 0.22, top_z + 0.042, M["steel"], 0.01)
            box(f"sinkin{key}", cx - 0.34, cy - 0.18, top_z - 0.08, cx + 0.34, cy + 0.18, top_z + 0.043, paint((0.35, 0.36, 0.37), 0.25), 0.01)
            fx, fy = F.world(W * 0.5, 0.06)
            cyl(f"tap{key}", fx, fy, top_z + 0.04, top_z + 0.38, 0.014, M["chrome"], 16)
            sx, sy = F.world(W * 0.5, 0.2)
            box(f"spout{key}", min(fx, sx) - 0.012, min(fy, sy) - 0.012, top_z + 0.35, max(fx, sx) + 0.012, max(fy, sy) + 0.012, top_z + 0.38, M["chrome"], 0.004)
            kx, ky = F.world(W * 0.2, D * 0.45)
            box(f"cooktop{key}", kx - 0.3, ky - 0.25, top_z + 0.04, kx + 0.3, ky + 0.25, top_z + 0.05, M["glassblack"], 0.005)
            for i, (du, dv) in enumerate([(-0.14, -0.11), (0.14, -0.11), (-0.14, 0.11), (0.14, 0.11)]):
                rcyl(f"burner{key}{i}", (kx + du, ky + dv, top_z + 0.051), 0.08, 0.002, paint((0.12, 0.12, 0.13), 0.3), "Z", 32)
            # backsplash + wall cabinets (skipping windows) + hood
            F.box(f"splash{key}", 0, W, -0.012, 0.0, top_z + 0.04, 1.42, M["tile"])
            if uppers:
                for i in range(mods):
                    u = i * mw
                    a = F.world(u, -0.01)
                    b = F.world(u + mw, 0.36)
                    if hits_window(rid, min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])):
                        continue
                    if abs((u + mw / 2) - W * 0.2) < mw * 0.6:
                        F.box(f"hood{key}", u + 0.05, u + mw - 0.05, 0, 0.45, 1.75, 1.95, M["steel"], 0.006)
                        F.box(f"hoodch{key}", u + mw / 2 - 0.13, u + mw / 2 + 0.13, 0, 0.26, 1.95, H, M["steel"], 0.004)
                        continue
                    F.box(f"upper{key}{i}", u + 0.004, u + mw - 0.004, 0, 0.34, 1.48, 2.24, cab, 0.004)
                    F.box(f"upull{key}{i}", u + mw / 2 - 0.008, u + mw / 2 + 0.008, 0.34, 0.36, 1.52, 1.66, M["steel"], 0.003)

    def build_fridge(key, it, parts):
        x0, y0, _, x1, y1, _ = bounds(parts[0])
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        F.box(f"fr_body{key}", 0, W, 0, D, 0, 1.95, M["steel"], 0.01)
        F.box(f"fr_gap{key}", 0.01, W - 0.01, D - 0.002, D + 0.002, 1.25, 1.256, M["gap"])
        F.box(f"fr_vgap{key}", W / 2 - 0.003, W / 2 + 0.003, D - 0.002, D + 0.002, 1.256, 1.95, M["gap"])
        for u in (W / 2 - 0.05, W / 2 + 0.05):
            F.box(f"fr_h{key}{u:.2f}", u - 0.01, u + 0.01, D, D + 0.04, 1.35, 1.75, M["chrome"], 0.004)
        F.box(f"fr_hl{key}", W - 0.08, W - 0.06, D, D + 0.04, 0.5, 1.1, M["chrome"], 0.004)

    def build_tub(key, it, parts):
        x0, y0, _, x1, y1, _ = bounds(parts[0])
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        t = 0.07
        F.box(f"tub_floor{key}", 0, W, 0, D, 0, 0.12, M["porcelain"], 0.02)
        for nm, (u0, u1, v0, v1) in {"b": (0, W, 0, t), "f": (0, W, D - t, D), "l": (0, t, 0, D), "r": (W - t, W, 0, D)}.items():
            F.box(f"tub_{nm}{key}", u0, u1, v0, v1, 0, 0.56, M["porcelain"], 0.025)
        F.box(f"tub_in{key}", t, W - t, t, D - t, 0.12, 0.125, paint((0.86, 0.87, 0.87), 0.12))
        fx, fy = F.world(W * 0.85, 0.02)
        cyl(f"tub_tap{key}", fx, fy, 0.56, 0.64, 0.02, M["chrome"], 16)

    def build_toilet(key, it, parts):
        bb = [bounds(p) for p in parts]
        x0, y0 = min(b[0] for b in bb), min(b[1] for b in bb)
        x1, y1 = max(b[3] for b in bb), max(b[4] for b in bb)
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        F.box(f"wc_tank{key}", W / 2 - 0.2, W / 2 + 0.2, 0.0, 0.18, 0.4, 0.8, M["porcelain"], 0.03)
        soft(F.box(f"wc_base{key}", W / 2 - 0.13, W / 2 + 0.13, 0.12, D - 0.12, 0, 0.36, M["porcelain"], 0.06), 1)
        soft(F.box(f"wc_bowl{key}", W / 2 - 0.19, W / 2 + 0.19, 0.12, D, 0.3, 0.42, M["porcelain"], 0.08), 2)
        F.box(f"wc_seat{key}", W / 2 - 0.19, W / 2 + 0.19, 0.16, D, 0.42, 0.44, M["porcelain"], 0.02)

    def build_laundry(key, it, parts, name):
        x0, y0, _, x1, y1, _ = bounds(parts[0])
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        F.box(f"wm_body{key}", 0, W, 0, D, 0, 0.88, M["porcelain"], 0.02)
        F.box(f"wm_panel{key}", 0.02, W - 0.02, D, D + 0.005, 0.76, 0.85, paint((0.75, 0.76, 0.78), 0.3))
        cx, cy = F.world(W / 2, D + 0.012)
        ax = "X" if abs(F.bx) > 0.5 else "Y"
        rcyl(f"wm_ring{key}", (cx, cy, 0.42), 0.21, 0.03, M["chrome"], ax)
        rcyl(f"wm_glass{key}", (cx, cy, 0.42), 0.17, 0.035, M["glassblack"], ax)

    def build_desk(key, it, parts):
        desk = next(p for p in parts if p["name"] == "desk")
        x0, y0, _, x1, y1, _ = bounds(desk)
        F = Frame(x0, y0, x1, y1, it["front"])
        W, D = F.W, F.D
        F.box(f"desk_top{key}", 0, W, 0, D, 0.72, 0.75, M["oak"], 0.004)
        for u in (0.04, W - 0.04):
            F.box(f"desk_leg{key}{u:.2f}", u - 0.02, u + 0.02, 0.06, D - 0.06, 0, 0.72, M["black"], 0.004)
        F.box(f"mon{key}", W * 0.25, W * 0.75, 0.12, 0.15, 0.95, 1.28, M["black"], 0.006)
        F.box(f"monscr{key}", W * 0.26, W * 0.74, 0.15, 0.152, 0.965, 1.265, M["screen"])
        F.box(f"monst{key}", W / 2 - 0.02, W / 2 + 0.02, 0.1, 0.13, 0.75, 0.97, M["black"])
        F.box(f"kb{key}", W / 2 - 0.22, W / 2 + 0.22, 0.32, 0.46, 0.75, 0.765, paint((0.2, 0.2, 0.21), 0.5), 0.004)
        cx, cy = F.world(W * 0.85, 0.2)
        cyl(f"dl_base{key}", cx, cy, 0.75, 0.77, 0.07, M["black"])
        cyl(f"dl_pole{key}", cx, cy, 0.77, 1.15, 0.008, M["black"], 12)
        cone(f"dl_shade{key}", cx, cy, 1.08, 1.2, 0.09, 0.05, M["shade"])
        lamp_at(cx, cy, 1.1, 5)

    def build_tv(key, part):
        x0, y0, z0, x1, y1, z1 = bounds(part)
        box(f"tv{key}", x0, y0, 1.0, x1, y1, 1.75, M["black"], 0.006)
        horiz = (x1 - x0) > (y1 - y0)
        if horiz:
            box(f"tvs{key}", x0 + 0.02, y0 - 0.002, 1.02, x1 - 0.02, y1 + 0.002, 1.73, M["screen"])
        else:
            box(f"tvs{key}", x0 - 0.002, y0 + 0.02, 1.02, x1 + 0.002, y1 - 0.02, 1.73, M["screen"])

    def build_art(key, part, rid):
        x0, y0, z0, x1, y1, z1 = bounds(part)
        if hits_window(rid, x0, y0, x1, y1):
            return
        thin_x = (x1 - x0) < (y1 - y0)
        box(f"artf{key}{x0:.2f}", x0, y0, z0, x1, y1, z1, M["black"], 0.003)
        base = hex2rgb(part["color"])
        alt = tuple(min(1.0, c * 0.35 + 0.55) for c in base)
        e = 0.004
        if thin_x:
            box(f"artc{key}{x0:.2f}", x0 - e, y0 + 0.035, z0 + 0.035, x1 + e, y1 - 0.035, z1 - 0.035, paint(alt, 0.85))
            mid = (y0 + y1) / 2
            box(f"arts{key}{x0:.2f}", x0 - 2 * e, mid - (y1 - y0) * 0.22, z0 + 0.08, x1 + 2 * e, mid + (y1 - y0) * 0.12, z1 - 0.12, paint(base, 0.8))
        else:
            box(f"artc{key}{x0:.2f}", x0 + 0.035, y0 - e, z0 + 0.035, x1 - 0.035, y1 + e, z1 - 0.035, paint(alt, 0.85))
            mid = (x0 + x1) / 2
            box(f"arts{key}{x0:.2f}", mid - (x1 - x0) * 0.22, y0 - 2 * e, z0 + 0.08, mid + (x1 - x0) * 0.12, y1 + 2 * e, z1 - 0.12, paint(base, 0.8))

    # ---------------- place every item ----------------
    items = {}
    for part in payload["parts"]:
        items.setdefault((part["room"], part["item"]), []).append(part)
    meta = {(it["room"], it["item"]): it for it in payload["items"]}
    placed_tv = set()
    for key, parts in items.items():
        it = meta.get(key, {"front": [0, 1], "name": parts[0]["name"]})
        name = it.get("name", parts[0]["name"])
        rid = key[0]
        k = f"{key[0]}_{key[1]}".replace(" ", "")
        rot = facing_rot(*it.get("front", [0, 1]))
        cx, cy = P(*it["center"]) if it.get("center") else centre(parts[0])[:2]
        w_ft, d_ft = it.get("size", [3, 3])
        long_m = max(w_ft, d_ft) * FT
        try:
            if name == "sofa":
                build_sofa(key, it, parts); continue
            if name == "bed":
                build_bed(key, it, parts); continue
            if name == "nightstand":
                build_nightstand(k, it, parts); continue
            if name == "dresser":
                build_dresser(k, it, parts); continue
            if name in ("counters", "side counter", "island", "vanity"):
                build_cabinets(k, it, parts, rid)
                for p in parts:
                    if p["name"] == "fruit bowl":
                        x, y, z0, _, _, _ = centre(p)
                        place("wooden_bowl_01", x, y, 0.9, 0, "len", 0.34, name=f"bowl_{k}")
                        for i, (dx, dy) in enumerate([(-0.05, 0.0), (0.05, 0.03), (0.0, -0.06)]):
                            place("food_apple_01", x + dx, y + dy, 0.92, trng.uniform(0, 360), "len", 0.08, name=f"apple_{k}{i}")
                    if p["name"] == "pendant":
                        x, y = centre(p)[:2]
                        for i, off in enumerate((-0.6, 0.6)):
                            ax = (x + off, y) if (bounds(parts[0])[3] - bounds(parts[0])[0]) > (bounds(parts[0])[4] - bounds(parts[0])[1]) else (x, y + off)
                            place("modern_ceiling_lamp_01", ax[0], ax[1], H, 0, "h", 0.9, name=f"pend_{k}{i}", hang=True)
                            lamp_at(ax[0], ax[1], H - 0.95, 9)
                continue
            if name == "fridge":
                build_fridge(k, it, parts); continue
            if name == "tub":
                build_tub(k, it, parts); continue
            if name in ("toilet", "toilet tank"):
                build_toilet(k, it, parts); continue
            if name in ("washer", "dryer"):
                build_laundry(k, it, parts, name); continue
            if name == "desk":
                build_desk(k, it, parts); continue
            if name == "armchair":
                place("mid_century_lounge_chair", cx, cy, 0, rot, "h", 0.95, name=f"arm_{k}"); continue
            if name == "chair" and rid not in ("dining", "kitchen"):
                place("modern_arm_chair_01", cx, cy, 0, rot, "h", 0.85, name=f"chair_{k}"); continue
            if name == "coffee table":
                _, top = place("coffee_table_round_01", cx, cy, 0.012, 0, "len", min(w_ft, d_ft) * FT * 1.15, name=f"coffee_{k}")
                for bi, (bh, bc) in enumerate([(0.035, 1), (0.03, 2), (0.04, 0)]):
                    z0b = top + sum(h for h, _ in [(0.035, 1), (0.03, 2), (0.04, 0)][:bi])
                    box(f"cbook_{k}{bi}", cx - 0.12 + bi * 0.01, cy - 0.09, z0b, cx + 0.12 - bi * 0.01, cy + 0.09, z0b + bh, M["books"][bc], 0.003)
                continue
            if name == "side table":
                _, top = place("side_table_01", cx, cy, 0, 0, "len", long_m, name=f"side_{k}")
                place("ceramic_vase_03", cx, cy, top, 0, "h", 0.22, name=f"sidevase_{k}")
                continue
            if name == "planter":
                place(trng.choice(["potted_plant_01", "potted_plant_02"]), cx, cy, 0, trng.uniform(0, 360), "h", 1.15, name=f"plant_{k}"); continue
            if name == "media console":
                # mid-century walnut console with a slatted front (the scanned cabinet's tambour doors
                # are flexible strips that only work on their animation curves)
                body = next(p for p in parts if p["name"] == "media console")
                x0, y0, _, x1, y1, _ = bounds(body)
                Fm = Frame(x0, y0, x1, y1, it["front"])
                Wm_, Dm_ = Fm.W, Fm.D
                Fm.box(f"mc_body{k}", 0, Wm_, 0, Dm_ - 0.02, 0.16, 0.58, M["walnut"], 0.01)
                Fm.box(f"mc_top{k}", -0.01, Wm_ + 0.01, -0.01, Dm_ + 0.005, 0.58, 0.61, M["walnut"], 0.006)
                for u in (0.08, Wm_ - 0.08):
                    for v in (0.06, Dm_ - 0.08):
                        Fm.box(f"mc_leg{k}{u:.2f}{v:.2f}", u - 0.018, u + 0.018, v - 0.018, v + 0.018, 0, 0.16, M["black"], 0.004)
                n_sl = int((Wm_ - 0.06) / 0.035)
                for i in range(n_sl):
                    u = 0.03 + i * (Wm_ - 0.06) / n_sl
                    Fm.box(f"mc_slat{k}{i}", u + 0.004, u + (Wm_ - 0.06) / n_sl - 0.004, Dm_ - 0.03, Dm_, 0.19, 0.55, M["oak"], 0.003)
                cx2, cy2 = Fm.world(Wm_ * 0.78, Dm_ / 2)
                place("ceramic_vase_02", cx2, cy2, 0.61, 0, "h", 0.3, name=f"mc_vase{k}")
                for p in parts:
                    if p["name"] == "tv":
                        build_tv(k, p)
                continue
            if name == "shelving" and rid == "laundry" or name == "basket":
                pass
        except Exception as ex:  # missing model -> fall back to boxes
            print("fallback", name, ex)
        table_c = next((centre(p)[:2] for p in parts if p["name"] in ("table", "island")), None)
        for p in parts:
            n = p["name"]
            x, y, z0, z1, sx, sy = centre(p)
            try:
                if n in ("chair back",) or (n in ("plant", "shade") and name in ("planter", "floor lamp")):
                    continue
                if name == "table" and n == "chair":
                    tx, ty = table_c or (x, y)
                    place("dining_chair_02", x, y, 0, math.degrees(math.atan2(tx - x, -(ty - y))), "h", 0.95, name=f"dchair_{k}_{x:.2f}_{y:.2f}")
                    continue
                if n == "table":
                    x0, y0, _, x1, y1, _ = bounds(p)
                    box(f"dtop_{k}", x0, y0, 0.72, x1, y1, 0.76, M["oak"], 0.01)
                    for i, (lx, ly) in enumerate([(x0 + 0.1, y0 + 0.1), (x1 - 0.1, y0 + 0.1), (x0 + 0.1, y1 - 0.1), (x1 - 0.1, y1 - 0.1)]):
                        box(f"dleg_{k}{i}", lx - 0.03, ly - 0.03, 0, lx + 0.03, ly + 0.03, 0.72, M["oak"], 0.004)
                    continue
                if n == "stool":
                    place("bar_chair_round_01", x, y, 0, 0, "h", 0.72, name=f"stool_{k}_{x:.2f}"); continue
                if n == "pendant":
                    place("modern_ceiling_lamp_01", x, y, H, 0, "h", 0.9, name=f"pend_{k}_{x:.2f}", hang=True)
                    lamp_at(x, y, H - 0.95, 10); continue
                if n == "vase":
                    place("ceramic_vase_01", x, y, 0.76, 0, "h", 0.3, name=f"vase_{k}"); continue
                if n == "floor lamp":
                    cyl(f"flbase_{k}", x, y, 0, 0.03, 0.15, M["black"])
                    cyl(f"flpole_{k}", x, y, 0.03, 1.5, 0.012, M["black"], 12)
                    cone(f"flshade_{k}", x, y, 1.45, 1.75, 0.22, 0.16, M["shade"])
                    lamp_at(x, y, 1.6, 18); continue
                if n == "tv":
                    build_tv(k, p); continue
                if n == "art":
                    build_art(k, p, rid); continue
                if n == "basket":
                    place("wicker_basket_01", x, y, z0, 0, "len", max(sx, sy), name=f"basket_{k}"); continue
                if n == "bookshelf":
                    x0, y0, z0_, x1, y1, z1_ = bounds(p)
                    pbox(p, M["oak"], 0.004)
                    horiz = (x1 - x0) > (y1 - y0)
                    for lvl in range(4):
                        zz = 0.1 + lvl * 0.48
                        span = (x1 - x0) if horiz else (y1 - y0)
                        t = 0.0
                        while t < span - 0.12:
                            bw, bh = trng.uniform(0.025, 0.06), trng.uniform(0.2, 0.31)
                            if trng.random() < 0.8:
                                if horiz:
                                    box(f"bk{k}{lvl}_{t:.2f}", x0 + 0.04 + t, y0 - 0.02, zz, x0 + 0.04 + t + bw, y0 + 0.12, zz + bh, trng.choice(M["books"]), 0.003)
                                else:
                                    box(f"bk{k}{lvl}_{t:.2f}", x0 - 0.02, y0 + 0.04 + t, zz, x0 + 0.12, y0 + 0.04 + t + bw, zz + bh, trng.choice(M["books"]), 0.003)
                            t += bw + 0.004
                    continue
                if n == "books" and name == "shelf":
                    continue
                if n == "hanging clothes":
                    x0, y0, z0_, x1, y1, z1_ = bounds(p)
                    horiz = (x1 - x0) > (y1 - y0)
                    span = (x1 - x0) if horiz else (y1 - y0)
                    t = 0.05
                    while t < span - 0.05:
                        w_ = trng.uniform(0.03, 0.07)
                        col = trng.choice(["#2e3f5c", "#d9d4ca", "#7d9a86", "#c8664f", "#3a3d45", "#e0a33a", "#f1ebe0"])
                        if horiz:
                            box(f"cl{k}{t:.2f}", x0 + t, y0 + 0.05, 1.0, x0 + t + w_, y1 - 0.05, 1.85, fabric(col), 0.01)
                        else:
                            box(f"cl{k}{t:.2f}", x0 + 0.05, y0 + t, 1.0, x1 - 0.05, y0 + t + w_, 1.85, fabric(col), 0.01)
                        t += w_ + 0.01
                    continue
                if n in ("bath mat", "rug", "runner"):
                    pbox(p, rugmat(p["color"]), 0.004); continue
                if n == "towel":
                    pbox(p, fabric(p["color"]), 0.01); continue
                if n in ("lamp", "desk lamp"):
                    cyl(f"lbase_{k}_{x:.2f}", x, y, z0, z0 + 0.03, 0.08, M["brass"])
                    cyl(f"lpole_{k}_{x:.2f}", x, y, z0, z0 + 0.25, 0.012, M["brass"], 12)
                    cone(f"lshade_{k}_{x:.2f}", x, y, z0 + 0.22, z0 + 0.42, 0.14, 0.10, M["shade"])
                    lamp_at(x, y, z0 + 0.32, 6); continue
                if n in ("planter", "plant"):
                    continue
                pbox(p)
            except Exception as ex:
                print("part fallback", n, ex)
                pbox(p)

    # interior door leaves, hung open 90° into the more private room
    PRIV = {"bedroom": 0, "primary_bedroom": 0, "bathroom": 1, "office": 2, "closet": 3, "laundry": 4}
    door_mat = principled("door_paint", (0.93, 0.92, 0.89), 0.35)
    for i, d in enumerate(L["doors"]):
        if "exterior" in d["between"]:
            continue
        rs = [rooms[x] for x in d["between"] if x in rooms]
        rs.sort(key=lambda r: PRIV.get(r["type"], 9))
        r = rs[0]
        if r["type"] not in PRIV:
            continue
        hw = d["width_ft"] * FT / 2 - 0.02
        x, y = P(d["x"], d["y"])
        rcx, rcy = P(r["x"] + r["w"] / 2, r["y"] + r["h"] / 2)
        on_h = abs(d["y"] - r["y"]) < 0.01 or abs(d["y"] - r["y"] - r["h"]) < 0.01
        if on_h:
            sg = 1 if rcy > y else -1
            hx = x - hw
            box(f"door_leaf{i}", hx, min(y + sg * T / 2, y + sg * (T / 2 + 2 * hw)), 0.005,
                hx + 0.04, max(y + sg * T / 2, y + sg * (T / 2 + 2 * hw)), 2.08, door_mat, 0.004)
            rcyl(f"door_knob{i}", (hx + 0.02, y + sg * (T / 2 + 2 * hw - 0.08), 1.0), 0.025, 0.09, M["chrome"], "X", 16)
        else:
            sg = 1 if rcx > x else -1
            hy = y - hw
            box(f"door_leaf{i}", min(x + sg * T / 2, x + sg * (T / 2 + 2 * hw)), hy, 0.005,
                max(x + sg * T / 2, x + sg * (T / 2 + 2 * hw)), hy + 0.04, 2.08, door_mat, 0.004)
            rcyl(f"door_knob{i}", (x + sg * (T / 2 + 2 * hw - 0.08), hy + 0.02, 1.0), 0.025, 0.09, M["chrome"], "Y", 16)

    # painted accent wall behind each bed (split around windows on that wall)
    ACCENTS = [(0.20, 0.27, 0.36), (0.42, 0.50, 0.43), (0.60, 0.42, 0.35), (0.36, 0.40, 0.52)]
    beds = [it for it in payload.get("items", []) if it.get("name") == "bed"]
    for bi, it in enumerate(beds):
        r = rooms.get(it["room"])
        if not r:
            continue
        fx, fy = it["front"]
        side = "north" if fy > 0.5 else "south" if fy < -0.5 else "west" if fx > 0.5 else "east"
        amat = pbr(f"accent{bi}", "plaster", tint=ACCENTS[bi % len(ACCENTS)], tint_amt=0.88, rough_mul=0.4, rough_add=0.55, normal_strength=0.3)
        horiz = side in ("north", "south")
        a0, a1 = (r["x"], r["x"] + r["w"]) if horiz else (r["y"], r["y"] + r["h"])
        line = r["y"] if side == "north" else r["y"] + r["h"] if side == "south" else r["x"] if side == "west" else r["x"] + r["w"]
        cuts = sorted((s0, s1) for (o, l, s0, s1, rid) in wins if rid == r["id"] and (o == "h") == horiz and abs(l - line) < 0.01)
        pieces, cur = [], a0
        for s0, s1 in cuts:
            pieces += [(cur, s0, 0.1, H), (s0, s1, 0.1, 0.85), (s0, s1, 2.15, H)]
            cur = s1
        pieces.append((cur, a1, 0.1, H))
        inward = 1 if side in ("north", "west") else -1     # plan direction into the room
        for j, (s0, s1, z0, z1) in enumerate(pieces):
            if s1 - s0 < 0.01:
                continue
            if horiz:
                bx0, _ = P(s0, 0); bx1, _ = P(s1, 0)
                yb = (FD - line) * FT - inward * (T / 2)        # wall face toward the room (plan +y = Blender -y)
                box(f"accent{bi}_{j}", bx0 + 0.01, min(yb, yb - inward * 0.004), z0, bx1 - 0.01, max(yb, yb - inward * 0.004), z1, amat)
            else:
                xb = line * FT + inward * (T / 2)
                y_a, y_b = (FD - s1) * FT, (FD - s0) * FT
                box(f"accent{bi}_{j}", min(xb, xb + inward * 0.004), y_a + 0.01, z0, max(xb, xb + inward * 0.004), y_b - 0.01, z1, amat)


    # ---------------- lights: recessed downlights per room ----------------
    down = emissive("downlight", (1.0, 0.92, 0.82), 12.0)
    for r in L["rooms"]:
        rx0, ry1 = P(r["x"], r["y"])
        rx1, ry0 = P(r["x"] + r["w"], r["y"] + r["h"])
        wm, hm = rx1 - rx0, ry1 - ry0
        nx, ny = max(1, round(wm / 2.3)), max(1, round(hm / 2.3))
        area = wm * hm
        per = max(9.0, min(45.0, area * 4.2 / (nx * ny)))
        if r["type"] in ("bathroom", "laundry", "closet"):
            per *= 1.25
        for i in range(nx):
            for j in range(ny):
                x = rx0 + wm * (i + 0.5) / nx
                y = ry0 + hm * (j + 0.5) / ny
                cyl(f"dl_{r['id']}{i}{j}", x, y, H - 0.004, H, 0.055, down, 24)
                ob = light(f"dlL_{r['id']}{i}{j}", "AREA", (x, y, H - 0.01), (0, 0, -1), per, (1.0, 0.88, 0.76), size=0.12)
                try:
                    ob.data.spread = math.radians(110)
                except AttributeError:
                    pass
    for i, (x, y, z, e) in enumerate(lamps):
        ld = bpy.data.lights.new(f"lamp{i}", "POINT")
        ld.energy = e
        ld.color = warm
        ld.shadow_soft_size = 0.05
        ob = bpy.data.objects.new(f"lamp{i}", ld)
        ob.location = (x, y, z)
        coll.objects.link(ob)


    sun_pos = Vector((math.cos(want_az) * math.cos(elev), math.sin(want_az) * math.cos(elev), math.sin(elev)))
    light("sun", "SUN", (0, 0, 30), tuple(-sun_pos), max(sun_E, 1.0), sun_col)
    for i, (axis, c, s, e, z0, z1) in enumerate(portals):
        mid, zc = (s + e) / 2, (z0 + z1) / 2
        if axis == "x":
            inward = (0, 1, 0) if c < Dm / 2 else (0, -1, 0)
            loc = (mid, c + inward[1] * 0.1, zc)
        else:
            inward = (1, 0, 0) if c < Wm / 2 else (-1, 0, 0)
            loc = (c + inward[0] * 0.1, mid, zc)
        light(f"portal{i}", "AREA", loc, inward, 1.0, size=e - s, size_y=z1 - z0, portal=True)

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
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    scene.view_settings.exposure = 0.7
    cy.denoising_prefilter = "ACCURATE"
    try:
        cy.use_light_tree = True
    except AttributeError:
        pass
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


EXTRA_MODELS = ["mid_century_lounge_chair", "coffee_table_round_01", "modern_wooden_cabinet", "wicker_basket_01",
                "decorative_book_set_01", "ceramic_vase_02", "ceramic_vase_03"]


@app.function(volumes={ASSETS: assets_vol}, timeout=1800, cpu=4)
def fetch_extra_models():
    """Download extra Poly Haven models into the shared asset volume and add them to manifest.json."""
    import concurrent.futures as cf
    import os
    import urllib.request
    UA = {"User-Agent": "build-render/1.0"}
    get = lambda u: json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60).read())

    def dl(url, path):
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return 0
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600).read()
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
        return len(data)

    man_p = f"{ASSETS}/manifest.json"
    manifest = json.load(open(man_p))
    jobs = []
    for mid in EXTRA_MODELS:
        f = get(f"https://api.polyhaven.com/files/{mid}")
        res = "2k" if "2k" in f["blend"] else next(iter(f["blend"]))
        b = f["blend"][res]["blend"]
        base = f"{ASSETS}/models/{mid}"
        bp = f"{base}/{os.path.basename(b['url'])}"
        jobs.append((b["url"], bp))
        for rel, inc in b.get("include", {}).items():
            jobs.append((inc["url"], f"{base}/{rel}"))
        manifest["models"][mid] = bp
    with cf.ThreadPoolExecutor(12) as ex:
        total = sum(ex.map(lambda j: dl(*j), jobs))
    json.dump(manifest, open(man_p, "w"), indent=1)
    assets_vol.commit()
    return {"files": len(jobs), "mb": round(total / 1e6, 1)}


@app.function(gpu="L40S", timeout=1800, cpu=8, memory=32768, volumes={ASSETS: assets_vol})
def render_layout_node(payload: dict, node: dict, width: int = 2048, samples: int = 128, threshold: float = 0.008) -> dict:
    """Render one 360° panorama. node = {id, x, y} in Blender metres (x east, y north)."""
    import time

    import bpy

    t0 = time.time()
    manifest = json.loads(pathlib.Path(f"{ASSETS}/manifest.json").read_text())
    scene, cam, info = build_scene(manifest, payload)
    t_build = time.time() - t0
    backend, devs = enable_gpu(scene)
    cam.location = (node["x"], node["y"], EYE)
    scene.render.resolution_x = width
    scene.render.resolution_y = width // 2
    scene.render.resolution_percentage = 100
    scene.cycles.samples = samples
    scene.cycles.adaptive_threshold = threshold
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 90
    scene.render.filepath = f"/tmp/{node['id']}.jpg"
    bpy.ops.render.render(write_still=True)
    return {"id": node["id"], "jpg": pathlib.Path(f"/tmp/{node['id']}.jpg").read_bytes(), "backend": backend,
            "build_s": round(t_build, 1), "seconds": round(time.time() - t0, 1)}


@app.local_entrypoint()
def main(payload: str, node: str = "", width: int = 1024, samples: int = 32):
    """Smoke test: render one node of a saved payload (+ its tour) to render/out/."""
    import sys
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    from tour import plan_tour
    data = json.loads(pathlib.Path(payload).read_text())
    tour = plan_tour(data)
    nid = node or tour["start"]
    n = {"id": nid, **{k: tour["scenes"][nid][k] for k in ("x", "y")}}
    res = render_layout_node.remote(data, n, width, samples)
    out = pathlib.Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)
    (out / f"{nid}.jpg").write_bytes(res["jpg"])
    print({k: v for k, v in res.items() if k != "jpg"}, "->", out / f"{nid}.jpg")


@app.function(volumes={ASSETS: assets_vol}, timeout=900, cpu=8, memory=32768)
def debug_objects(payload: dict, x0: float, y0: float, x1: float, y1: float) -> list:
    """List scene objects whose origin/instance sits inside a Blender XY box (debugging stray geometry)."""
    import bpy
    manifest = json.loads(pathlib.Path(f"{ASSETS}/manifest.json").read_text())
    build_scene(manifest, payload)
    dg = bpy.context.evaluated_depsgraph_get()
    out = {}
    from mathutils import Vector
    for inst in dg.object_instances:
        ob = inst.object
        if ob.type == "MESH":
            pts = [inst.matrix_world @ Vector(c) for c in ob.bound_box]
            loc = sum(pts, Vector()) / 8
        else:
            loc = inst.matrix_world.translation
        if x0 < loc.x < x1 and y0 < loc.y < y1 and loc.z < 1.2:
            name = f"{inst.parent.name if inst.is_instance and inst.parent else '-'} :: {inst.object.name} :: {inst.object.data.name if inst.object.data else ''}"
            out[name] = out.get(name, 0) + 1
    return sorted(out.items(), key=lambda kv: -kv[1])[:60]


@app.function(volumes={ASSETS: assets_vol}, timeout=600, cpu=4, memory=16384)
def model_objects(mid: str) -> list:
    import bpy
    m = json.load(open(f"{ASSETS}/manifest.json"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(m["models"][mid], link=False) as (src, dst):
        dst.objects = list(src.objects)
    return [(o.name, o.type, [round(v, 2) for v in o.dimensions], [round(v, 2) for v in o.location]) for o in dst.objects if o]
