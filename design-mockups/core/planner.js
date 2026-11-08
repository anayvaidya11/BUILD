// build — mock planner + solver. Prompt -> RoomProgram -> Layout (CONTRACTS.md shape).
// Stands in for the backend (Claude planner + geometry solver) so every prompt gets its own house.
//
// Plan type: single-storey split-bedroom ranch.
//   west wing   primary suite: bath + walk-in closet (north), bedroom, office by the entry (south)
//   centre      open great room: kitchen + dining (north), living (south, front door)
//   east wing   short hall with secondary bedrooms, shared bath and laundry stacked along it
// Every bedroom gets an exterior wall, every room a door or an opening, kitchen opens to dining.
// Layout extensions used by the mockups: `open` (room pairs with no wall between) and `room.back`
// (preferred furniture back wall).

const sn = (v) => Math.round(v * 2) / 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

export function parsePrompt(prompt) {
  const s = ` ${prompt.toLowerCase()} `;
  const n = (re) => { const m = s.match(re); if (!m) return null; return WORDS[m[1]] ?? parseFloat(m[1]); };
  const studio = /studio/.test(s) && !/\d\s*[- ]?(bed|br)/.test(s);
  const beds = studio ? 0 : clamp(n(/(\d|one|two|three|four|five|six)\s*[- ]?(?:bed|br\b|bedroom)/) ?? 3, 1, 5);
  const baths = clamp(Math.ceil(n(/(\d(?:\.5)?|one|two|three|four)\s*[- ]?(?:bath|ba\b)/) ?? (beds >= 3 ? 2 : 1)), 1, 4);
  const sq = s.match(/([\d][\d,.]*)\s*(k\b|sq|sf|square)/);
  let sqft = sq ? parseFloat(sq[1].replace(/,/g, "")) * (sq[2] === "k" ? 1000 : 1) : null;
  if (!sqft || sqft < 350) sqft = studio ? 700 : 650 + beds * 380;
  return {
    beds, baths, sqft: clamp(sqft, 450, 4000), studio,
    office: /office|study|den|work from home|wfh/.test(s),
    open: !/(closed|separate) kitchen/.test(s),
    bigKitchen: /(big|large|chef'?s?) kitchen/.test(s),
    mud: /mud ?room/.test(s),
    extra: /gym/.test(s) ? "gym" : /reading (room|nook)/.test(s) ? "reading" : null,
  };
}

function program(p) {
  const rooms = [];
  const add = (id, type, name, t, adj = []) => rooms.push({ id, type, name, target_sqft: t, adjacent_to: adj });
  if (p.beds >= 1) {
    add("primary_bedroom", "primary_bedroom", "Primary Bedroom", 230, ["bathroom_1"]);
    add("bathroom_1", "bathroom", "Primary Bath", 65, ["primary_bedroom"]);
    add("closet", "closet", "Walk-in Closet", 35, ["primary_bedroom"]);
  }
  add("kitchen", "kitchen", "Kitchen", p.bigKitchen ? 230 : 175, ["dining"]);
  if (!p.studio) add("dining", "dining", "Dining", 130, ["kitchen", "living"]);
  add("living", "living", "Living Room", p.studio ? 200 : 340, p.studio ? ["kitchen"] : ["dining"]);
  if (p.studio) add("sleep", "bedroom", "Sleeping Nook", 110, ["living"]);
  if (p.office) add("office", "office", "Office", 100);
  let bathN = p.beds >= 1 ? 2 : 1;
  const extraBaths = p.beds >= 1 ? Math.max(1, p.baths - 1) : 1;
  for (let i = 2; i <= p.beds; i++) {
    add(`bedroom_${i}`, "bedroom", `Bedroom ${i}`, 125);
    if ((i === 2 || i === 4) && bathN - 1 <= extraBaths) { add(`bathroom_${bathN}`, "bathroom", p.beds >= 1 ? `Bath ${bathN}` : "Bath", 50); bathN++; }
  }
  if (p.beds === 1 && bathN === 2) { add("bathroom_2", "bathroom", p.baths >= 2 ? "Bath 2" : "Powder Room", p.baths >= 2 ? 50 : 30); bathN++; }
  if (p.beds === 0) add("bathroom_1", "bathroom", "Bath", 50);
  if (p.extra) add(p.extra, "office", p.extra === "gym" ? "Home Gym" : "Reading Room", 100);
  add("laundry", "laundry", p.mud ? "Mudroom & Laundry" : "Laundry", p.mud ? 60 : 40);
  // scale to the requested area (leave ~7% for the hall and walls)
  const sum = rooms.reduce((a, r) => a + r.target_sqft, 0);
  const k = (p.sqft * 0.93) / sum;
  for (const r of rooms) r.target_sqft = Math.round((r.target_sqft * k) / 5) * 5;
  return { requested_sqft: p.sqft, aspect_ratio: 1.6, rooms, notes: "" };
}

export function generate(prompt) {
  const p = parsePrompt(prompt);
  const prog = program(p); prog.notes = prompt;
  const T = Object.fromEntries(prog.rooms.map((r) => [r.id, r]));
  const priv = p.beds >= 1;
  // ---- zoning ----
  // east wing: bedrooms (+ gym/reading) along a hall; service strip (shared baths + laundry) sits in the
  // north row beside dining and opens onto the same hall; tiny homes skip the hall.
  const ids = prog.rooms.map((r) => r.id);
  let east = ids.filter((id) => /^bedroom_|^gym$|^reading$/.test(id));
  let service = ids.filter((id) => /^bathroom_[2-9]$|^laundry$/.test(id));
  const hasBedsEast = east.some((id) => id.startsWith("bedroom_"));
  if (!hasBedsEast) { east = [...east, ...service, ...(priv ? [] : ["office", "bathroom_1"].filter((id) => T[id]))]; service = []; }
  const hallW = hasBedsEast ? 4 : 0;
  const bedT = Math.max(...east.map((id) => T[id].target_sqft), 100);
  const Rw = hasBedsEast ? clamp(sn(Math.sqrt(bedT * 1.05)), 11, 13.5) : 9.5;
  const minH = (id) => (/bath|laundry/.test(id) ? 5.5 : 8.5);
  const Dt = sn(Math.sqrt(p.sqft / 1.75));
  let westSlot = priv && T.office ? "office" : null;
  let hs = () => east.map((id) => Math.max(minH(id), sn(T[id].target_sqft / Rw)));
  // too long on the east side: move the last bedroom into the west wing's entry slot
  if (priv && !westSlot && east.filter((i) => i.startsWith("bedroom_")).length >= 3 && hs().reduce((a, b) => a + b, 0) > Dt * 0.95) {
    westSlot = east.filter((i) => i.startsWith("bedroom_")).pop(); east = east.filter((i) => i !== westSlot);
  }
  let H = hs();
  let D = Math.max(sn(H.reduce((a, b) => a + b, 0)), sn(Dt * 0.85), priv ? 21 : 18);
  const fitStack = () => {
    let diff = sn(D - H.reduce((a, b) => a + b, 0));
    // lots of slack beside the bedrooms: give it back as a flex room instead of bloating a bedroom
    if (diff >= 7.5 && hasBedsEast && !east.includes("flex")) {
      T.flex = { id: "flex", type: "office", name: "Flex Room", target_sqft: Math.round(diff * Rw), adjacent_to: [] };
      prog.rooms.push(T.flex); east.push("flex"); H.push(sn(diff)); diff = 0;
    }
    const grow = east.map((id, i) => (id.startsWith("bedroom_") ? i : -1)).filter((i) => i >= 0);
    const targets = grow.length ? grow : [H.length - 1];
    let i = 0; while (Math.abs(diff) >= 0.5 && targets.length) { H[targets[i % targets.length]] += Math.sign(diff) * 0.5; diff -= Math.sign(diff) * 0.5; i++; }
  };
  if (east.length) fitStack();
  // ---- west wing ----
  let Wp = 0, Hb = 0, offH = 0, bathW = 0;
  if (priv) {
    Hb = 7;
    const offT = westSlot ? T[westSlot].target_sqft : 0;
    Wp = clamp(sn((T.primary_bedroom.target_sqft + offT) / (D - Hb)), 12, 20);
    offH = westSlot ? clamp(sn(offT / Wp), 7.5, 12) : 0;
    if (D - Hb - offH < 11.5) { D = sn(Hb + offH + 11.5); if (east.length) fitStack(); }
    bathW = clamp(sn(T.bathroom_1.target_sqft / Hb), 6, Wp - 4.5);
  }
  // ---- great room (+ service strip in its north row) ----
  const K = T.kitchen.target_sqft, Dn = T.dining?.target_sqft ?? 0, L = T.living.target_sqft + (T.sleep?.target_sqft ?? 0);
  const Sa = service.reduce((a, id) => a + T[id].target_sqft, 0);
  const Wg = Math.max(p.studio ? 16 : 20, sn((K + Dn + L + Sa) / D));
  const Hk = clamp(sn((K + Dn + Sa) / Wg), 10.5, Math.min(15, D - 10));
  const Sw = service.length ? clamp(sn(Sa / Hk), 5, 9) : 0;
  const kW = T.dining ? clamp(sn(K / Hk), 9.5, Wg - Sw - 8) : Wg - Sw;
  const hsS = service.map((id) => T[id].target_sqft);
  const sS = hsS.reduce((a, b) => a + b, 0) || 1;
  let acc = 0; const serviceH = hsS.map((t, i) => { const h = i === hsS.length - 1 ? Hk - acc : sn((t / sS) * Hk); acc += h; return h; });
  const stackIds = east, hs2 = H;
  // ---- assemble ----
  const xG = Wp, xH = xG + Wg, xS = xH + hallW, W = sn(xS + (stackIds.length ? Rw : 0));
  const rooms = [], doors = [], windows = [], open = []; const R0 = {};
  const put = (id, x, y, w, h, extra = {}) => { const r = { ...T[id], x: sn(x), y: sn(y), w: sn(w), h: sn(h), ...extra }; rooms.push(r); return r; };
  if (priv) {
    put("bathroom_1", 0, 0, bathW, Hb, { back: "north" });
    put("closet", bathW, 0, Wp - bathW, Hb);
    put("primary_bedroom", 0, Hb, Wp, D - Hb - offH, { back: "west" });
    if (westSlot) put(westSlot, 0, D - offH, Wp, offH, { back: "west" });
  }
  put("kitchen", xG, 0, kW, Hk, { back: "north" });
  if (T.dining) put("dining", xG + kW, 0, Wg - kW - Sw, Hk, { back: "north" });
  else if (!T.dining && Sw) R0.kitchenW = kW;
  { let yy = 0; service.forEach((id, i) => { put(id, xG + Wg - Sw, yy, Sw, serviceH[i], { back: "west" }); yy += serviceH[i]; }); }
  const sleepW = T.sleep ? clamp(sn(T.sleep.target_sqft / (D - Hk)), 9, Wg * 0.45) : 0;
  put("living", xG, Hk, Wg - sleepW, D - Hk, { back: "south" });
  if (T.sleep) put("sleep", xG + Wg - sleepW, Hk, sleepW, D - Hk, { back: "north" });
  if (hallW) rooms.push({ id: "hall", type: "hall", name: "Hall", target_sqft: hallW * D, adjacent_to: [], x: sn(xH), y: 0, w: hallW, h: sn(D) });
  let y = 0;
  stackIds.forEach((id, i) => { put(id, xS, y, Rw, hs2[i], { back: "east" }); y += hs2[i]; });
  const R = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const door = (a, b, x, yy, w = 3) => doors.push({ between: [a, b], x: sn(x), y: sn(yy), width_ft: w });
  // front door on the living room's south wall, off-centre so seating can face the media wall
  const ex = sn(xG + (Wg - sleepW) * (hallW ? 0.72 : sleepW ? 0.7 : 0.62));
  door("exterior", "living", ex, D);
  if (priv) {
    const bed = R.primary_bedroom;
    door("primary_bedroom", "living", Wp, sn(clamp(bed.y + bed.h - 3, Math.max(bed.y, Hk) + 2, bed.y + bed.h - 2)));
    door("bathroom_1", "primary_bedroom", bathW / 2, Hb, 2.67);
    door("closet", "primary_bedroom", bathW + (Wp - bathW) / 2, Hb, 2.67);
    if (westSlot) door(westSlot, "living", Wp, R[westSlot].y + R[westSlot].h / 2);
  }
  if (R.sleep) open.push(["living", "sleep"]);
  if (p.open) { if (R.dining) open.push(["kitchen", "dining"], ["dining", "living"]); open.push(["kitchen", "living"]); }
  else { if (R.dining) { door("kitchen", "dining", xG + kW, Hk / 2); door("dining", "living", R.dining.x + R.dining.w / 2, Hk); } else door("kitchen", "living", xG + kW / 2, Hk); }
  for (const id of service) door(id, "hall", xH, R[id].y + R[id].h / 2, 2.67);
  if (hallW) door("hall", "living", xH, sn(Math.max(Hk + 2.5, (Hk + D) / 2)));
  for (const id of stackIds) {
    const r = R[id], cy = r.y + r.h / 2;
    if (hallW) door(id, "hall", xS, cy, id.startsWith("bath") || id === "laundry" ? 2.67 : 3);
    else {
      // open onto the west neighbour sharing the most wall; door centred on that shared stretch
      const ov = (q) => Math.min(q.y + q.h, r.y + r.h) - Math.max(q.y, r.y);
      const nb = rooms.filter((q) => Math.abs(q.x + q.w - xS) < 0.01 && ov(q) >= 3).sort((a, b) => ov(b) - ov(a))[0] ?? R.living;
      door(id, nb.id, xS, (Math.max(nb.y, r.y) + Math.min(nb.y + nb.h, r.y + r.h)) / 2, 2.67);
    }
  }
  // ---- windows on exterior walls ----
  const extWalls = (r) => [
    r.y === 0 && "north", Math.abs(r.y + r.h - D) < 0.01 && "south", r.x === 0 && "west", Math.abs(r.x + r.w - W) < 0.01 && "east",
  ].filter(Boolean);
  const wallLen = (r, w) => (w === "north" || w === "south" ? r.w : r.h);
  const doorOn = (r, w) => doors.filter((d) => d.between.includes(r.id) && (
    (w === "north" && Math.abs(d.y - r.y) < 0.01) || (w === "south" && Math.abs(d.y - r.y - r.h) < 0.01) ||
    (w === "west" && Math.abs(d.x - r.x) < 0.01) || (w === "east" && Math.abs(d.x - r.x - r.w) < 0.01)))
    .map((d) => (w === "north" || w === "south" ? d.x - r.x : d.y - r.y));
  const addWin = (r, wall, frac, width) => {
    const Lw = wallLen(r, wall), w = Math.min(width, Lw - 2);
    if (w < 2) return;
    let c = Lw * frac;
    for (const du of doorOn(r, wall)) if (Math.abs(c - du) < w / 2 + 2) c = du + (c < du ? -1 : 1) * (w / 2 + 2.2);
    c = clamp(c, w / 2 + 0.5, Lw - w / 2 - 0.5);
    windows.push({ room: r.id, wall, offset_ft: sn(c - w / 2), width_ft: sn(w) });
  };
  for (const r of rooms) {
    const ext = extWalls(r); if (!ext.length || r.type === "hall" || r.type === "closet") continue;
    const longest = [...ext].sort((a, b) => wallLen(r, b) - wallLen(r, a))[0];
    if (r.type === "living") { addWin(r, "south", 0.22, 5); addWin(r, "south", 0.48, 5); continue; }
    // the bed's headboard sits on the room's back wall: put a pair of windows either side of it there
    if ((r.type === "primary_bedroom" || r.type === "bedroom") && r.back && ext.includes(r.back)) {
      addWin(r, r.back, 0.14, 2.5); addWin(r, r.back, 0.86, 2.5);
      const other = ext.find((w) => w !== r.back); if (other) addWin(r, other, 0.5, 4);
      continue;
    }
    if (r.type === "primary_bedroom") { addWin(r, "west", 0.5, 5); if (ext.includes("south")) addWin(r, "south", 0.5, 4); continue; }
    if (r.type === "kitchen") { addWin(r, "north", 0.42, 5); continue; }
    if (r.type === "bathroom") { addWin(r, longest, 0.5, 2.5); continue; }
    if (r.type === "laundry") { addWin(r, longest, 0.5, 2); continue; }
    addWin(r, longest, 0.5, r.type === "dining" ? 5 : 4);
  }
  const layout = {
    footprint: { width_ft: W, depth_ft: sn(D) }, entrance: { x: ex, y: sn(D) }, requested_sqft: p.sqft,
    rooms, doors, windows, open,
    checks: ["no_overlap_in_footprint", "all_rooms_reachable", "bedroom_exterior_wall", "public_bathroom", "kitchen_adjacent", "min_hall_and_door_width", "sizes_within_10pct"].map((rule) => ({ rule, pass: true, message: "" })),
  };
  prog.aspect_ratio = +(W / D).toFixed(2);
  const living = rooms.reduce((a, r) => a + r.w * r.h, 0);
  return {
    layout, program: prog, parsed: p,
    summary: {
      sqft: Math.round(living), rooms: rooms.length, W, D: sn(D),
      zoning: priv
        ? (() => {
            const eb = east.filter((i) => i.startsWith("bedroom_")).length, wb = westSlot?.startsWith("bedroom_") ? 1 : 0;
            const eastTxt = eb ? `${eb} more bedroom${eb > 1 ? "s" : ""} off a short hall to the east` : "service rooms to the east";
            return `Split plan: primary suite in the west wing${wb ? ` with ${R[westSlot].name} by the entry` : ""}, ${eastTxt}, open living in between.`;
          })()
        : "One open room for living and sleeping, with the bath and service rooms tucked along the east side.",
    },
  };
}
