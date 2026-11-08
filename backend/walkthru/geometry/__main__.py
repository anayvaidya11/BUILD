"""CLI: python -m walkthru.geometry program.json [-o layout.json] [--svg plan.svg] [--previous layout.json]"""
from __future__ import annotations

import argparse
import json
import sys

from . import render_svg, solve


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m walkthru.geometry", description=__doc__)
    ap.add_argument("program", help="room program JSON file ('-' for stdin)")
    ap.add_argument("-o", "--out", help="write layout JSON here (default: stdout)")
    ap.add_argument("--svg", help="also write an SVG floor plan here")
    ap.add_argument("--previous", help="earlier layout JSON, for edits")
    ap.add_argument("--mode", default="auto", choices=("auto", "strict", "derive"),
                    help="footprint handling (default: auto)")
    args = ap.parse_args(argv)

    with (sys.stdin if args.program == "-" else open(args.program)) as f:
        program = json.load(f)
    previous = None
    if args.previous:
        with open(args.previous) as f:
            previous = json.load(f)
    layout = solve(program, previous=previous, footprint_mode=args.mode)

    text = json.dumps(layout, indent=2)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text + "\n")
    else:
        print(text)
    if args.svg:
        with open(args.svg, "w") as f:
            f.write(render_svg(layout))

    s = layout["solver"]
    bad = [c for c in s["selfcheck"] if not c["pass"]]
    fp = layout["footprint"]
    print(f"{fp['width_ft']:g} x {fp['depth_ft']:g} ft, {len(layout['rooms'])} rooms, "
          f"{len(layout['doors'])} doors, {len(layout['windows'])} windows, "
          f"{s['candidates']} candidates in {s['ms']} ms, "
          f"{'all rules pass' if not bad else str(len(bad)) + ' rule(s) fail'}", file=sys.stderr)
    for c in bad:
        print(f"  FAIL {c['rule']}: {c['message']}", file=sys.stderr)
    for w in s["warnings"]:
        print(f"  note: {w}", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
