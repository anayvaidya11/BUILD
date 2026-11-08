"""Build three validated demo backups. Run from backend/: python cached/build_backups.py"""

import json
from pathlib import Path

from walkthru import checker, pipeline

PROMPTS = {
    "3bed_office": "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft",
    "2bed_cottage": "2 bed, 1 bath cottage, 900 sq ft",
    "4bed_family": "4 bedroom family home, 3 baths, big living room, 2,400 sq ft",
}
HERE = Path(__file__).parent


def main() -> None:
    for name, prompt in PROMPTS.items():
        response = pipeline.generate(prompt)
        checks = checker.check(response.layout) + [checker.check_prompt(prompt, response.layout)]
        failed = [c.message for c in checks if not c.pass_]
        if failed:
            raise RuntimeError(f"{name} failed validation: {'; '.join(failed)}")
        response.layout.checks = checks
        (HERE / f"{name}.json").write_text(json.dumps(response.model_dump(by_alias=True), indent=2))
        print(f"saved {name}.json ({response.elapsed_s:.1f}s)")


if __name__ == "__main__":
    main()
