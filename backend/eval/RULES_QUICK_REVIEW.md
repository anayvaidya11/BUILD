# Floor plan rules: quick review

**Status key:** ✅ checker enforces · ◻ approved, pending implementation/data · ◇ approved design score or human review. Walkthru currently models one rectangular footprint with rectangular rooms. These checks assess a concept plan, not permit or accessibility compliance. Details and sources: [FLOOR_PLAN_RULES.md](FLOOR_PLAN_RULES.md).

## Geometry and openings

- ✅ Unique room IDs; finite coordinates on a 0.5 ft grid.
- ✅ Positive room dimensions, no overlaps, no gaps, and all rooms inside the footprint.
- ✅ Doors connect two distinct rooms, fit completely on their shared wall or an exterior wall, and the front door matches the entrance.
- ✅ Windows fit completely on the named room's exterior wall; each bedroom has a valid exterior window.
- ✅ Positive footprint dimensions and finite, positive area targets.
- ◻ No overlapping doors or windows on a wall; no opening straddles a corner.

## Access and room use

- ✅ Every room is reachable from the entrance through valid doors.
- ✅ At least one bathroom is reachable without crossing a bedroom.
- ✅ Halls are at least 3 ft wide; modeled door openings are at least 2 ft 8 in.
- ✅ Kitchen shares at least 3 ft of wall with living or dining.
- ✅ Rooms and total house area stay within 10% of requested sizes; explicit bedroom, bathroom, and office counts match the prompt.
- ◻ Main routes avoid crossing private rooms, closets, and service rooms; named exceptions permit suites.
- ◻ Door swing, actual clear width, fixtures, furniture, and turning clearance once modeled.
- ◻ Bedroom escape opening, room dimensions, glazing, ventilation, landings, and safety equipment once required data and jurisdiction are known.

## Better and more creative plans

- ◇ Honor requested adjacency and separation; zone public, private, and service rooms deliberately.
- ◇ Prefer useful daylight, exterior frontage, privacy, sensible furniture space, and efficient circulation.
- ◇ Offer distinct circulation and zoning schemes, not just mirrored plans.
- ✅ Optional orthogonal outline supports generated L, T, and U-like building silhouettes; area and openings use the room union.
- ◻ Generate courtyard layouts with explicit holes and complete 2D/3D exterior styling.
- ◻ For an L-shaped *room*, represent one room as connected rectangular pieces or an orthogonal polygon; check connectedness, area, openings, and walls as one room.

## Additional approved house rules

- ◻ Kitchen includes a sink; a complete bathroom includes a toilet, lavatory, and tub or shower.
- ◻ Bathroom fixtures and door swing fit with their approach clearances.
- ◻ Habitable rooms meet usable minimum area and width, accounting for any low ceiling.
- ◻ Habitable rooms meet a chosen daylight and ventilation standard, with modeled alternatives.
- ◻ Sleeping-room escape windows meet opening, sill, and exterior-destination requirements.
- ◻ When accessibility is requested, verify actual clear door width, turns, and fixture approach.
- ◻ Locate smoke and carbon monoxide alarms based on sleeping areas and fuel appliances.
- ◻ Main exit routes avoid lockable service rooms and inappropriate dead ends.
- ◇ Test furniture fit and door swings against real usable space.
- ◇ Evaluate exterior access and privacy against the user's intended use.

## Irregular-footprint checks for the proposed contract

- ◻ Boundary is closed, orthogonal, connected, and free of self-intersections or zero-length edges.
- ◻ Courtyard holes are explicit and excluded from floor area; rooms tile the actual usable polygon.
- ◻ Openings attach to the actual exterior boundary, including allowed courtyard edges.
- ◻ Narrow wings and necks maintain passage width; every wing remains reachable.
- ◇ Compare L, T, U, and courtyard alternatives by circulation, daylight, privacy, and build complexity.
