"""Host render/bridge.py on Modal so the deployed site can use Photoreal.

The bridge is a small HTTP server that plans a tour, fans each viewpoint out to the
"build-render" Modal app and serves the finished panoramas. Locally it runs on the laptop;
this wrapper runs the same file inside one long-lived Modal container with a public URL.

  modal deploy render/bridge_modal.py        # prints https://<workspace>--build-bridge-bridge.modal.run
  # then set NEXT_PUBLIC_RENDER_BRIDGE to that URL on the frontend and redeploy it

State: job status and JPEGs live under /root/render/out on a Modal Volume ("build-renders"),
committed every 30 s, so finished renders survive container restarts. One container at a time
keeps the in-memory job table consistent; it idles for 30 min after the last request.
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import threading
import time

import modal

ROOT = pathlib.Path(__file__).resolve().parent
APP = "build-bridge"
PORT = 8790
OUT_DIR = "/root/render/out"
# Modal's URL for a deployed web function: <workspace>--<app>-<function>.modal.run
WORKSPACE = os.environ.get("MODAL_WORKSPACE", "anay-vaidya11")
PUBLIC_URL = os.environ.get("BRIDGE_PUBLIC_URL", f"https://{WORKSPACE}--{APP}-bridge.us-east.modal.run")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("modal")
    .add_local_file(ROOT / "bridge.py", "/root/render/bridge.py")
    .add_local_file(ROOT / "tour.py", "/root/render/tour.py")
)
app = modal.App(APP, image=image)
renders = modal.Volume.from_name("build-renders", create_if_missing=True)


@app.function(
    volumes={OUT_DIR: renders},
    timeout=24 * 3600,
    scaledown_window=30 * 60,
    max_containers=1,
    cpu=2,
    memory=2048,
)
@modal.concurrent(max_inputs=200)
@modal.web_server(PORT, startup_timeout=120)
def bridge():
    env = {**os.environ, "BRIDGE_HOST": "0.0.0.0", "BRIDGE_PORT": str(PORT), "BRIDGE_PUBLIC": PUBLIC_URL}
    subprocess.Popen(["python3", "/root/render/bridge.py"], env=env, cwd="/root/render")

    def keep_committing():
        while True:
            time.sleep(30)
            try:
                renders.commit()
            except Exception:
                pass

    threading.Thread(target=keep_committing, daemon=True).start()
