from eval.run_eval import requested_area, summarize


def test_eval_area_and_error_accounting():
    assert requested_area("3 bed, about 1,800 sq ft") == 1800
    rows = [
        {"ok": False, "failed": ["door_geometry"], "error": None, "s": 2.0, "rounds": 1},
        {"ok": False, "failed": [], "error": "API timeout", "s": 4.0},
        {"ok": True, "failed": [], "error": None, "s": 3.0, "rounds": 0},
    ]
    summary = summarize(rows)
    assert summary["generation_errors"] == 1
    assert summary["plans_with_violations_pct"] == 33.3
    assert summary["plans_passing_pct"] == 33.3
    assert summary["violations_by_rule"] == {"door_geometry": 1}
