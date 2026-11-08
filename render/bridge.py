"""Local bridge between the build web UI and the Modal Cycles renderer.

  python3 render/bridge.py            # http://127.0.0.1:8790

POST /render  {layout, parts, items, quality: "preview"|"final"}  -> {job, status, ...}
GET  /render/<job>                                              -> progress + tour + image urls
GET  /health
GET  /renders/<job>/<file>.jpg                                  -> rendered panoramas (CORS open)

Each viewpoint renders on its own Modal L40S in parallel (render/blender_render.py, deployed as app
"build-render"). Images land in render/out/renders/<job>/ and the bridge serves
them to the web app itself. Identical requests reuse finished renders (job id = hash of the scene).
"""
import hashlib
import json
import pathlib
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from tour import plan_tour  # noqa: E402

import os
PORT = int(os.environ.get("BRIDGE_PORT", 8790))
HOST = os.environ.get("BRIDGE_HOST", "127.0.0.1")  # 0.0.0.0 when hosted (render/bridge_modal.py)
OUT = ROOT / "out" / "renders"
PUBLIC = os.environ.get("BRIDGE_PUBLIC", f"http://127.0.0.1:{PORT}") + "/renders"
# (width, samples, adaptive threshold). "auto" = fast preview, then an automatic 4K high-quality pass per room
# v2: preview trades samples for speed (the denoiser covers it); the 4K pass runs 192 spp instead of
# 512, about 3x faster per room with no visible noise indoors. QUALITY_VERSION busts cached jobs.
QUALITY = {"test": (1024, 32, 0.02), "preview": (2048, 64, 0.02), "final": (4096, 192, 0.008)}
QUALITY_VERSION = 2
JOBS = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=24)
_fn = None


def render_fn():
    global _fn
    if _fn is None:
        import modal
        _fn = modal.Function.from_name("build-render", "render_layout_node")
    return _fn


def save(job):
    d = OUT / job["job"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "status.json").write_text(json.dumps(job, indent=1))


def run_node(job, nid, payload, quality, then_hq=False):
    node = job["nodes"][nid]
    hq = quality == "final" and then_hq is None
    width, samples, thr = QUALITY[quality]
    if hq:
        node["hq_state"] = "rendering"
    else:
        node["state"] = "rendering"
        node["started"] = time.time()
    try:
        s = job["tour"]["scenes"][nid]
        res = render_fn().remote(payload, {"id": nid, "x": s["x"], "y": s["y"]}, width, samples, thr)
        name = f"{nid}{'_hq' if hq else ''}.jpg"
        (OUT / job["job"] / name).write_bytes(res["jpg"])
        url = f"{PUBLIC}/{job['job']}/{name}"
        if hq:
            node.update(hq_state="done", url=url, hq=True, hq_seconds=res["seconds"])
        else:
            node.update(state="done", url=url, seconds=res["seconds"], build_s=res["build_s"])
    except Exception as e:  # keep the rest of the tour going
        if hq:
            node.update(hq_state="error", hq_error=str(e)[:300])
        else:
            node.update(state="error", error=str(e)[:300])
    if then_hq and node.get("state") == "done":
        POOL.submit(run_node, job, nid, payload, "final", None)
    with LOCK:
        nodes = job["nodes"].values()
        first = all(n["state"] in ("done", "error") for n in nodes)
        hq_pending = any(n.get("hq_state") in ("queued", "rendering") for n in nodes)
        if first and not hq_pending:
            job["status"] = "done" if any(n["state"] == "done" for n in nodes) else "error"
            job["finished"] = time.time()
        elif first:
            job["status"] = "refining"
        save(job)


def start_job(payload):
    quality = payload.get("quality", "auto")
    if quality not in QUALITY and quality != "auto":
        quality = "auto"
    scene = {k: payload[k] for k in ("layout", "parts", "items")}
    key = hashlib.sha1(json.dumps([scene, payload.get("only"), QUALITY_VERSION], sort_keys=True).encode()).hexdigest()[:12] + "-" + quality
    with LOCK:
        if key in JOBS:
            return JOBS[key]
        done = OUT / key / "status.json"
        if done.exists():
            job = json.loads(done.read_text())
            if job.get("status") == "done":
                JOBS[key] = job
                return job
        tour = plan_tour(scene)
        if payload.get("only"):  # render a subset (smoke tests)
            tour["scenes"] = {k: v for k, v in tour["scenes"].items() if k in payload["only"]}
            tour["start"] = next(iter(tour["scenes"]))
        job = {"job": key, "quality": quality, "status": "rendering", "created": time.time(), "tour": tour,
               "nodes": {nid: {"state": "queued", "label": s["label"], **({"hq_state": "queued"} if quality == "auto" else {})}
                         for nid, s in tour["scenes"].items()},
               "base": f"{PUBLIC}/{key}/"}
        JOBS[key] = job
        save(job)
    # start with the start room so the viewer can open as early as possible
    order = [tour["start"]] + [n for n in tour["scenes"] if n != tour["start"]]
    for nid in order:
        if quality == "auto":
            POOL.submit(run_node, job, nid, scene, "preview", True)
        else:
            POOL.submit(run_node, job, nid, scene, quality, False)
    return job


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        # 204 must not carry a body: strict proxies (Modal's) reject "data after Connection: close"
        body = b"" if code == 204 else json.dumps(obj).encode()
        self.send_response(code)
        if body:
            self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.startswith("/renders/"):
            parts = self.path.split("?")[0].split("/")
            f = (OUT / parts[2] / parts[3]) if len(parts) == 4 else None
            if not f or ".." in self.path or not f.is_file():
                return self._send(404, {"error": "not found"})
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/health":
            return self._send(200, {"ok": True, "jobs": len(JOBS)})
        if self.path.startswith("/render/"):
            job = JOBS.get(self.path.split("/")[2])
            if not job:
                p = OUT / self.path.split("/")[2] / "status.json"
                job = json.loads(p.read_text()) if p.exists() else None
            return self._send(200 if job else 404, job or {"error": "unknown job"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/save":  # debugging: keep the last payload on disk
            n = int(self.headers.get("Content-Length", 0))
            (ROOT / "out").mkdir(exist_ok=True)
            (ROOT / "out" / "payload.json").write_bytes(self.rfile.read(n))
            return self._send(200, {"ok": True})
        if self.path != "/render":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(n))
            job = start_job(payload)
        except Exception as e:
            return self._send(400, {"error": str(e)[:300]})
        self._send(200, job)

    def log_message(self, fmt, *args):
        sys.stderr.write("[bridge] " + fmt % args + "\n")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"build render bridge on http://{HOST}:{PORT}  ->  {OUT}")
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
