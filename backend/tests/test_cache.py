import json

import pytest
from fastapi import HTTPException

from walkthru import api


def test_cache_rechecks_layout_before_serving(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "CACHE_DIR", tmp_path)
    sample = api.sample()
    (tmp_path / "bad.json").write_text(json.dumps(sample.model_dump(by_alias=True)))
    with pytest.raises(HTTPException) as exc:
        api._cached()
    assert exc.value.status_code == 503

    laundry = sample.layout.room("laundry")
    kitchen = sample.layout.room("kitchen")
    laundry.w = 3
    kitchen.x += 0.5
    kitchen.w -= 0.5
    door = next(d for d in sample.layout.doors if "laundry" in d.between)
    door.x = 1.5
    (tmp_path / "good.json").write_text(json.dumps(sample.model_dump(by_alias=True)))
    result = api._cached()
    assert result.cached
    assert all(c.pass_ for c in result.layout.checks)
