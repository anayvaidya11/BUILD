"""Build or verify three demo backups. Run from backend/: python cached/build_backups.py"""

import argparse
import json
import os
from pathlib import Path

from walkthru import checker, pipeline
from walkthru.schema import GenerateResponse

PROMPTS = {
    "3bed_office": "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft",
    "2bed_cottage": "2 bed, 1 bath cottage, 900 sq ft",
    "4bed_family": "4 bedroom family home, 3 baths, big living room, 2,400 sq ft",
}
HERE = Path(__file__).parent


def validate(name: str, prompt: str, response: GenerateResponse) -> str:
    """Return a layout fingerprint, raising if a backup fails the current rules."""
    checks = checker.check(response.layout) + [checker.check_prompt(prompt, response.layout)]
    failed = [f"{c.rule}: {c.message}" for c in checks if not c.pass_]
    if failed:
        raise RuntimeError(f"{name} failed validation: {'; '.join(failed)}")
    response.layout.checks = checks
    return json.dumps(response.layout.model_dump(exclude={"checks"}), sort_keys=True)


def check_existing() -> None:
    fingerprints = set()
    for name, prompt in PROMPTS.items():
        path = HERE / f"{name}.json"
        response = GenerateResponse.model_validate_json(path.read_text())
        fingerprint = validate(name, prompt, response)
        if fingerprint in fingerprints:
            raise RuntimeError(f"{name} duplicates another backup layout")
        fingerprints.add(fingerprint)
        print(f"valid {path.name}")


def build() -> None:
    if not os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("WALKTHRU_OFFLINE") == "1":
        raise RuntimeError("Building distinct backups requires ANTHROPIC_API_KEY and live planner mode")
    responses = {}
    fingerprints = set()
    for name, prompt in PROMPTS.items():
        response = pipeline.generate(prompt)
        fingerprint = validate(name, prompt, response)
        if fingerprint in fingerprints:
            raise RuntimeError(f"{name} duplicates another backup layout")
        fingerprints.add(fingerprint)
        responses[name] = response
    for name, response in responses.items():
        path = HERE / f"{name}.json"
        path.write_text(json.dumps(response.model_dump(by_alias=True), indent=2) + "\n")
        print(f"saved {path.name} ({response.elapsed_s:.1f}s)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate all three saved backups without an API key")
    args = parser.parse_args()
    check_existing() if args.check else build()


if __name__ == "__main__":
    main()
