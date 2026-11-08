"""Role 6: FastAPI server. Run: uvicorn walkthru.api:app --reload --port 8000"""

from __future__ import annotations

import json
import logging
import os
import random
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import pipeline, planner, solver, checker
from .schema import EditRequest, GenerateRequest, GenerateResponse

logging.basicConfig(level=logging.INFO)
CACHE_DIR = Path(__file__).resolve().parent.parent / "cached"

app = FastAPI(title="Walkthru")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("WALKTHRU_CORS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _cached(prompt: str = "") -> GenerateResponse:
    files = sorted(CACHE_DIR.glob("*.json"))
    if not files:
        raise HTTPException(503, "API failed and no cached generations in backend/cached/")
    valid = []
    for file in files:
        try:
            resp = GenerateResponse.model_validate(json.loads(file.read_text()))
            resp.layout.checks = checker.check(resp.layout)
            if all(c.pass_ for c in resp.layout.checks):
                valid.append(resp)
            else:
                logging.warning("ignoring invalid cached layout: %s", file.name)
        except (OSError, ValueError) as exc:
            logging.warning("ignoring unreadable cached layout %s: %s", file.name, exc)
    if not valid:
        raise HTTPException(503, "No cached generations pass the current layout rules")
    if prompt:
        matching = [resp for resp in valid if checker.check_prompt(prompt, resp.layout).pass_]
        if matching:
            valid = matching
    resp = random.choice(valid)
    resp.cached = True
    return resp


@app.get("/health")
def health():
    return {"ok": True, "model": planner.MODEL, "offline": planner.offline()}


@app.get("/api/sample", response_model=GenerateResponse, response_model_by_alias=True)
def sample():
    """Hardcoded plan (no Claude call) so the UI and 3D can build against real data."""
    program = planner.sample_program()
    layout = solver.solve(program)
    layout.checks = checker.check(layout)
    failed = checker.failures(layout.checks)
    if failed:
        logging.error("sample layout failed validation: %s", [(c.rule, c.message) for c in failed])
        raise HTTPException(503, "Sample layout does not pass the current layout rules")
    return GenerateResponse(layout=layout, program=program, rounds=[], elapsed_s=0)


@app.post("/api/generate", response_model=GenerateResponse, response_model_by_alias=True)
def generate(req: GenerateRequest, cached: bool = False):
    if cached:
        return _cached(req.prompt)
    try:
        return pipeline.generate(req.prompt)
    except Exception as e:
        logging.exception("generate failed")
        if os.environ.get("WALKTHRU_CACHE_FALLBACK", "1") == "1":
            return _cached(req.prompt)  # response says cached=true: say so out loud in the demo
        raise HTTPException(500, str(e))


@app.post("/api/edit", response_model=GenerateResponse, response_model_by_alias=True)
def edit(req: EditRequest):
    try:
        return pipeline.edit(req.program, req.layout, req.instruction)
    except Exception as e:
        logging.exception("edit failed")
        raise HTTPException(500, str(e))
