"""What the app's input range looks like by the time it reaches the solver.

Users type anything from "3 bed 2 bath" to a paragraph. The planner (Claude, role 1) turns
that into a RoomProgram limited to schema.RoomType, sized to ~88% of the requested total
(PLAN_SYSTEM). We can't call Claude in tests, so `house()` emulates a planner that follows
those rules, and PROMPTS maps prompts -> the program such a planner would plausibly return.

Tiers:
  basic        counts only ("3 bed 2 bath"), planner fills the rest (1,800 sq ft default)
  eval         the 30 prompts in eval/prompts.txt (role 3's proof-slide set)
  complex      long, feature-heavy descriptions (suites, pantry, mudroom, garage, ...)
  out_of_scope things the product doesn't build (2 stories, basement, pool) -> flattened
"""

SIZES = {  # typical targets before scaling to the requested total
    "living": 320, "family": 260, "kitchen": 180, "dining": 140, "entry": 55,
    "primary_bedroom": 220, "bedroom": 130, "ensuite": 75, "bathroom": 55, "half": 25,
    "office": 110, "laundry": 45, "mudroom": 45, "pantry": 30, "wic": 45, "garage": 420,
}


def house(total=1800, beds=3, baths=2.0, *, offices=0, laundry=False, dining=True, entry=False,
          family=False, mudroom=False, pantry=False, wic=False, all_ensuite=False, garage=False,
          big_living=False, big_kitchen=False, big_primary=False, office_sqft=None, notes=""):
    rooms = []

    def add(rid, rtype, key, name, adj=(), sqft=None):
        rooms.append({"id": rid, "type": rtype, "name": name, "target_sqft": sqft or SIZES[key],
                      "adjacent_to": list(adj)})

    add("living", "living", "living", "Living Room", ["dining"] if dining else ["kitchen"],
        sqft=SIZES["living"] * (1.35 if big_living else 1))
    add("kitchen", "kitchen", "kitchen", "Kitchen", ["dining"] if dining else ["living"],
        sqft=SIZES["kitchen"] * (1.3 if big_kitchen else 1))
    if dining:
        add("dining", "dining", "dining", "Dining", ["kitchen", "living"])
    if family:
        add("family", "living", "family", "Family Room", ["kitchen"])
    if entry:
        add("entry", "entry", "entry", "Foyer", ["living"])
    if pantry:
        add("pantry", "closet", "pantry", "Pantry", ["kitchen"])

    full, half = int(baths), round((baths % 1) * 2)
    for i in range(1, beds + 1):
        primary = i == 1
        bid = "primary_bedroom" if primary else f"bedroom_{i}"
        kids = []
        if (primary and full >= 2) or (all_ensuite and full >= i):
            kids.append(f"bathroom_{i}")
        add(bid, "primary_bedroom" if primary else "bedroom", "primary_bedroom" if primary else "bedroom",
            "Primary Bedroom" if primary else f"Bedroom {i}", kids,
            sqft=SIZES["primary_bedroom"] * (1.3 if big_primary else 1) if primary else None)
        if kids:
            add(kids[0], "bathroom", "ensuite", "Primary Bath" if primary else f"Bath {i}", [bid])
        if primary and wic:
            add("walk_in_closet", "closet", "wic", "Walk-in Closet", [bid])
    used = sum(r["type"] == "bathroom" for r in rooms)
    for j in range(used + 1, full + 1):
        add(f"bathroom_{j}", "bathroom", "bathroom", f"Bath {j}")
    for j in range(half):
        add(f"powder_{j + 1}", "bathroom", "half", "Powder Room")
    for j in range(offices):
        add(f"office_{j + 1}" if offices > 1 else "office", "office", "office",
            f"Office {j + 1}" if offices > 1 else "Office", sqft=office_sqft)
    if laundry or mudroom:
        add("laundry", "laundry", "laundry", "Laundry")
    if mudroom:
        add("mudroom", "laundry", "mudroom", "Mudroom", ["garage"] if garage else [])
    if garage:  # no garage RoomType: the planner has to squeeze it into an allowed type
        add("garage", "closet", "garage", "Two-Car Garage", ["mudroom"] if mudroom else [])

    # scale to ~88% of the requested total like PLAN_SYSTEM asks (garage counted as built area)
    f = 0.88 * total / sum(r["target_sqft"] for r in rooms)
    for r in rooms:
        r["target_sqft"] = max(15, round(r["target_sqft"] * f / 5) * 5)
        if r["type"] == "bathroom":  # requirements.py: a bathroom under 45 sq ft is a half bath
            half_bath = r["name"] == "Powder Room"
            r["target_sqft"] = min(r["target_sqft"], 40) if half_bath else max(r["target_sqft"], 45)
    return {"requested_sqft": total, "aspect_ratio": 1.4, "notes": notes, "rooms": rooms}


PROMPTS = {
    # ---- basic: counts only, everything else defaulted by the planner
    "basic": {
        "3 bed 2 bath": house(),
        "2 bedroom house": house(1100, 2, 1),
        "a small house": house(1000, 2, 1),
        "studio": {"requested_sqft": 450, "aspect_ratio": 1.4, "notes": "", "rooms": [
            {"id": "living", "type": "living", "name": "Great Room", "target_sqft": 260, "adjacent_to": ["kitchen"]},
            {"id": "kitchen", "type": "kitchen", "name": "Kitchen", "target_sqft": 90, "adjacent_to": ["living"]},
            {"id": "bathroom", "type": "bathroom", "name": "Bath", "target_sqft": 45, "adjacent_to": []}]},
    },
    # ---- eval/prompts.txt, one entry per line, in order
    "eval": {
        "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft": house(1800, 3, 2, offices=1, notes="open kitchen"),
        "2 bed, 1 bath cottage, 900 sq ft": house(900, 2, 1, dining=False),
        "4 bedroom family home, 3 baths, big living room, 2,400 sq ft": house(2400, 4, 3, big_living=True),
        "1 bed, 1 bath studio-style home with an office, 750 sq ft": house(750, 1, 1, offices=1, dining=False),
        "3 bed, 2 bath ranch with laundry room, 1,600 sq ft": house(1600, 3, 2, laundry=True),
        "5 bed, 3 bath, formal dining, 3,000 sq ft": house(3000, 5, 3, entry=True, notes="formal dining room"),
        "2 bed, 2 bath, open plan kitchen and living, 1,200 sq ft": house(1200, 2, 2, notes="open plan kitchen and living"),
        "3 bedroom, 2.5 bath, two home offices, 2,000 sq ft": house(2000, 3, 2.5, offices=2),
        "starter home: 2 bedrooms, 1 bathroom, small kitchen, 1,000 sq ft": house(1000, 2, 1),
        "4 bed, 2 bath, kitchen opens onto dining, 2,100 sq ft": house(2100, 4, 2),
        "retirement home, 2 bed, 2 bath, large primary suite, 1,500 sq ft": house(1500, 2, 2, big_primary=True, wic=True),
        "3 bed, 1 bath, eat-in kitchen, 1,300 sq ft": house(1300, 3, 1, dining=False, big_kitchen=True),
        "4 bed, 3 bath with a guest suite, 2,600 sq ft": house(2600, 4, 3, all_ensuite=True),
        "1 bedroom, 1 bath, big living room, 800 sq ft": house(800, 1, 1, dining=False, big_living=True),
        "3 bed, 2 bath, mudroom laundry, office, 1,900 sq ft": house(1900, 3, 2, offices=1, mudroom=True),
        "2 bed, 1 bath, dining room, 1,100 sq ft": house(1100, 2, 1),
        "5 bedroom, 4 bath, office and laundry, 3,200 sq ft": house(3200, 5, 4, offices=1, laundry=True),
        "3 bed, 2 bath modern farmhouse, open kitchen, 2,200 sq ft": house(2200, 3, 2, entry=True, pantry=True),
        "4 bed, 2.5 bath, separate dining and living, 2,300 sq ft": house(2300, 4, 2.5, notes="separate dining and living rooms"),
        "2 bed, 2 bath with home gym used as office, 1,400 sq ft": house(1400, 2, 2, offices=1),
        "3 bed, 3 bath, each bedroom with its own bath, 2,000 sq ft": house(2000, 3, 3, all_ensuite=True),
        "small 2 bed, 1 bath, 850 sq ft": house(850, 2, 1, dining=False),
        "3 bed, 2 bath, large kitchen island, 1,750 sq ft": house(1750, 3, 2, big_kitchen=True),
        "4 bedroom, 3 bath, two living areas, 2,800 sq ft": house(2800, 4, 3, family=True),
        "1 bed, 1 bath, office, laundry, 950 sq ft": house(950, 1, 1, offices=1, laundry=True, dining=False),
        "3 bed, 2 bath, 1,500 sq ft, kitchen next to living": house(1500, 3, 2, dining=False),
        "6 bed, 4 bath, 3,600 sq ft": house(3600, 6, 4, laundry=True),
        "2 bed, 1 bath, open kitchen, office nook, 1,050 sq ft": house(1050, 2, 1, offices=1, office_sqft=55),
        "3 bed, 2 bath split-bedroom plan, 1,850 sq ft": house(1850, 3, 2, notes="split-bedroom plan"),
        "4 bed, 3 bath, home office, laundry, dining, 2,500 sq ft": house(2500, 4, 3, offices=1, laundry=True),
    },
    # ---- long, feature-heavy descriptions
    "complex": {
        "4 bed 3.5 bath, 2,900 sq ft: foyer, formal dining, open kitchen with walk-in pantry and island, "
        "family room, office near the entry, mudroom and laundry off a 2-car garage, primary suite with "
        "walk-in closet, guest room with its own bath":
            house(2900, 4, 3.5, offices=1, entry=True, family=True, pantry=True, mudroom=True, wic=True,
                  garage=True, notes="formal dining, open kitchen with island"),
        "Modern 3 bed 2.5 bath, about 2,100 sq ft, big open kitchen/living/dining for entertaining, "
        "walk-in pantry, home office, laundry, primary suite with walk-in closet at the back":
            house(2100, 3, 2.5, offices=1, laundry=True, pantry=True, wic=True, big_kitchen=True,
                  notes="open plan for entertaining"),
        "Accessible single-level home for my parents: 2 bedrooms each with their own bathroom, wide "
        "hallways, laundry near the bedrooms, small office, 1,600 sq ft":
            house(1600, 2, 2, offices=1, laundry=True, all_ensuite=True),
        "Family of six: 5 bedrooms, 3 baths, two living areas, big kitchen, mudroom, laundry, "
        "3,400 sq ft": house(3400, 5, 3, family=True, big_kitchen=True, mudroom=True),
    },
    # ---- asks for things we don't build; the planner flattens them to one story
    "out_of_scope": {
        "two-story 4 bed 3 bath with a basement and a pool, 2,800 sq ft": house(2800, 4, 3, laundry=True),
        "tiny 400 sq ft cabin": {"requested_sqft": 400, "aspect_ratio": 1.4, "notes": "", "rooms": [
            {"id": "living", "type": "living", "name": "Living", "target_sqft": 190, "adjacent_to": ["kitchen"]},
            {"id": "kitchen", "type": "kitchen", "name": "Kitchenette", "target_sqft": 60, "adjacent_to": ["living"]},
            {"id": "bedroom", "type": "bedroom", "name": "Sleeping Room", "target_sqft": 80, "adjacent_to": []},
            {"id": "bathroom", "type": "bathroom", "name": "Bath", "target_sqft": 35, "adjacent_to": []}]},
    },
}

ALL = {f"{tier}: {prompt}": prog for tier, items in PROMPTS.items() for prompt, prog in items.items()}
