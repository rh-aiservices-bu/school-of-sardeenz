// The Tin Never Changes · the cannery (world coordinates; the tin is 3600 × 2000, its top-left corner at 0,0)
// Colour legend, fixed for the whole film: red = inference traffic, sun (ochre) = control, teal = state.

const GROUND = 2120;
const BELT_Y = 700;                       // top of the order belt
const DESK_X = 620, GATE_X = 2300, HOP_X = 2540;
const BERTH = [520, 1180, 1840];          // berth centres on the packing floor
const FISH_Y = 1690;                      // centreline of a fish lying in its berth
const RAIL_Y = 1010;
const SHELF = { C: [2830, 1300], E: [3230, 1300], D: [2830, 1640], F: [3230, 1640] };
const N_ON = { 1: 10.4, 2: 11.4, 3: 19.6, 4: 27.6, 5: 36.6, 6: 40.9 };

const numOn = (n, t) => t >= N_ON[n];
const numPop = (n, t) => 1 + .35 * pulse(t, N_ON[n], .35);
const P = (x, y, en, real, n, t, o = {}) => plaque(x, y, en, real, { n, on: numOn(n, t), pop: numPop(n, t), ...o });

// ---------- cargo ----------
// an order capsule: x,y = bottom centre
function capsule(x, y, letter, o = {}) {
  out(`<g transform="translate(${f1(x)} ${f1(y)}) rotate(${o.rot || 0})">`);
  shadow(R(-58, -62, 116, 62, 31), 7, 6, o.sh || C.shade);
  shape(R(-58, -62, 116, 62, 31), C.red, 2.8);
  fillOnly(R(-40, -55, 60, 7, 3), C.redL);
  shape(E(22, -31, 21), C.cream, 2.4);
  txt(22, -19, letter, 34, { w: 900, anchor: 'middle' });
  line([[-38, -31], [-12, -31]], 3, C.cream); line([[-38, -20], [-20, -20]], 3, C.cream);
  out('</g>');
}
// a model: a sardine facing left, 360 × 104, cx,cy = its centre
function fish(cx, cy, letter, awake, o = {}) {
  out(`<g transform="translate(${f1(cx)} ${f1(cy)}) rotate(${f1(o.rot || 0)}) scale(${o.k || 1})">`);
  const body = 'M-180 0Q-150 -52 -40 -52Q80 -52 140 -14L180 -46L170 0L180 46L140 14Q80 52 -40 52Q-150 52 -180 0Z';
  if (o.sh !== false) shadow(body, 10, 9, o.shc || C.shade);
  shape('M-30 -50L10 -80L40 -44Z', awake ? C.teal : C.wallS, 2.6);
  shape(body, awake ? C.tealL : C.wallS, 3);
  out(`<path d="M-150 18Q-40 44 130 12" fill="none" stroke="${C.cream}" stroke-width="9" stroke-linecap="round" opacity=".8"/>`);
  out(`<path d="M-104 -40Q-86 0 -104 40" fill="none" stroke="${C.ink}" stroke-width="${f1(2.6 * KS)}" stroke-linecap="round"/>`);
  if (awake) { shape(E(-138, -10, 13), C.cream, 2.4); out(`<circle cx="-140" cy="-10" r="5.5" fill="${C.ink}"/>`); }
  else out(`<path d="M-151 -8Q-138 4 -125 -8" fill="none" stroke="${C.ink}" stroke-width="${f1(3 * KS)}" stroke-linecap="round"/>`);
  shape(E(24, 0, 31), C.cream, 2.6);
  txt(24, 17, letter, 48, { w: 900, anchor: 'middle' });
  out('</g>');
}
function zzz(x, y, t, ph = 0) {
  for (let i = 0; i < 3; i++) {
    const u = ((t * .45 + ph + i / 3) % 1), s = 26 + i * 0 + u * 22;
    out(`<g opacity="${f1((1 - u) * 100) / 100}">`); txt(x + u * 46, y - u * 86, 'Z', s, { w: 900 }); out('</g>');
  }
}
// token beads on a path: list of points, beads spaced d apart, moving at v px/s from time t0 to t1
function pathAt(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (s <= l) return [lerp(pts[i - 1][0], pts[i][0], s / l), lerp(pts[i - 1][1], pts[i][1], s / l)];
    s -= l;
  }
  return null;
}
function beads(pts, t, t0, t1, v, col, r = 9, gap = .16) {
  if (t < t0) return;
  for (let k = 0; t0 + k * gap < Math.min(t, t1); k++) {
    const p = pathAt(pts, (t - t0 - k * gap) * v); if (!p) continue;
    out(`<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="${r}" fill="${col}" stroke="${C.ink}" stroke-width="${f1(2.4 * KS)}"/>`);
  }
}
const RET_Y = 1890, RET_X = 104, RET_OUT = 768;          // token return pipe: under the packing floor, up the left wall, out through the hatch
const retFrom = bx => [[bx - 196, FISH_Y + 6], [bx - 262, FISH_Y + 6], [bx - 262, RET_Y], [RET_X, RET_Y], [RET_X, RET_OUT], [-900, RET_OUT]];

// ---------- order capsules (closed form) ----------
// each order: letter, the time it reaches the desk, the time it leaves, the time it reaches the gate / its place in the queue, when it is released
function orders(t) {
  const res = [];
  const ride = (tDesk) => DESK_X - (tDesk - t) * 220;
  const mk = (letter, tDesk, tLeave, tGate, slot, tGo) => {
    let x;
    if (t < tDesk) x = Math.max(ride(tDesk), lerp(ride(tDesk), DESK_X, eo(seg(t, tDesk - .5, tDesk))));
    else if (t < tLeave) x = DESK_X;
    else { const stop = GATE_X - 70 - slot * 128; x = lerp(DESK_X, stop, eio(seg(t, tLeave, tGate))); if (t >= tGo) x = lerp(stop, HOP_X, ei(seg(t, tGo, tGo + .45))); }
    if (x < -940) return;
    let y = BELT_Y - 12, rot = 0;
    if (t >= tGo + .45) { const u = seg(t, tGo + .45, tGo + .75); y += u * 150; rot = u * 80; if (u >= 1) return; }
    res.push({ letter, x, y, rot, stamp: pulse(t, tDesk + .15, .3) });
  };
  mk('A', 10.4, 12.6, 13.6, -.55, 13.6);            // the hot path: straight through, the gate is open
  mk('E', 17.4, 19.0, 20.2, 0, 46.7);               // parked
  mk('E', 21.4, 21.9, 23.0, 1, 47.0);
  mk('E', 22.3, 22.8, 23.9, 2, 47.3);
  mk('E', 23.2, 23.7, 24.8, 3, 47.6);
  return res;
}
const stopUp = t => ss(seg(t, 19.5, 19.9)) * (1 - ss(seg(t, 46.4, 46.7)));     // 1 = STOP raised, boom down
const bellPull = t => pulse(t, 22.0, .5);
const leverPull = t => ss(seg(t, 34.5, 34.9));
const lidOpen = t => eio(seg(t, 3.5, 5.6)) * (1 - eio(seg(t, 54.8, 57.0)));

// ---------- crane: trolley x, hook y, what it carries ----------
function crane(t) {
  const x = steps([[36.2, 3330], [37.6, BERTH[0]], [39.0, BERTH[0]], [40.6, SHELF.C[0]], [41.2, SHELF.C[0]], [41.7, SHELF.E[0]], [42.3, SHELF.E[0]], [43.6, BERTH[0]]], t);
  const up = 1130;
  const y = steps([[37.6, up], [38.2, FISH_Y - 70], [38.4, FISH_Y - 70], [39.0, up], [40.6, up], [41.2, SHELF.C[1] - 70], [41.3, SHELF.C[1] - 70], [41.6, up], [41.7, up], [42.0, SHELF.E[1] - 70], [42.1, SHELF.E[1] - 70], [42.4, up + 60], [43.6, up + 60], [44.2, FISH_Y - 70], [44.5, FISH_Y - 70], [45.0, up]], t);
  const carry = (t >= 38.3 && t < 41.25) ? 'C' : (t >= 42.05 && t < 44.3) ? 'E' : null;
  return { x, y, carry };
}
const awakeOf = (L, t) => L === 'A' || L === 'B' ? true : L === 'C' ? t < 38.2 : L === 'E' ? t >= 44.7 : false;
const boardOf = (L, t) => L === 'A' || L === 'B' ? true : L === 'C' ? t < 39.4 : L === 'E' ? t >= 46.0 : false;

// ---------- the tin and everything in it ----------
function drawWorld(t) {
  // ground
  fillOnly(R(-4000, GROUND, 12000, 600), C.paperD);
  out(`<path d="M-4000 ${GROUND}H8000" stroke="${C.ink}" stroke-width="${f1(3 * KS)}"/>`);
  // outside: order belt and token return pipe run off to the left; legs
  for (const x of [-700, -300]) trestle(x, BELT_Y + 20, GROUND, 60);
  for (const x of [520, 1800, 3080]) { shape(R(x - 60, 1996, 120, 124), C.blushD, 3); shape(R(x - 90, GROUND - 22, 180, 22), C.blush, 3); }
  // tin body
  shadow(R(0, 0, 3600, 2000, 200), 26, 20);
  shape(R(0, 0, 3600, 2000, 200), C.blush, 4);
  shape(R(56, 56, 3488, 1888, 150), C.ground, 3.4);
  // hatch in the left wall
  fillOnly(R(-3, 590, 62, 214), C.ground);
  line([[-2, 590], [58, 590]], 4); line([[-2, 804], [58, 804]], 4);

  const lo = lidOpen(t);
  if (lo > .001) interior(t);
  else { pipe([[-900, RET_OUT], [20, RET_OUT]], 24, C.red, C.redL); belt([-960, BELT_Y + 11], [10, BELT_Y + 11]); }
  lid(t, lo);
  for (const o of orders(t)) if (o.x < 30 || lo > .5) capsule(o.x, o.y, o.letter, { rot: o.rot });
  inspector(t);
}

function interior(t) {
  slab(56, 840, 3488, 70);
  pipe(null, 24, C.red, C.redL, { d: rpoly([[BERTH[2] - 262, RET_Y], [RET_X, RET_Y], [RET_X, RET_OUT], [-900, RET_OUT]], 26) });
  const cr = crane(t);
  // ---- pipes that run behind the rooms' contents ----
  // lower rooms
  const r5 = room(150, 930, 2380, 930, C.teal), r6 = room(2570, 930, 880, 930, C.sun);
  shape(R(2512, 990, 76, 560), C.wall, 0); line([[2516, 990], [2516, 1550]], 2.4); line([[2584, 990], [2584, 1550]], 2.4); line([[2516, 1550], [2584, 1550]], 2.4);
  // upper rooms
  room(150, 130, 880, 700, C.red); room(1070, 130, 780, 700, C.teal); room(1890, 130, 800, 700, C.red); room(2730, 130, 720, 700, C.sun);
  const FL = 794, FL2 = 1824;

  // teal: memory report, packing floor → board
  pipe([[1460, 1290], [1460, 505]], 26, C.teal, C.tealL);
  // red: token return, berths → out through the hatch
  for (const b of BERTH) pipe(null, 24, C.red, C.redL, { d: rpoly([[b - 196, FISH_Y + 6], [b - 262, FISH_Y + 6], [b - 262, RET_Y + 4]], 22) });
  // red: orders down from the hopper to the berths
  pipe(null, 40, C.red, C.redL, { d: rpoly([[HOP_X, 800], [HOP_X, 1510], [BERTH[0] - 140, 1510], [BERTH[0] - 140, 1600]], 30) });
  for (const b of BERTH.slice(1)) pipe([[b - 140, 1510], [b - 140, 1600]], 40, C.red, C.redL);
  flange(HOP_X, 925, 40, true); flange(HOP_X, 1300, 40, true);
  // ochre: bell cord (waiting room → foreman) and the command line (foreman → crane)
  pipe(null, 14, C.sun, C.sunL, { d: rpoly([[2360, 300], [2360, 172], [2830, 172], [2830, 215]], 16) });
  pipe(null, 26, C.sun, C.sunL, { d: rpoly([[3330, 700], [3330, RAIL_Y - 14]], 10) });

  // ---- ① dispatch desk ----
  P(180, 108, 'DISPATCH DESK', 'ROUTING PROXY', 1, t);
  {
    const st = orders(t).reduce((m, o) => Math.max(m, o.stamp), 0);
    // clerk behind the belt, pointing at the board when an order is on the desk
    const busy = (t > 10.4 && t < 12.6) || (t > 17.4 && t < 19.0);
    const a = busy ? lerp(40, 118, ss(seg(t % 60, t > 17 ? 17.7 : 10.8, t > 17 ? 18.1 : 11.3))) : 40;
    worker(830, FL, { s: 3, front: [a, busy ? -10 : 60], back: [-30, 40], cap: C.red });
    // stamp press over the belt
    shape(R(DESK_X - 70, 144, 140, 120, 4), C.wallD, 2.8);
    gauge(DESK_X, 204, 34, .3 + .5 * st);
    const py = 474 + st * 126;
    shape(R(DESK_X - 12, 264, 24, py - 264), C.wallS, 2.4);
    shape(R(DESK_X - 52, py, 104, 26, 5), C.red, 2.8);
    // in-tray lamp
    lamp(330, 144, 250, busy);
    txt(250, 420, 'ORDERS IN', 34, { w: 800, ls: 1 }); line([[250, 440], [470, 440]], 3);
    chev(520, 428, -90, C.ink, 1.3);
  }
  // ---- ② departures board ----
  P(1100, 108, 'DEPARTURES BOARD', 'ROUTING MAP · REDIS', 2, t);
  {
    const bx = 1150, by = 196, bw = 620, bh = 310;
    shadow(R(bx, by, bw, bh, 6), 12, 10, C.wallS);
    shape(R(bx, by, bw, bh, 6), C.ink, 3);
    'ABCDEF'.split('').forEach((L, i) => {
      const cx = bx + 22 + (i > 2 ? 300 : 0), cy = by + 24 + (i % 3) * 92;
      const on = boardOf(L, t), ft = L === 'C' ? 39.4 : L === 'E' ? 46.0 : -9;
      const sq = Math.abs(1 - 2 * seg(t, ft - .12, ft + .12));          // flap squash at the flip
      shape(E(cx + 34, cy + 36, 30), C.cream, 0); txt(cx + 34, cy + 52, L, 46, { w: 900, anchor: 'middle' });
      out(`<g transform="translate(0 ${f1(cy + 36)}) scale(1 ${f1(Math.max(.06, sq) * 100) / 100}) translate(0 ${f1(-cy - 36)})">`);
      shape(R(cx + 78, cy + 6, 192, 60, 4), on ? C.teal : C.wallS, 0);
      txt(cx + 174, cy + 50, on ? 'AWAKE' : 'ASLEEP', 40, { w: 800, anchor: 'middle', fill: on ? C.cream : C.ink, ls: 1.5 });
      line([[cx + 78, cy + 36], [cx + 270, cy + 36]], 1.4, C.ink, 'opacity=".35"');
      out('</g>');
      // pointer on the row being looked up
      const hot = (L === 'A' && t > 11.4 && t < 13.2) || (L === 'E' && t > 18.2 && t < 47.2);
      if (hot) { const k = 1 + .12 * Math.sin(t * 9); out(`<rect x="${cx - 4}" y="${cy - 2}" width="282" height="76" rx="8" fill="none" stroke="${C.sun}" stroke-width="${f1(7 * k)}"/>`); }
    });
    // board keeper on a ladder
    line([[1806, FL], [1786, 420]], 5); line([[1836, FL], [1816, 420]], 5);
    for (let y = 470; y < FL; y += 54) line([[1788 + (y - 420) * .053, y], [1818 + (y - 420) * .053, y]], 3.5);
    worker(1812, 560, { s: 2.4, flip: true, front: [150, 10], back: [20, 10], cap: C.teal });
  }
  // ---- ③ waiting room ----
  P(1920, 108, 'WAITING ROOM', 'CONNECTION PARKING', 3, t);
  {
    const su = stopUp(t), bp = bellPull(t);
    // bell cord handle
    const hy = 300 + 130 + bp * 46;
    line([[2360, 300], [2360, hy]], 5, C.sunD); shape(R(2342, hy, 36, 54, 10), C.sun, 2.6);
    // hopper
    shape(`M${HOP_X - 96} 650L${HOP_X + 96} 650L${HOP_X + 26} 800L${HOP_X - 26} 800Z`, C.red, 3);
    fillOnly(R(HOP_X - 80, 658, 150, 8, 3), C.redL);
    // gatekeeper: one hand on the STOP sign, the other pulls the cord
    const armA = lerp(60, 172, su);
    worker(2400, FL, {
      s: 3, cap: C.sun, back: [lerp(-30, -160, bp), lerp(30, -10, bp)], front: [armA, lerp(40, 0, su)],
      prop: h => {
        const a = lerp(40, 0, su) * Math.PI / 180;
        out(`<g transform="translate(${f1(h[0])} ${f1(h[1])}) rotate(${f1(lerp(70, 0, su))})">`);
        out(`<path d="M0 4V-30" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/>`);
        let d = ''; for (let i = 0; i < 8; i++) { const an = (i + .5) / 8 * Math.PI * 2; d += (i ? 'L' : 'M') + f1(Math.cos(an) * 17) + ' ' + f1(-46 + Math.sin(an) * 17); }
        out(`<path d="${d}Z" fill="${C.red}" stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round"/>`);
        out(`<text x="0" y="-41.6" font-family="BSD" font-weight="900" font-size="12.5" text-anchor="middle" fill="${C.cream}">STOP</text>`);
        out('</g>');
      },
    });
    // boom gate across the belt
    shape(R(GATE_X - 14, BELT_Y - 110, 28, FL - BELT_Y + 110), C.wallS, 2.6);
    out(`<g transform="translate(${GATE_X} ${BELT_Y - 96}) rotate(${f1(lerp(-78, 0, su))})">`);
    shape(R(-14, -9, 150, 18, 6), C.cream, 2.6); for (let i = 0; i < 3; i++) fillOnly(R(14 + i * 44, -7, 22, 14), C.red);
    out('</g>');
  }
  // the order belt (drawn over rooms ①–③)
  belt([-960, BELT_Y + 11], [GATE_X + 40, BELT_Y + 11]);
  for (const x of [330, 980, 1630, 2200]) trestle(x, BELT_Y + 24, FL, 34);

  // ---- ④ foreman ----
  P(2760, 108, 'FOREMAN', 'CONTROL PLANE', 4, t);
  {
    // bell
    const ring = pulse(t, 22.05, .9) * Math.sin(t * 40) * 16;
    out(`<g transform="translate(2830 215) rotate(${f1(ring)})">`);
    shape('M-34 62Q-34 6 0 6Q34 6 34 62Z', C.sun, 2.8); shape(E(0, 70, 9), C.ink, 0); out('</g>');
    // ledger gauge
    txt(2950, 356, 'VRAM LEDGER', 30, { w: 800, anchor: 'middle', ls: 1 });
    gauge(2950, 462, 84, .93);
    txt(2950, 586, 'FULL', 38, { w: 900, anchor: 'middle', fill: C.red, ls: 2 });
    // last-asked clocks: the wedge is the time since the last order
    txt(3245, 212, 'LAST ASKED', 30, { w: 800, anchor: 'middle', ls: 1 });
    [['A', .06], ['B', .3], ['C', .86]].forEach(([L, v], i) => {
      const cx = 3125 + i * 120, cy = 300, r = 46, a = v * Math.PI * 2 - Math.PI / 2;
      shape(E(cx, cy, r), C.cream, 2.8);
      out(`<path d="M${cx} ${cy}L${cx} ${cy - r + 6}A${r - 6} ${r - 6} 0 ${v > .5 ? 1 : 0} 1 ${f1(cx + Math.cos(a) * (r - 6))} ${f1(cy + Math.sin(a) * (r - 6))}Z" fill="${C.wallS}" stroke="${C.ink}" stroke-width="${f1(2 * KS)}" stroke-linejoin="round"/>`);
      out(`<circle cx="${cx}" cy="${cy}" r="4" fill="${C.ink}"/>`);
      txt(cx, cy + r + 44, L, 42, { w: 900, anchor: 'middle' });
      if (L === 'C' && t > 32.3) { const q = backE(seg(t, 32.3, 32.7)); out(`<circle cx="${cx}" cy="${cy + 16}" r="${f1(84 * q)}" fill="none" stroke="${C.sun}" stroke-width="9"/><circle cx="${cx}" cy="${cy + 16}" r="${f1(84 * q)}" fill="none" stroke="${C.ink}" stroke-width="${f1(2 * KS)}" stroke-dasharray="10 9"/>`); }
    });
    if (t > 32.6) { out(`<g opacity="${f1(seg(t, 32.6, 32.9))}">`); txt(3410, 470, 'LEAST RECENTLY USED', 30, { w: 800, anchor: 'end', ls: 1 }); line([[3365, 404], [3365, 436]], 3); out('</g>'); }
    // command lever
    const lv = leverPull(t);
    shape(R(3280, 690, 100, 104, 6), C.wallD, 2.8);
    out(`<g transform="translate(3330 730) rotate(${f1(lerp(-38, 38, lv))})">`); line([[0, 0], [0, -92]], 7); shape(E(0, -98, 15), C.sun, 2.8); out('</g>');
    // the foreman: reads the ledger, then points at clock C, then pulls the lever
    const pt = ss(seg(t, 31.9, 32.4)) * (1 - ss(seg(t, 34.0, 34.4)));
    worker(lerp(3080, 3250, ss(seg(t, 34.0, 34.5))), FL, { s: 3, cap: C.sun, coat: C.cream, front: [lerp(50, 150, pt) + lv * 40, lerp(40, 6, pt)], back: [-25, 30] });
  }

  // ---- ⑤ packing floor ----
  P(180, 884, 'PACKING FLOOR', 'GPU VRAM', 5, t, { size: 58, zs: 44 });
  // memory report meter
  shape(R(1400, 1230, 120, 90, 6), C.wallD, 2.8); gauge(1460, 1276, 30, .93);
  txt(1540, 1262, 'MEMORY', 26, { w: 800, ls: 1 }); txt(1540, 1294, 'REPORT', 26, { w: 800, ls: 1 });
  // spouts and berths
  const inBerth = ['C', 'B', 'A'];
  BERTH.forEach((bx, i) => {
    let L = inBerth[i]; if (i === 0) L = t < 38.3 ? 'C' : t >= 44.3 ? 'E' : null;
    shape(`M${bx - 164} 1600H${bx - 116}L${bx - 126} 1630H${bx - 154}Z`, C.red, 2.6);
    // cradle
    shape(R(bx - 230, FISH_Y + 56, 460, 24, 6), C.blush, 3);
    shape(`M${bx - 200} ${FISH_Y + 56}L${bx - 214} ${FISH_Y + 16}M${bx + 200} ${FISH_Y + 56}L${bx + 214} ${FISH_Y + 16}`, null, 4);
    for (const x of [bx - 170, bx + 170]) shape(R(x - 12, FISH_Y + 80, 24, FL2 - FISH_Y - 80), C.wallS, 2.6);
    txt(bx, FISH_Y + 122, 'BERTH ' + (i + 1), 30, { w: 800, anchor: 'middle', ls: 1.5 });
    // signal lamp
    const on = L && awakeOf(L, t);
    line([[bx + 250, FL2], [bx + 250, FISH_Y - 110]], 5);
    if (on) out(`<circle cx="${bx + 250}" cy="${FISH_Y - 128}" r="${f1(34 + 5 * Math.sin(t * 5 + i))}" fill="${C.tealL}" opacity=".45"/>`);
    shape(E(bx + 250, FISH_Y - 128, 20), on ? C.teal : C.wallS, 2.8);
    if (L) { fish(bx, FISH_Y, L, awakeOf(L, t), { shc: C.wallS }); if (!awakeOf(L, t)) zzz(bx - 150, FISH_Y - 70, t, i * .3); }
  });
  // ---- ⑥ pantry shelf ----
  P(2600, 884, 'PANTRY SHELF', 'HOST RAM', 6, t, { size: 58, zs: 44 });
  for (const y of [1362, 1702]) { shape(R(2630, y, 790, 22, 4), C.blush, 3); }
  for (const x of [2640, 3030, 3410]) line([[x, 1150], [x, FL2]], 6);
  for (const L of ['D', 'F', 'E', 'C']) {
    if (L === 'E' && t >= 42.05) continue; if (L === 'C' && t < 41.25) continue;
    fish(SHELF[L][0], SHELF[L][1], L, false, { shc: C.wallS }); zzz(SHELF[L][0] - 150, SHELF[L][1] - 66, t, L.charCodeAt(0) * .37);
  }
  // ---- crane ----
  shape(R(190, RAIL_Y - 12, 3220, 24, 4), C.wallS, 3);
  for (let x = 230; x < 3400; x += 90) out(`<circle cx="${x}" cy="${RAIL_Y}" r="3" fill="${C.ink}"/>`);
  line([[cr.x, RAIL_Y + 30], [cr.x, cr.y - 30]], 4);
  shape(R(cr.x - 70, RAIL_Y - 30, 140, 64, 8), C.sun, 3);
  for (const dx of [-40, 40]) shape(E(cr.x + dx, RAIL_Y - 30, 14), C.wallD, 2.6);
  if (cr.carry) fish(cr.x, cr.y + 70, cr.carry, false, { rot: Math.sin(t * 5) * 1.5, shc: C.wallS });
  shape(R(cr.x - 150, cr.y - 30, 300, 22, 6), C.sun, 3);
  for (const dx of [-120, 120]) shape(`M${cr.x + dx - 12} ${cr.y - 8}h24v${cr.carry ? 74 : 40}q-12 16 -24 0Z`, C.sunD, 2.6);

  // ---- things that flow ----
  // tokens streaming back: A answers at 15.0; E answers after it wakes
  beads(retFrom(BERTH[2]), t, 15.0, 19.5, 620, C.redL);
  beads(retFrom(BERTH[0]), t, 47.9, 56.0, 620, C.redL);
  // order tickets dropping out of the spouts
  for (const [bx, t0, n] of [[BERTH[2], 14.6, 1], [BERTH[0], 47.5, 4]]) for (let k = 0; k < n; k++) {
    const u = seg(t, t0 + k * .3, t0 + k * .3 + .35); if (u > 0 && u < 1) shape(R(bx - 152, 1630 + u * 40, 24, 16, 3), C.red, 2);
  }
  // pulses: the bell (ochre), the command (ochre), the report (teal)
  const pulseOn = (pts, t0, v, col) => { const p = pathAt(pts, (t - t0) * v); if (t >= t0 && p) { shape(E(p[0], p[1], 15), col, 3); } };
  pulseOn([[2360, 300], [2360, 172], [2830, 172], [2830, 215]], 22.0, 1500, C.sunL);
  pulseOn([[3330, 760], [3330, RAIL_Y]], 34.9, 500, C.sunL);
  pulseOn([[1460, 1290], [1460, 505]], 45.1, 1000, C.tealL);
}

// ---------- the lid: body colour with the painted label; it rolls up on the key towards the right ----------
function lid(t, p) {
  const px = lerp(56, 3490, p), rr = lerp(34, 62, p);
  if (p < .999) {
    const id = 'lid' + (UID++);
    out(`<clipPath id="${id}"><rect x="${f1(px)}" y="0" width="${f1(3620 - px)}" height="2000"/></clipPath><g clip-path="url(#${id})">`);
    shape(R(56, 56, 3488, 1888, 150), C.blush, 3.4);
    out(`<path d="${R(96, 96, 3408, 1808, 116)}" fill="none" stroke="${C.blushD}" stroke-width="10"/>`);
    // label: six models, three places, one GPU
    const fx = 330, fy = 420;
    for (let i = 0; i < 6; i++) fish(fx + (i % 2) * 520 + 180, fy + Math.floor(i / 2) * 230, 'ABCDEF'[i], true, { k: 1.25, shc: C.blushD });
    shape(R(250, 1180, 1180, 500, 30), C.cream, 4);
    txt(840, 1380, '6 MODELS', 170, { w: 900, anchor: 'middle', ls: 4 });
    txt(840, 1590, '3 BERTHS', 170, { w: 900, anchor: 'middle', ls: 4, fill: C.red });
    txt(1640, 760, 'SARDEENZ', 420, { w: 900, ls: 10 });
    fillOnly(R(1640, 840, 1690, 22), C.red);
    txt(1640, 1050, 'THE VRAM CANNERY', 150, { w: 800, ls: 6 });
    txt(1640, 1560, 'NET CONTENTS: 1 GPU', 96, { fam: FONT.sans, w: 700 });
    out('</g>');
  }
  // the roll and its key
  shape(R(px - rr, 30, rr * 2, 1940, rr), C.blushD, 3.4);
  fillOnly(R(px - rr * .5, 70, rr * .3, 1860, 6), C.blushL);
  shape(R(px - 10, -170, 20, 210), C.wallS, 3);
  shape(E(px, -220, 64), C.sun, 3.4); shape(E(px, -220, 30), C.paper, 3);
}

// ---------- outside: the inspector (Kubernetes) and what he writes down ----------
function inspector(t) {
  const x = 3890;
  const tick = seg(t, 57.5, 57.9);
  worker(x, GROUND, { s: 6, cap: C.teal, coat: C.cream, front: [lerp(95, 120, pulse(t, 57.3, .7)), -40], back: [-40, 110] });
  txt(x, 1580, 'INSPECTOR', 60, { fam: FONT.sans, w: 700, anchor: 'middle', ls: 2 });
  txt(x, 1680, 'KUBERNETES', 104, { w: 900, anchor: 'middle', ls: 3 });
  // his sheet
  const sx = 3700, sy = 1100, sw = 400, sh = 360;
  shadow(R(sx, sy, sw, sh, 8), 12, 10);
  shape(R(sx, sy, sw, sh, 8), C.cream, 3.4);
  shape(R(sx + 140, sy - 22, 120, 44, 8), C.wallS, 3);
  txt(sx + 40, sy + 130, 'GPU × 1', 92, { w: 900, ls: 2 });
  txt(sx + 40, sy + 250, 'IN USE', 92, { w: 900, ls: 2 });
  shape(R(sx + 286, sy + 178, 78, 78, 6), C.wall, 3.4);
  if (tick > 0) out(`<path d="M${sx + 298} ${sy + 214}L${sx + 322} ${sy + 242}L${sx + 372} ${sy + 170}" fill="none" stroke="${C.red}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${f1(tick * 130)} 400"/>`);
  line([[sx + sw / 2, sy + sh], [sx + sw / 2, 1500]], 3);
}
