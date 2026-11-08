# Rule basis and scope

Role 3 checks whether a generated *conceptual* single-story plan meets the product's stated layout rules. Passing does not mean the design is construction-ready or code-compliant.

| Check | Basis |
|---|---|
| No overlap, complete footprint coverage, valid doors, reachable rooms, area targets | Walkthru PRD and the solver/layout contract in `docs/PRD.md` and `docs/CONTRACTS.md`. These are machine-checkable conditions for the 2D/3D demo. |
| Unique IDs and 0.5 ft room grid | `docs/CONTRACTS.md`; invalid IDs or coordinates make rendering and reachability unreliable. |
| Explicit bedroom/bathroom/office requests | Original prompt, parsed conservatively by role 1's `requirements.py`; role 3 applies the same parser to the final layout. |
| 3 ft hall, 2'8" doorway | Product thresholds in `docs/PRD.md`. The [2021 IRC hallway provision](https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning) also states a 3 ft hallway minimum. The [US Access Board door standard](https://www.access-board.gov/ada/chapter/ch04/) measures *clear opening* at 32 in; our `Door.width_ft` describes a geometric opening, so this checker cannot certify accessible clear width. |
| Kitchen next to dining/living; public bathroom; bedroom exterior wall | Product-specific spatial rules in `docs/PRD.md`. |
| Window placement and bedroom exterior window | A window must fit on the room's actual exterior edge to be meaningful in the 2D/3D model. This remains a geometric check only; emergency escape, glazing area, and ventilation require data absent from the contract. See `FLOOR_PLAN_RULES.md`. |

General room adjacencies and room proportions stay outside the hard gate for this demo. Floor-plan research treats [adjacency and dimensional constraints](https://www.sciencedirect.com/science/article/abs/pii/S092658051931180X) as distinct design inputs. Our `adjacent_to` field does not indicate whether the user requested a relationship or the planner suggested it, so making every pair mandatory would be an unsupported product decision.

The proof slide must report measured raw-Claude and full-loop outcomes separately. Generation errors are counted apart from checker violations; the live 30-prompt run waits for the planner and solver integrations.
