# Floor plan rule catalogue

**Decision (Jimmy, 2026-11-07):** All proposed checks and design goals below are approved for the product roadmap. Approval does not mean the current checker enforces them. Additions requiring fixtures, opening properties, irregular footprint geometry, or shared renderer changes remain pending those contract updates and owner coordination.

Walkthru produces **concept plans**, not permit drawings. The current contract has one rectangular building footprint and rectangular, axis-aligned rooms. A passing checker result establishes consistency with this limited model, not building-code compliance. Local adoption, use, climate, construction, furniture, and actual opening clearances remain unknown.

## Hard gates in the current JSON

| Topic | Rule and edge cases | Current state |
|---|---|---|
| Geometry | Positive room dimensions; finite half-foot coordinates; unique IDs; rooms inside footprint; no positive-area overlap; no uncovered area. Edge or corner contact is not overlap. Reject zero/negative footprint dimensions and nonfinite target values. | Enforced, including positive footprint and target validation. |
| Door topology | Exactly two distinct known endpoints; full opening on a shared wall or exterior edge; positive width; front door at `entrance`; only valid doors connect the reachability graph. A corner touch cannot hold a door. | Enforced except duplicate or overlapping openings. |
| Circulation | Every room reachable from the front door; no bathroom access solely through a bedroom; minimum 3 ft hall and 2 ft 8 in modeled doorway. A room that is reachable only through a closet or bathroom is technically reachable but poor circulation. | Enforced except route quality. |
| Windows | Known room, positive width, entirely on the named exterior edge; bedroom has at least one valid exterior window. A bedroom touching the exterior at only a corner is insufficient. | Enforced in checker. |
| Program | Kitchen shares at least 3 ft of wall with living or dining; each non-hall area and total gross area within 10% of requested target; explicit bedroom/bathroom/office counts checked separately against prompt. | Enforced. |

## Strong next hard gates, after representation and solver agreement

1. **Openings on the same wall:** reject overlapping doors and windows, and openings that occupy the same corner. A door/window overlap is impossible to build and should not pass a visual model. Define opening intervals in absolute wall coordinates; compare only openings on the same physical segment.
2. **Gross/net area semantics:** decide whether `requested_sqft` includes wall thickness and exterior voids. Today it is the rectangular bounding box area. A nonrectangular building needs actual polygon area; otherwise a courtyard can appear to satisfy square footage while providing much less interior space.
3. **Route quality:** require a path from entrance to each bedroom that does not cross a different bedroom, bathroom, closet, laundry, or office. Exceptions should be explicit (suite bath, walk-in closet). Reachability alone permits implausible chains of private rooms.
4. **Door clearance:** check usable clear width, swing, latch side, and conflicts with fixtures after those fields exist. Current `width_ft` is an opening in the wall, not a measured clear width.
5. **Bedroom opening:** require actual emergency escape geometry (net clear area, opening height/width, sill height, exterior destination), not just a window symbol. These properties are missing.
6. **Habitable room dimensions and light:** validate room area, minimum dimension, glazing area and ventilation when ceiling geometry, window height, operability, and any mechanical ventilation alternative are represented.
7. **Wet rooms:** ensure fixture clearances and ventilation; plumbing proximity is a soft efficiency preference, not proof that a bathroom works.
8. **Entry/exit:** check exterior landing, threshold, headroom, travel route, and any additional required exits when actual site and code jurisdiction are known.
9. **Safety layers:** smoke/CO alarms, electrical, structural bearing, fire separation and energy performance need dedicated data and review; they must not be inferred from rectangles.

## Design quality, ranked rather than gated

- Preserve requested adjacencies and separations; keep kitchen near dining, baths near bedrooms, laundry near service areas, and quiet rooms away from noisy entry/living areas. Distinguish user requests from planner suggestions before enforcing `adjacent_to`.
- Give living spaces daylight and useful exterior frontage; avoid deep, narrow rooms and windowless work areas. Rank views, privacy, and exposure with site orientation and climate.
- Reduce excess hallway area while retaining direct routes; allow an entry transition and avoid a front door that opens straight into a private room.
- Consider furniture and fixture footprints, door swing, bed access, kitchen work zones, and bathroom approach clearances once those objects are modeled.
- Produce alternatives with distinct circulation and zoning. A low room count or mere mirror image is not meaningful diversity. Compare adjacency graphs, entrance path, public/private zone placement, and shape signature.

## Creative geometry path

**With the current contract:** vary room proportions, adjacency graph, circulation pattern (spine, loop, split public/private zones), and exterior-facing room placement. All rooms still tile one rectangular bounding box, so these are varied *interiors*, not L, U, T, courtyard, or stepped building outlines.

**Current implementation:** optional `footprint.outline` and `holes` record the orthogonal boundary derived from the union of rectangular rooms. The solver can make L-, T-, and U-like silhouettes from a room program whose notes request one, while keeping `width_ft`/`depth_ft` as viewport bounds. Checker area uses the room union. The courtyard geometry utility recognizes a hole, but the solver does not yet generate a courtyard. Later, represent an L-shaped room as a union of rectangles with one room ID, or an orthogonal polygon, and update wall generation, door attachment, room area, and 2D/3D rendering together. Avoid diagonal or curved walls until the renderer and collision model can handle them.

The change touches `backend/walkthru/schema.py`, `frontend/src/lib/types.ts`, `docs/CONTRACTS.md`, solver, and renderers; it requires the shared-contract board announcement and owner handoffs.

## Research basis

- [2021 IRC chapter 3](https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning): examples of habitable-room size, hallway, egress, and emergency escape provisions. Jurisdiction and edition vary; these are research inputs, not a certification claim.
- [IRC R303.1](https://codes.iccsafe.org/s/IRC2021P2/part-iii-building-planning-and-construction/IRC2021P2-Pt03-Ch03-SecR303.1): glazing and ventilation depend on quantities absent from our window schema.
- [US Access Board, Accessible Routes](https://www.access-board.gov/ada/chapter/ch04/): clear opening is measured differently from wall opening; route and maneuvering clearances require more than a graph.
- [US DOE, building envelope and orientation](https://www.energy.gov/cmei/buildings/zeb-technologies-building-envelope-architectural-considerations): daylight and orientation depend on climate and envelope details.
- [Generating layout designs from high-level specifications](https://www.sciencedirect.com/science/article/abs/pii/S0926580520301199): adjacency, dimensions, rectangular and nonrectangular room/boundary generation are distinct constraints.
- [Automated generation of floorplans with non-rectangular rooms](https://www.sciencedirect.com/science/article/pii/S1524070323000061): graph properties influence which room shapes are realizable.

## Additional house rules to evaluate (research pass 2)

These are **approved requirements**, not new checker gates yet. The implementation pass should test each rule against real generated plans and decide whether it is an absolute failure, a warning, or an optional goal. The current schema lacks fixtures, door swing, window height/operability, site, climate, structure, and occupancy data.

| Candidate | Edge case / decision needed | Data needed |
|---|---|---|
| House has a kitchen with a sink, and a bathroom with toilet, lavatory, and tub or shower | A room named bathroom is not proof it contains fixtures. An ensuite may satisfy this while another bathroom remains public. | Fixture inventory and positions. [IRC R306](https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning) |
| Bathroom fixtures fit with approach clearances | A 40 sq ft bathroom can still have a door that collides with a toilet or shower. Check each fixture's own clearance zone. | Fixture footprints, door swing. [IRC R307](https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning) |
| Habitable rooms meet usable minimum area and narrowest dimension | A 100 sq ft room shaped 2 by 50 ft fails practical use; area alone is insufficient. Kitchens have different exceptions. | Room geometry; ceiling slopes for usable area. [IRC R304](https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning) |
| Habitable rooms have adequate natural light and ventilation, or a valid alternative | A 4 ft wide window symbol has no glazing area or operable area. Mechanical alternatives cannot be rejected from floor geometry alone. | Window height, glazing and operability, ventilation system. [IRC R303.1](https://codes.iccsafe.org/s/IRC2021P2/part-iii-building-planning-and-construction/IRC2021P2-Pt03-Ch03-SecR303.1) |
| Sleeping rooms have a compliant escape and rescue opening | An exterior window may be fixed, too small, too high, or open to an unsuitable court. Do not equate bedroom window with safe egress. | Net clear opening, sill, exterior destination, jurisdiction. [IRC R310](https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning) |
| Access route and door clearances meet an explicit accessibility target | A 2 ft 8 in wall opening does not guarantee 32 in clear width. Turns, passing, and fixture approach need actual free space. Apply only when the user asks for an accessible design or the building type requires it. | Leaf/swing/stop, obstructions, fixture and furniture geometry. [US Access Board](https://www.access-board.gov/ada/chapter/ch04/) |
| Smoke and carbon monoxide alarms are located appropriately | Rectangles do not encode alarms, fuel appliances, or bedroom proximity. This belongs to a safety layer, not an inferred pass. | Alarms, appliances, stories, jurisdiction. [IRC R314–R315](https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning) |
| Exit path does not pass through a lockable or dead-end service space | Graph reachability can pass through a closet or bathroom; a house layout should prefer a direct common-space route. Distinguish occupant convenience from the applicable egress rule. | Door locking and route classification; current graph supports a partial proxy. [OSHA exit-route guidance](https://www.osha.gov/warehousing/hazards-solutions) is for workplaces, not a house mandate. |
| Rooms remain usable after furniture, fixtures, and door swings | A bedroom may have nominal area but no place for a bed or passage around it. Keep this as a scored test until furniture needs are specified. | Furniture and swing envelopes. |
| Exterior access and privacy are intentional | A bedroom opening straight to outside or a front door into a bedroom may be technically connected yet undesirable. Guest versus private entry changes the judgment. | Entrance role and user preferences; door graph supports a partial proxy. |

### L, T, U, and courtyard outline tests

Before permitting any irregular footprint, validate: (1) closed orthogonal boundary with no self-intersections or zero-length edges; (2) no disconnected interior islands; (3) holes explicitly marked as exterior courtyards, with no room occupying them; (4) room union exactly equals the usable interior and its area, not the bounding rectangle; (5) all exterior doors and windows attach to the *actual* boundary, including courtyard edges if allowed; (6) narrow necks maintain the required passage width; (7) every wing is reachable through valid doors; (8) room and wall rendering share the same boundary topology; (9) construction complexity, perimeter-to-area ratio, and courtyard daylight are design scores, not hard failures. L and T are single polygons; U can be a single indented polygon; a fully enclosed courtyard requires a polygon with a hole. Test very thin wings, touching corners, nested holes, and entrances on concave edges.
