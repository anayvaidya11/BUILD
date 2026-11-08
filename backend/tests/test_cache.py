import json

import pytest
from fastapi import HTTPException

from walkthru import api
from walkthru.schema import Check


def test_cache_rechecks_layout_before_serving(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "CACHE_DIR", tmp_path)
    sample = api.sample()
    bad = sample.model_copy(deep=True)
    next(d for d in bad.layout.doors if "laundry" in d.between).x += 100  # off its wall
    (tmp_path / "bad.json").write_text(json.dumps(bad.model_dump(by_alias=True)))
    with pytest.raises(HTTPException) as exc:
        api._cached()
    assert exc.value.status_code == 503

    (tmp_path / "good.json").write_text(json.dumps(sample.model_dump(by_alias=True)))
    result = api._cached()
    assert result.cached
    assert all(c.pass_ for c in result.layout.checks)


def test_sample_fails_closed_when_checker_rejects(monkeypatch):
    monkeypatch.setattr(api.checker, "check", lambda layout: [Check(rule="test", pass_=False, message="invalid")])
    with pytest.raises(HTTPException) as exc:
        api.sample()
    assert exc.value.status_code == 503
