"""Build or verify three demo backups. Run from backend/: python cached/build_backups.py"""

import argparse
import json
import os
from pathlib import Path

from walkthru import checker, pipeline, planner, solver
from walkthru.schema import GenerateResponse, RoomProgram, RoomSpec

PROMPTS = {
    "3bed_office": "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft",
    "2bed_cottage": "2 bed, 1 bath cottage, 900 sq ft",
    "4bed_family": "4 bedroom family home, 3 baths, big living room, 2,400 sq ft",
}
HERE = Path(__file__).parent


def offline_programs() -> dict[str, RoomProgram]:
    """Curated fallback programs for a demo without a live Claude API key."""
    def room(id: str, type: str, name: str, sqft: float, adjacent_to=()) -> RoomSpec:
        return RoomSpec(id=id, type=type, name=name, target_sqft=sqft, adjacent_to=list(adjacent_to))

    return {
        "3bed_office": planner.sample_program(),
        "2bed_cottage": RoomProgram(
            requested_sqft=900, aspect_ratio=1.25, notes="2 bed, 1 bath cottage",
            rooms=[
                room("primary_bedroom", "primary_bedroom", "Primary Bedroom", 150),
                room("bedroom_2", "bedroom", "Bedroom 2", 100),
                room("bathroom", "bathroom", "Bathroom", 50),
                room("kitchen", "kitchen", "Kitchen", 100, ["dining"]),
                room("dining", "dining", "Dining", 80, ["kitchen", "living"]),
                room("living", "living", "Living Room", 270, ["dining"]),
                room("laundry", "laundry", "Laundry", 40),
            ],
        ),
        "4bed_family": RoomProgram(
            requested_sqft=2400, aspect_ratio=1.5, notes="4 bed, 3 bath family home",
            rooms=[
                room("primary_bedroom", "primary_bedroom", "Primary Bedroom", 300, ["bathroom_1"]),
                room("bathroom_1", "bathroom", "Primary Bath", 90, ["primary_bedroom"]),
                room("bedroom_2", "bedroom", "Bedroom 2", 150),
                room("bedroom_3", "bedroom", "Bedroom 3", 150),
                room("bedroom_4", "bedroom", "Bedroom 4", 150),
                room("bathroom_2", "bathroom", "Bath 2", 70),
                room("bathroom_3", "bathroom", "Bath 3", 65),
                room("kitchen", "kitchen", "Kitchen", 240, ["dining"]),
                room("dining", "dining", "Dining", 200, ["kitchen", "living"]),
                room("living", "living", "Living Room", 620, ["dining"]),
                room("laundry", "laundry", "Laundry", 75),
            ],
        ),
    }


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


def build(offline: bool = False) -> None:
    if not offline and (not os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("WALKTHRU_OFFLINE") == "1"):
        raise RuntimeError("Building distinct backups requires ANTHROPIC_API_KEY and live planner mode")
    responses = {}
    fingerprints = set()
    programs = offline_programs() if offline else {}
    for name, prompt in PROMPTS.items():
        if offline:
            program = programs[name]
            response = GenerateResponse(
                layout=solver.solve(program), program=program, rounds=[], elapsed_s=0, cached=True,
            )
        else:
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
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="validate all three saved backups without an API key")
    mode.add_argument("--offline", action="store_true", help="build three curated backups without Claude")
    args = parser.parse_args()
    check_existing() if args.check else build(offline=args.offline)


if __name__ == "__main__":
    main()
