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


def _cached() -> GenerateResponse:
    files = sorted(CACHE_DIR.glob("*.json"))
    if not files:
        raise HTTPException(503, "API failed and no cached generations in backend/cached/")
    resp = GenerateResponse.model_validate(json.loads(random.choice(files).read_text()))
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
    return GenerateResponse(layout=layout, program=program, rounds=[], elapsed_s=0)


@app.post("/api/generate", response_model=GenerateResponse, response_model_by_alias=True)
def generate(req: GenerateRequest, cached: bool = False):
    if cached:
        return _cached()
    try:
        return pipeline.generate(req.prompt)
    except Exception as e:
        logging.exception("generate failed")
        if os.environ.get("WALKTHRU_CACHE_FALLBACK", "1") == "1":
            return _cached()  # response says cached=true: say so out loud in the demo
        raise HTTPException(500, str(e))


@app.post("/api/edit", response_model=GenerateResponse, response_model_by_alias=True)
def edit(req: EditRequest):
    try:
        return pipeline.edit(req.program, req.layout, req.instruction)
    except Exception as e:
        logging.exception("edit failed")
        raise HTTPException(500, str(e))
