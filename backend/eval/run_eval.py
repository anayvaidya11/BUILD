"""Role 3: proof number. Raw Claude (draws geometry itself) vs. our planner+solver+checker loop.

    python -m eval.run_eval --mode both --n 30      # from backend/
Writes eval/results.json; the summary is what goes on the proof slide.
"""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from walkthru import checker, pipeline, planner

HERE = Path(__file__).parent


def run_raw(prompt: str) -> dict:
    t0 = time.perf_counter()
    try:
        layout = planner.raw_layout(prompt)
        checks = checker.check(layout)
        failed = [c.rule for c in checks if not c.pass_]
        return {"prompt": prompt, "ok": not failed, "failed": failed, "s": time.perf_counter() - t0}
    except Exception as e:
        return {"prompt": prompt, "ok": False, "failed": ["error"], "error": repr(e), "s": time.perf_counter() - t0}


def run_loop(prompt: str) -> dict:
    t0 = time.perf_counter()
    try:
        r = pipeline.generate(prompt)
        return {"prompt": prompt, "ok": True, "failed": [], "rounds": len(r.rounds), "attempts": r.attempts, "s": r.elapsed_s}
    except Exception as e:
        return {"prompt": prompt, "ok": False, "failed": ["error"], "error": repr(e), "s": time.perf_counter() - t0}


def summarize(rows: list[dict]) -> dict:
    n = len(rows) or 1
    by_rule: dict[str, int] = {}
    for r in rows:
        for f in r["failed"]:
            by_rule[f] = by_rule.get(f, 0) + 1
    out = {
        "n": len(rows),
        "plans_with_violations_pct": round(100 * sum(not r["ok"] for r in rows) / n, 1),
        "violations_by_rule": by_rule,
        "mean_s": round(sum(r["s"] for r in rows) / n, 1),
    }
    if rows and "rounds" in rows[0]:
        ok = [r for r in rows if r["ok"]]
        out["mean_fix_rounds"] = round(sum(r["rounds"] for r in ok) / max(len(ok), 1), 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["raw", "loop", "both"], default="both")
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    prompts = [p for p in (HERE / "prompts.txt").read_text().splitlines() if p.strip()][: args.n]

    results = {}
    modes = ["raw", "loop"] if args.mode == "both" else [args.mode]
    for mode in modes:
        fn = run_raw if mode == "raw" else run_loop
        with ThreadPoolExecutor(args.workers) as ex:
            rows = list(ex.map(fn, prompts))
        results[mode] = {"summary": summarize(rows), "rows": rows}
        print(mode, json.dumps(results[mode]["summary"], indent=2))
    (HERE / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
