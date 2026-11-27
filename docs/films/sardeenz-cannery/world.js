// Every Gigabyte · the world (world coordinates; the cannery is a tin 3600 × 2000 with its top-left corner at 0,0;
// the "before" scene, two ordinary tins on a bench, stands on the same ground line to its left).
// Colour legend, fixed for the whole film: red = inference traffic, sun (ochre) = control, teal = state (awake).

const GROUND = 2120;
const BELT_Y = 700;
const DESK_X = 620, GATE_X = 2300, HOP_X = 2540;
const U = 44;                                   // pixels per gigabyte on the packing floor
const TRAY = [250, 1400];                       // left end of the two GPU trays
const FISH_Y = 1600, RAIL_Y = 1010, MAN_Y = 1440;
const RET_Y = 1890, RET_X = 104, RET_OUT = 768;
// the models: size in GB, species (gen = fish, emb = small striped fish, pred = prawn), where they live
const M = {
  A: { gb: 22, type: 'gen', kind: 'LLM', gpu: 0, at: 0 },
  P: { gb: 2, type: 'pred', kind: 'PREDICTIVE', gpu: 0, at: 22 },
  B: { gb: 12, type: 'gen', kind: 'LLM', gpu: 1, at: 0 },
  C: { gb: 8, type: 'gen', kind: 'LLM', gpu: 1, at: 12 },
  D: { gb: 8, type: 'gen', kind: 'LLM', gpu: 1, at: 12 },
  E: { gb: 4, type: 'emb', kind: 'EMBEDDING', gpu: 1, at: 20 },
};
const slotX = L => TRAY[M[L].gpu] + M[L].at * U;                 // left end of a model's slot
const slotC = L => [slotX(L) + M[L].gb * U / 2, FISH_Y];         // its centre
const RACK = { P: [2694, 1300], E: [2900, 1300], D: [2836, 1640], C: [3216, 1640] };
// the crane's jobs: [model, grab time, release time, from, to]
const JOBS = [['P', 24.8, 27.4, RACK.P, slotC('P')], ['E', 31.6, 34.2, RACK.E, slotC('E')], ['C', 52.0, 54.4, slotC('C'), RACK.C], ['D', 55.0, 57.4, RACK.D, slotC('D')]];
const N_ON = { 1: 24.2, 2: 24.8, 3: 40.4, 4: 40.8, 5: 48.6, 6: 54.4 };
const T_LID = [21.6, 23.6, 62.6, 64.7], T_TICK = 65.4;

const numOn = (n, t) => t >= N_ON[n];
const numPop = (n, t) => 1 + .35 * pulse(t, N_ON[n], .35);
const P = (x, y, en, real, n, t, o = {}) => plaque(x, y, en, real, { n, on: numOn(n, t), pop: numPop(n, t), ...o });

// ---------- creatures ----------
// x0 = left end of the slot, cy = centreline, len = slot length in px, h = body height; all face left
function creature(L, x0, cy, len, awake, o = {}) {
  const m = M[L], h = (o.h || 110) / 2, col = awake ? C.tealL : C.wallS, colD = awake ? C.teal : C.wallD, shc = o.shc || C.shade;
  out(`<g transform="translate(${f1(x0 + len / 2)} ${f1(cy)}) rotate(${f1(o.rot || 0)}) translate(${f1(-len / 2 + 5)} 0)">`);
  const W = len - 10, k = (o.h || 110) / 110;
  if (m.type === 'pred') {
    // a prawn: curled back, tail fan, feelers
    const s = W / 78;
    out(`<g transform="scale(${f1(s * 100) / 100})">`);
    const body = 'M4 14Q0 -40 40 -42Q78 -42 78 -2Q78 30 52 38L44 22Q58 16 58 -2Q56 -20 40 -20Q24 -20 24 14Z';
    shadow(body, 7, 6, shc);
    shape('M52 38L70 50L60 30ZM52 38L40 54L44 30Z', colD, 2.4);
    shape(body, col, 2.8);
    for (const d of ['M30 -40L34 -20', 'M48 -41L46 -20', 'M66 -30L54 -14', 'M77 -6L58 -2']) out(`<path d="${d}" stroke="${C.ink}" stroke-width="${f1(2 * KS)}" stroke-linecap="round"/>`);
    out(`<path d="M8 -20Q-14 -44 -4 -62M10 -24Q2 -50 16 -64" fill="none" stroke="${C.ink}" stroke-width="${f1(2.2 * KS)}" stroke-linecap="round"/>`);
    if (awake) out(`<circle cx="12" cy="-22" r="5" fill="${C.ink}"/>`); else out(`<path d="M6 -22q6 5 12 0" fill="none" stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round"/>`);
    out('</g>');
    shape(E(W / 2, -h - 34 * k, 23 * k), C.cream, 2.6); txt(W / 2, -h - 34 * k + 13 * k, L, 36 * k, { w: 900, anchor: 'middle' });
  } else {
    const tl = Math.min(60 * k, W * .2);
    const body = `M0 0Q${f1(W * .07)} ${-h} ${f1(W * .32)} ${-h}Q${f1(W * .74)} ${-h} ${f1(W - tl)} ${f1(-h * .26)}L${W} ${f1(-h * .86)}L${f1(W - 12 * k)} 0L${W} ${f1(h * .86)}L${f1(W - tl)} ${f1(h * .26)}Q${f1(W * .74)} ${h} ${f1(W * .32)} ${h}Q${f1(W * .07)} ${h} 0 0Z`;
    if (o.sh !== false) shadow(body, 10, 9, shc);
    const fx = W * .42; shape(`M${f1(fx - 40 * k)} ${f1(-h + 3)}L${f1(fx)} ${f1(-h - 30 * k)}L${f1(fx + 36 * k)} ${f1(-h + 6)}Z`, colD, 2.6);
    shape(body, col, 3);
    out(`<path d="M${f1(W * .08)} ${f1(h * .34)}Q${f1(W * .45)} ${f1(h * .86)} ${f1(W - tl - 8)} ${f1(h * .2)}" fill="none" stroke="${C.cream}" stroke-width="${f1(9 * k)}" stroke-linecap="round" opacity=".8"/>`);
    const gx = Math.min(78 * k, W * .24);
    out(`<path d="M${f1(gx)} ${f1(-h * .78)}Q${f1(gx + 18 * k)} 0 ${f1(gx)} ${f1(h * .78)}" fill="none" stroke="${C.ink}" stroke-width="${f1(2.6 * KS)}" stroke-linecap="round"/>`);
    if (m.type === 'emb') for (const u of [.5, .62, .74]) out(`<path d="M${f1(W * u)} ${f1(-h * .8)}L${f1(W * u - 10 * k)} ${f1(h * .7)}" stroke="${colD}" stroke-width="${f1(7 * k)}" stroke-linecap="round" opacity=".9"/>`);
    const ex = gx * .52, ey = -h * .22;
    if (awake) { shape(E(ex, ey, 12 * k), C.cream, 2.4); out(`<circle cx="${f1(ex - 2)}" cy="${f1(ey)}" r="${f1(5.2 * k)}" fill="${C.ink}"/>`); }
    else out(`<path d="M${f1(ex - 12 * k)} ${f1(ey)}Q${f1(ex)} ${f1(ey + 12 * k)} ${f1(ex + 12 * k)} ${f1(ey)}" fill="none" stroke="${C.ink}" stroke-width="${f1(3 * KS)}" stroke-linecap="round"/>`);
    const dx = m.type === 'emb' ? W * .34 : W * .52, r = (m.type === 'emb' ? 24 : 31) * k;
    shape(E(dx, 0, r), C.cream, 2.6); txt(dx, r * .52, L, r * 1.5, { w: 900, anchor: 'middle' });
  }
  out('</g>');
}
// the card under (or over) a model: what kind it is and how much memory it takes
function infoTag(xc, y, L, k = 1, o = {}) {
  if (ZL < .2) return;
  const m = M[L], s1 = 26 * k, s2 = 34 * k;
  const w = Math.max(tw(m.kind, s1, 700, FONT.sans), tw(m.gb + ' GB', s2, 900, FONT.en)) + 30 * k, h = 78 * k;
  shadow(R(xc - w / 2, y, w, h, 4), 6, 5, o.sh || C.wallS);
  shape(R(xc - w / 2, y, w, h, 4), C.cream, 2.6);
  txt(xc, y + 30 * k, m.kind, s1, { fam: FONT.sans, w: 700, anchor: 'middle', ls: .6 });
  txt(xc, y + 66 * k, m.gb + ' GB', s2, { w: 900, anchor: 'middle', ls: 1.2 });
}
// a GPU: a tray 24 GB long with a ruler under it. x0,cy = left end and centreline of what lies in it
function tray(x0, cy, u, label, used, o = {}) {
  const k = u / 44, h = 55 * k, w = 24 * u, by = cy + h + 6;
  shape(`M${x0 - 22 * k} ${cy - h - 26 * k}V${by + 22 * k}H${x0 + w + 22 * k}V${cy - h - 26 * k}H${x0 + w + 6 * k}V${by}H${x0 - 6 * k}V${cy - h - 26 * k}Z`, C.blush, 3);
  for (let g = 0; g <= 24; g += 2) {
    const x = x0 + g * u, big = g % 6 === 0;
    line([[x, by + 22 * k], [x, by + (big ? 42 : 32) * k]], big ? 3 : 2);
    if (big && o.nums !== false) txt(x, by + 68 * k, String(g), 24 * k, { fam: FONT.sans, w: 700, anchor: 'middle' });
  }
  if (o.sign) {
    const sw = 400, sx = x0 + w / 2 - sw / 2, sy = o.sign;
    line([[sx + 40, sy - 60], [sx + 40, sy]], 3); line([[sx + sw - 40, sy - 60], [sx + sw - 40, sy]], 3);
    shadow(R(sx, sy, sw, 66, 5), 7, 6, C.wallS); shape(R(sx, sy, sw, 66, 5), C.cream, 2.8);
    txt(sx + 22, sy + 48, label, 42, { w: 900, ls: 1.5 });
    txt(sx + sw - 22, sy + 48, `${used} / 24 GB`, 42, { w: 900, anchor: 'end', ls: 1.5, fill: used >= 24 ? C.teal : C.red });
  } else {
    if (o.labelRight) txt(x0 + w + 22 * k, cy - h - 44 * k, label, 38 * k, { w: 900, ls: 1.5, anchor: 'end' });
    else txt(x0 - 22 * k, cy - h - 44 * k, label, 38 * k, { w: 900, ls: 1.5 });
    if (used != null) txt(x0 + w + 22 * k, cy - h - 44 * k, `${used} / 24 GB`, 38 * k, { w: 900, anchor: 'end', ls: 1.5, fill: used >= 24 ? C.teal : C.red });
  }
}
// an empty stretch of a tray: dashed outline and hatching
function gap(x0, cy, len, h, col = C.red) {
  const id = 'gp' + (UID++);
  out(`<clipPath id="${id}"><rect x="${x0 + 4}" y="${cy - h}" width="${len - 8}" height="${2 * h}"/></clipPath><g clip-path="url(#${id})">`);
  for (let x = x0 - 2 * h; x < x0 + len; x += 26) out(`<path d="M${x} ${cy + h}L${x + 2 * h} ${cy - h}" stroke="${col}" stroke-width="5" opacity=".55"/>`);
  out('</g>');
  out(`<rect x="${x0 + 4}" y="${cy - h}" width="${len - 8}" height="${2 * h}" fill="none" stroke="${col}" stroke-width="${f1(4 * KS)}" stroke-dasharray="14 10"/>`);
}

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

function zzz(x, y, t, ph = 0) {
  for (let i = 0; i < 3; i++) {
    const u = ((t * .45 + ph + i / 3) % 1), s = 26 + i * 0 + u * 22;
    out(`<g opacity="${f1((1 - u) * 100) / 100}">`); txt(x + u * 46, y - u * 86, 'Z', s, { w: 900 }); out('</g>');
  }
}

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

const RET_TRUNK_X = () => slotX('E') + 24;
const drainOf = L => slotX(L) + 24;
const retFrom = L => [[drainOf(L), FISH_Y + 84], [drainOf(L), RET_Y], [RET_X, RET_Y], [RET_X, RET_OUT], [-900, RET_OUT]];

// ---------- order capsules (closed form) ----------
// [letter, reaches the desk, leaves it, reaches the gate (or its place in the queue), place, released]
const ORDERS = [['P', 40.4, 40.9, 42.1, -.55, 42.1], ['A', 41.6, 42.1, 43.3, -.55, 43.3], ['B', 42.8, 43.3, 44.5, -.55, 44.5],
  ['D', 47.4, 47.9, 48.9, 0, 58.4], ['D', 49.3, 49.7, 50.6, 1, 58.7], ['D', 50.2, 50.6, 51.5, 2, 59.0]];
function orders(t) {
  const res = [];
  for (const [letter, tDesk, tLeave, tGate, slot, tGo] of ORDERS) {
    const ride = DESK_X - (tDesk - t) * 220;
    let x;
    if (t < tDesk) x = Math.max(ride, lerp(ride, DESK_X, eo(seg(t, tDesk - .5, tDesk))));
    else if (t < tLeave) x = DESK_X;
    else { const stop = GATE_X - 70 - slot * 128; x = lerp(DESK_X, stop, eio(seg(t, tLeave, tGate))); if (t >= tGo) x = lerp(stop, HOP_X, ei(seg(t, tGo, tGo + .45))); }
    if (x < -940) continue;
    let y = BELT_Y - 12, rot = 0;
    if (t >= tGo + .45) { const u = seg(t, tGo + .45, tGo + .75); y += u * 150; rot = u * 80; if (u >= 1) continue; }
    res.push({ letter, x, y, rot, stamp: pulse(t, tDesk + .1, .3), atDesk: t >= tDesk && t < tLeave });
  }
  return res;
}
const stopUp = t => ss(seg(t, 48.5, 48.9)) * (1 - ss(seg(t, 58.1, 58.4)));
const bellPull = t => pulse(t, 49.6, .5);
const leverPull = t => ss(seg(t, 51.2, 51.6));
const lidOpen = t => eio(seg(t, T_LID[0], T_LID[1])) * (1 - eio(seg(t, T_LID[2], T_LID[3])));

// ---------- crane ----------
function crane(t) {
  const up = 1100, kx = [[0, 3330]], ky = [[0, up]];
  let carry = null;
  for (const [L, t0, t1, a, b] of JOBS) {
    kx.push([t0 - 1.5, kx[kx.length - 1][1]], [t0 - .6, a[0]], [t0 + .5, a[0]], [t1 - .7, b[0]]);
    ky.push([t0 - .6, up], [t0, a[1] - 70], [t0 + .1, a[1] - 70], [t0 + .5, up], [t1 - .7, up], [t1, b[1] - 70], [t1 + .1, b[1] - 70], [t1 + .5, up]);
    if (t >= t0 && t < t1) carry = L;
  }
  return { x: steps(kx, t), y: steps(ky, t), carry };
}
// where a model is: 'slot', 'rack', 'crane' or null (not in the building yet)
function whereIs(L, t) {
  const j = JOBS.filter(q => q[0] === L);
  if (!j.length) return 'slot';
  const [, t0, t1] = j[0], out_ = L === 'C';
  if (t >= t0 && t < t1) return 'crane';
  return (t < t0) === out_ ? 'slot' : 'rack';
}
const awakeOf = (L, t) => whereIs(L, t) === 'slot' && (L !== 'D' || t >= 57.8) && (L !== 'P' || t >= 27.8) && (L !== 'E' || t >= 34.6);
const boardOf = (L, t) => L === 'C' ? t < 54.6 : L === 'D' ? t >= 58.0 : L === 'P' || L === 'E' ? awakeOf(L, t) : true;
const usedOn = (g, t) => Object.keys(M).filter(L => M[L].gpu === g && whereIs(L, t) === 'slot').reduce((s, L) => s + M[L].gb, 0);

function drawWorld(t) {
  fillOnly(R(-9000, GROUND, 16000, 600), C.paperD);
  out(`<path d="M-9000 ${GROUND}H8000" stroke="${C.ink}" stroke-width="${f1(3 * KS)}"/>`);
  before(t);
  // legs, body
  for (const x of [520, 1800, 3080]) { shape(R(x - 60, 1996, 120, 124), C.blushD, 3); shape(R(x - 90, GROUND - 22, 180, 22), C.blush, 3); }
  for (const x of [-700, -300]) trestle(x, BELT_Y + 20, GROUND, 60);
  shadow(R(0, 0, 3600, 2000, 200), 26, 20);
  shape(R(0, 0, 3600, 2000, 200), C.blush, 4);
  shape(R(56, 56, 3488, 1888, 150), C.ground, 3.4);
  fillOnly(R(-3, 590, 62, 214), C.ground);
  line([[-2, 590], [58, 590]], 4); line([[-2, 804], [58, 804]], 4);
  const lo = lidOpen(t);
  if (lo > .001) interior(t);
  else { pipe([[-900, RET_OUT], [20, RET_OUT]], 24, C.red, C.redL); belt([-960, BELT_Y + 11], [10, BELT_Y + 11]); }
  lid(t, lo);
  for (const o of orders(t)) if (o.x < 30 || lo > .5) capsule(o.x, o.y, o.letter, { rot: o.rot });
  inspector(t);
}

// ---------- before Sardeenz: two ordinary tins on a bench, and a slicing press ----------
const B_U = 60, B_Y = 1640, T1 = -4500, T2 = -2640;
const SCHEMES = [[8.0, '4 × 6 GB', [6, 12, 18], false], [10.0, '2 × 12 GB', [12], false], [12.0, '1 × 24 GB', [], true]];
function before(t) {
  if (t > 22) return;
  const k = B_U / 44, h = 75;
  // bench
  shadow(R(-4760, 1800, 3830, 40, 6), 14, 10);
  shape(R(-4760, 1800, 3830, 40, 6), C.wallD, 3);
  for (const x of [-4600, -2850, -1090]) shape(R(x - 16, 1840, 32, GROUND - 1840), C.wallS, 3);
  // tin 1: the big model and the gap nobody can use
  tray(T1, B_Y, B_U, 'GPU 0', null);
  creature('A', T1, B_Y, 22 * B_U, true, { h: 150 });
  const blink = t < 7 ? .6 + .4 * Math.sin(t * 6) : 1;
  out(`<g opacity="${f1(blink)}">`); gap(T1 + 22 * B_U, B_Y, 2 * B_U, h); out('</g>');
  infoTag(T1 + 3 * B_U, 1400, 'A', 1.3, { sh: C.shade });
  if (t > 1.6) { out(`<g opacity="${f1(seg(t, 1.6, 1.9))}">`); callout(T1 + 23 * B_U, B_Y - h, 1290, 150, '2 GB EMPTY', 60); out('</g>'); }
  // slicing press
  const BY = 1080;
  plaque(T1 - 20, BY - 150, 'SLICING PRESS', 'FIXED SLICES · MIG', { size: 50, zs: 38 });
  for (const x of [T1 - 60, T1 + 24 * B_U + 60]) { shape(R(x - 14, BY, 28, 1800 - BY), C.wallS, 3); }
  shape(R(T1 - 90, BY - 30, 24 * B_U + 180, 60, 6), C.sun, 3);
  for (const [ts, name, cuts, fits] of SCHEMES) {
    if (t < ts || t >= ts + 2 && !fits) continue;
    const dn = ss(seg(t, ts + .4, ts + .8)) * (1 - (fits ? 0 : ss(seg(t, ts + 1.5, ts + 1.9))));
    const sh = fits ? 0 : pulse(t, ts + .8, .5) * Math.sin(t * 60) * 7;
    for (const g of [0, ...cuts, 24]) {
      const x = T1 + g * B_U + sh, edge = g === 0 || g === 24;
      const y1 = lerp(BY + 60, edge || fits ? B_Y + h : B_Y - h - 6, dn);
      if (edge && !fits) continue;
      shape(R(x - 7, BY + 30, 14, y1 - BY - 30, 3), C.sunD, 2.6);
    }
    // the scheme card on the beam, and its verdict
    const cw = 420, cx = T1 + 12 * B_U - cw / 2;
    shape(R(cx, BY - 46, cw, 92, 6), C.cream, 3);
    txt(cx + 26, BY + 22, name, 62, { w: 900, ls: 2 });
    if (t > ts + .85) {
      if (fits) out(`<path d="M${cx + cw - 96} ${BY}l26 28l48 -62" fill="none" stroke="${C.teal}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>`);
      else out(`<path d="M${cx + cw - 92} ${BY - 28}l56 56m0 -56l-56 56" fill="none" stroke="${C.red}" stroke-width="13" stroke-linecap="round"/>`);
    }
  }
  // tin 2: a whole GPU for the small model
  const hop = seg(t, 14.2, 15.4), px0 = lerp(T1 + 24 * B_U + 180, T2, eio(hop)), py = B_Y - Math.sin(hop * Math.PI) * 330 + (hop <= 0 ? 85 : hop >= 1 ? 0 : lerp(85, 0, hop));
  tray(T2, B_Y, B_U, 'GPU 1', null, { labelRight: true });
  if (t > 15.6) { out(`<g opacity="${f1(seg(t, 15.6, 15.9))}">`); gap(T2 + 2 * B_U, B_Y, 22 * B_U, h); txt(T2 + 13 * B_U, B_Y + 34, '22 GB EMPTY', 100, { w: 900, anchor: 'middle', ls: 4, fill: C.red }); out('</g>'); }
  creature('P', px0, py, 2 * B_U, true, { h: 150, rot: Math.sin(hop * Math.PI) * -14 });
  infoTag(px0 + B_U + 150 * ss(hop), py - 330, 'P', 1.3, { sh: C.shade });
}

// ---------- inside the cannery ----------
function interior(t) {
  slab(56, 840, 3488, 70);
  const cr = crane(t), FL = 794, FL2 = 1824, os = orders(t);
  // token return: under the packing floor, up the left wall, out through the hatch
  pipe(null, 24, C.red, C.redL, { d: rpoly([[RET_TRUNK_X(), RET_Y], [RET_X, RET_Y], [RET_X, RET_OUT], [-900, RET_OUT]], 26) });
  room(150, 930, 2380, 930, C.teal); room(2570, 930, 880, 930, C.sun);
  shape(R(2512, 990, 76, 560), C.wall, 0); line([[2516, 990], [2516, 1550]], 2.4); line([[2584, 990], [2584, 1550]], 2.4); line([[2516, 1550], [2584, 1550]], 2.4);
  room(150, 130, 880, 700, C.red); room(1070, 130, 780, 700, C.teal); room(1890, 130, 800, 700, C.red); room(2730, 130, 720, 700, C.sun);
  // teal: memory report, packing floor → board;  ochre: bell cord and command line;  red: orders down to every model
  pipe(null, 26, C.teal, C.tealL, { d: rpoly([[1353, 1700], [1353, 876], [1460, 876], [1460, 505]], 20) });
  pipe(null, 40, C.red, C.redL, { d: rpoly([[HOP_X, 800], [HOP_X, MAN_Y], [slotX('A') + 60, MAN_Y], [slotX('A') + 60, 1500]], 30) });
  for (const L of ['P', 'B', 'C', 'E']) pipe([[slotX(L) + (L === 'P' ? 44 : 60), MAN_Y], [slotX(L) + (L === 'P' ? 44 : 60), 1500]], 40, C.red, C.redL);
  flange(HOP_X, 925, 40, true);
  pipe(null, 14, C.sun, C.sunL, { d: rpoly([[2360, 300], [2360, 172], [2830, 172], [2830, 215]], 16) });
  pipe(null, 26, C.sun, C.sunL, { d: rpoly([[3330, 700], [3330, RAIL_Y - 14]], 10) });

  // ---- ③ dispatch desk ----
  P(180, 108, 'DISPATCH DESK', 'ROUTING PROXY', 3, t);
  {
    const st = os.reduce((m, o) => Math.max(m, o.stamp), 0), busy = os.some(o => o.atDesk);
    worker(830, FL, { s: 3, front: [busy ? 118 : 40, busy ? -10 : 60], back: [-30, 40], cap: C.red });
    shape(R(DESK_X - 70, 144, 140, 120, 4), C.wallD, 2.8);
    gauge(DESK_X, 204, 34, .3 + .5 * st);
    const py = 474 + st * 126;
    shape(R(DESK_X - 12, 264, 24, py - 264), C.wallS, 2.4);
    shape(R(DESK_X - 52, py, 104, 26, 5), C.red, 2.8);
    lamp(330, 144, 250, busy);
    txt(250, 420, 'ORDERS IN', 34, { w: 800, ls: 1 }); line([[250, 440], [470, 440]], 3);
    chev(520, 428, -90, C.ink, 1.3);
  }
  // ---- ④ departures board ----
  P(1100, 108, 'DEPARTURES BOARD', 'ROUTING MAP · REDIS', 4, t);
  {
    const bx = 1150, by = 196, bw = 620, bh = 310;
    shadow(R(bx, by, bw, bh, 6), 12, 10, C.wallS);
    shape(R(bx, by, bw, bh, 6), C.ink, 3);
    'ABCDEP'.split('').forEach((L, i) => {
      const cx = bx + 22 + (i > 2 ? 300 : 0), cy = by + 24 + (i % 3) * 92;
      const on = boardOf(L, t), ft = L === 'C' ? 54.6 : L === 'D' ? 58.0 : -9;
      const sq = Math.abs(1 - 2 * seg(t, ft - .12, ft + .12));
      shape(E(cx + 34, cy + 36, 30), C.cream, 0); txt(cx + 34, cy + 52, L, 46, { w: 900, anchor: 'middle' });
      out(`<g transform="translate(0 ${f1(cy + 36)}) scale(1 ${f1(Math.max(.06, sq) * 100) / 100}) translate(0 ${f1(-cy - 36)})">`);
      shape(R(cx + 78, cy + 6, 192, 60, 4), on ? C.teal : C.wallS, 0);
      txt(cx + 174, cy + 50, on ? 'AWAKE' : 'ASLEEP', 40, { w: 800, anchor: 'middle', fill: on ? C.cream : C.ink, ls: 1.5 });
      line([[cx + 78, cy + 36], [cx + 270, cy + 36]], 1.4, C.ink, 'opacity=".35"');
      out('</g>');
      const hot = ORDERS.some(([l, td, , , , tg]) => l === L && t > td + .3 && t < tg + .2);
      if (hot) { const k = 1 + .12 * Math.sin(t * 9); out(`<rect x="${cx - 4}" y="${cy - 2}" width="282" height="76" rx="8" fill="none" stroke="${C.sun}" stroke-width="${f1(7 * k)}"/>`); }
    });
    line([[1806, FL], [1786, 420]], 5); line([[1836, FL], [1816, 420]], 5);
    for (let y = 470; y < FL; y += 54) line([[1788 + (y - 420) * .053, y], [1818 + (y - 420) * .053, y]], 3.5);
    worker(1812, 560, { s: 2.4, flip: true, front: [150, 10], back: [20, 10], cap: C.teal });
  }
  // ---- ⑤ waiting room ----
  P(1920, 108, 'WAITING ROOM', 'CONNECTION PARKING', 5, t);
  {
    const su = stopUp(t), bp = bellPull(t);
    const hy = 300 + 130 + bp * 46;
    line([[2360, 300], [2360, hy]], 5, C.sunD); shape(R(2342, hy, 36, 54, 10), C.sun, 2.6);
    shape(`M${HOP_X - 96} 650L${HOP_X + 96} 650L${HOP_X + 26} 800L${HOP_X - 26} 800Z`, C.red, 3);
    fillOnly(R(HOP_X - 80, 658, 150, 8, 3), C.redL);
    worker(2400, FL, {
      s: 3, cap: C.sun, back: [lerp(-30, -160, bp), lerp(30, -10, bp)], front: [lerp(60, 172, su), lerp(40, 0, su)],
      prop: h => {
        if (su < .03) return;
        out(`<g transform="translate(${f1(h[0])} ${f1(h[1])}) rotate(${f1(lerp(70, 0, su))}) scale(${f1(su * 100) / 100})">`);
        out(`<path d="M0 4V-30" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/>`);
        let d = ''; for (let i = 0; i < 8; i++) { const an = (i + .5) / 8 * Math.PI * 2; d += (i ? 'L' : 'M') + f1(Math.cos(an) * 17) + ' ' + f1(-46 + Math.sin(an) * 17); }
        out(`<path d="${d}Z" fill="${C.red}" stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round"/>`);
        out(`<text x="0" y="-41.6" font-family="BSD" font-weight="900" font-size="12.5" text-anchor="middle" fill="${C.cream}">STOP</text>`);
        out('</g>');
      },
    });
    shape(R(GATE_X - 14, BELT_Y - 110, 28, FL - BELT_Y + 110), C.wallS, 2.6);
    out(`<g transform="translate(${GATE_X} ${BELT_Y - 96}) rotate(${f1(lerp(-78, 0, su))})">`);
    shape(R(-14, -9, 150, 18, 6), C.cream, 2.6); for (let i = 0; i < 3; i++) fillOnly(R(14 + i * 44, -7, 22, 14), C.red);
    out('</g>');
  }
  belt([-960, BELT_Y + 11], [GATE_X + 40, BELT_Y + 11]);
  for (const x of [330, 980, 1630, 2200]) trestle(x, BELT_Y + 24, FL, 34);

  // ---- ① foreman ----
  P(2760, 108, 'FOREMAN', 'CONTROL PLANE', 1, t);
  {
    const ring = pulse(t, 49.65, .9) * Math.sin(t * 40) * 16;
    out(`<g transform="translate(2830 215) rotate(${f1(ring)})">`);
    shape('M-34 62Q-34 6 0 6Q34 6 34 62Z', C.sun, 2.8); shape(E(0, 70, 9), C.ink, 0); out('</g>');
    txt(2942, 372, 'VRAM LEDGER', 30, { w: 800, anchor: 'middle', ls: 1 });
    [0, 1].forEach(g => {
      const cx = 2866 + g * 152, u = usedOn(g, t);
      gauge(cx, 462, 62, u / 24 * .93);
      txt(cx, 566, 'GPU ' + g, 28, { w: 800, anchor: 'middle', ls: 1 });
      txt(cx, 606, u + ' / 24', 34, { w: 900, anchor: 'middle', fill: u >= 24 ? C.teal : C.red });
    });
    txt(3285, 212, 'LAST ASKED', 30, { w: 800, anchor: 'middle', ls: 1 });
    [['B', .3], ['C', .86], ['E', .1]].forEach(([L, v], i) => {
      const cx = 3180 + i * 105, cy = 296, r = 42, a = v * Math.PI * 2 - Math.PI / 2;
      shape(E(cx, cy, r), C.cream, 2.8);
      out(`<path d="M${cx} ${cy}L${cx} ${cy - r + 6}A${r - 6} ${r - 6} 0 ${v > .5 ? 1 : 0} 1 ${f1(cx + Math.cos(a) * (r - 6))} ${f1(cy + Math.sin(a) * (r - 6))}Z" fill="${C.wallS}" stroke="${C.ink}" stroke-width="${f1(2 * KS)}" stroke-linejoin="round"/>`);
      out(`<circle cx="${cx}" cy="${cy}" r="4" fill="${C.ink}"/>`);
      txt(cx, cy + r + 42, L, 40, { w: 900, anchor: 'middle' });
      if (L === 'C' && t > 50.8 && t < 62) { const q = backE(seg(t, 50.8, 51.2)); out(`<circle cx="${cx}" cy="${cy + 14}" r="${f1(76 * q)}" fill="none" stroke="${C.sun}" stroke-width="9"/><circle cx="${cx}" cy="${cy + 14}" r="${f1(76 * q)}" fill="none" stroke="${C.ink}" stroke-width="${f1(2 * KS)}" stroke-dasharray="10 9"/>`); }
    });
    if (t > 51 && t < 62) { out(`<g opacity="${f1(seg(t, 51, 51.3))}">`); txt(3420, 462, 'LEAST RECENTLY USED', 28, { w: 800, anchor: 'end', ls: 1 }); line([[3285, 400], [3285, 430]], 3); out('</g>'); }
    const lv = Math.max(leverPull(t), pulse(t, 24.2, .8), pulse(t, 31.0, .8));
    shape(R(3280, 690, 100, 104, 6), C.wallD, 2.8);
    out(`<g transform="translate(3330 730) rotate(${f1(lerp(-38, 38, lv))})">`); line([[0, 0], [0, -92]], 7); shape(E(0, -98, 15), C.sun, 2.8); out('</g>');
    worker(3200, FL, { s: 3, cap: C.sun, coat: C.cream, front: [lerp(60, 110, lv), lerp(40, -30, lv)], back: [-25, 30] });
  }

  // ---- ② packing floor: two GPUs, packed by size ----
  P(180, 884, 'PACKING FLOOR', 'GPU VRAM', 2, t, { size: 58, zs: 44 });
  shape(R(1318, 1150, 70, 70, 6), C.wallD, 2.8); gauge(1353, 1185, 24, .9);
  [0, 1].forEach(g => {
    const x0 = TRAY[g], u = usedOn(g, t);
    tray(x0, FISH_Y, U, 'GPU ' + g, u, { sign: 1296 });
  });
  for (const grp of ['A', 'P', 'B', 'CD', 'E']) if (![...grp].some(L => whereIs(L, t) === 'slot')) gap(slotX(grp[0]), FISH_Y, M[grp[0]].gb * U, 50, C.red);
  for (const L of Object.keys(M)) {
    const sx = slotX(L) + (L === 'P' ? 44 : 60);
    if (L !== 'D') shape(`M${sx - 24} 1500H${sx + 24}L${sx + 14} 1530H${sx - 14}Z`, C.red, 2.6);
    if (L !== 'D') pipe([[drainOf(L), FISH_Y + 84], [drainOf(L), RET_Y + 4]], 20, C.red, C.redL);
    if (whereIs(L, t) !== 'slot') continue;
    creature(L, slotX(L), FISH_Y, M[L].gb * U, awakeOf(L, t), { shc: C.wallS });
    infoTag(slotX(L) + M[L].gb * U / 2 + (L === 'P' ? 20 : 0), 1736, L);
  }
  // ---- ⑥ pantry shelf ----
  P(2600, 884, 'PANTRY SHELF', 'HOST RAM', 6, t, { size: 58, zs: 44 });
  for (const y of [1362, 1702]) shape(R(2630, y, 790, 22, 4), C.blush, 3);
  for (const x of [2640, 3410]) line([[x, 1150], [x, FL2]], 6);
  txt(3396, 1200, 'TO DEPLOY', 30, { w: 800, anchor: 'end', ls: 1.5 }); txt(3396, 1470, 'ASLEEP', 30, { w: 800, anchor: 'end', ls: 1.5 });
  for (const L of Object.keys(RACK)) {
    if (whereIs(L, t) !== 'rack') continue;
    const len = M[L].gb * U;
    creature(L, RACK[L][0] - len / 2, RACK[L][1], len, false, { shc: C.wallS });
    if (L === 'C' || L === 'D') zzz(RACK[L][0] - len / 2 + 20, RACK[L][1] - 70, t, L.charCodeAt(0) * .37);
  }
  // ---- crane ----
  shape(R(190, RAIL_Y - 12, 3220, 24, 4), C.wallS, 3);
  for (let x = 230; x < 3400; x += 90) out(`<circle cx="${x}" cy="${RAIL_Y}" r="3" fill="${C.ink}"/>`);
  line([[cr.x, RAIL_Y + 30], [cr.x, cr.y - 30]], 4);
  shape(R(cr.x - 70, RAIL_Y - 30, 140, 64, 8), C.sun, 3);
  for (const dx of [-40, 40]) shape(E(cr.x + dx, RAIL_Y - 30, 14), C.wallD, 2.6);
  const cl = cr.carry ? M[cr.carry].gb * U : 200, hw = Math.max(70, cl / 2 - 30);
  if (cr.carry) creature(cr.carry, cr.x - cl / 2, cr.y + 70, cl, false, { rot: Math.sin(t * 5) * 1.2, shc: C.wallS });
  shape(R(cr.x - hw - 20, cr.y - 30, hw * 2 + 40, 22, 6), C.sun, 3);
  for (const dx of [-hw, hw]) shape(`M${cr.x + dx - 12} ${cr.y - 8}h24v${cr.carry ? 74 : 40}q-12 16 -24 0Z`, C.sunD, 2.6);

  // ---- things that flow ----
  for (const [L, , , , , tGo] of ORDERS) {
    const sx = slotX(L) + (L === 'P' ? 44 : 60), u = seg(t, tGo + 1.0, tGo + 1.35);
    if (u > 0 && u < 1) shape(R(sx - 12, 1530 + u * 30, 24, 16, 3), C.red, 2);
    const q = seg(t, tGo + 1.3, tGo + 2.0), c = slotC(L);
    if (q > 0 && q < 1) out(`<ellipse cx="${f1(c[0])}" cy="${c[1]}" rx="${f1(M[L].gb * U / 2 + 10 + q * 26)}" ry="${f1(70 + q * 26)}" fill="none" stroke="${C.red}" stroke-width="${f1(9 * (1 - q) + 2)}" opacity="${f1(1 - q)}"/>`);
  }
  for (const [L, t0] of [['P', 43.4], ['A', 44.6], ['B', 45.8], ['D', 59.8]]) beads(retFrom(L), t, t0, t0 + 4.5, 620, C.redL);
  const pulseOn = (pts, t0, v, col) => { const p = pathAt(pts, (t - t0) * v); if (t >= t0 && p) shape(E(p[0], p[1], 15), col, 3); };
  pulseOn([[2360, 300], [2360, 172], [2830, 172], [2830, 215]], 49.6, 1500, C.sunL);
  for (const t0 of [24.3, 31.1, 51.6]) pulseOn([[3330, 760], [3330, RAIL_Y]], t0, 500, C.sunL);
  pulseOn([[1353, 1700], [1353, 876], [1460, 876], [1460, 505]], 57.5, 1800, C.tealL);
}

// ---------- the lid: body colour with the painted label; it rolls up on its key towards the right ----------
function lid(t, p) {
  const px = lerp(56, 3490, p), rr = lerp(34, 62, p);
  if (p < .999) {
    const id = 'lid' + (UID++);
    out(`<clipPath id="${id}"><rect x="${f1(px)}" y="0" width="${f1(3620 - px)}" height="2000"/></clipPath><g clip-path="url(#${id})">`);
    shape(R(56, 56, 3488, 1888, 150), C.blush, 3.4);
    out(`<path d="${R(96, 96, 3408, 1808, 116)}" fill="none" stroke="${C.blushD}" stroke-width="10"/>`);
    // label: every size, every kind, one tin
    creature('A', 250, 400, 1180, true, { h: 200, shc: C.blushD });
    creature('B', 250, 700, 640, true, { h: 170, shc: C.blushD });
    creature('E', 930, 700, 270, true, { h: 150, shc: C.blushD });
    creature('P', 1250, 720, 170, true, { h: 150, shc: C.blushD });
    shape(R(250, 1180, 1180, 500, 30), C.cream, 4);
    txt(840, 1380, 'ANY SIZE', 170, { w: 900, anchor: 'middle', ls: 4 });
    txt(840, 1590, 'ANY KIND', 170, { w: 900, anchor: 'middle', ls: 4, fill: C.red });
    txt(1640, 760, 'SARDEENZ', 420, { w: 900, ls: 10 });
    fillOnly(R(1640, 840, 1690, 22), C.red);
    txt(1640, 1050, 'THE VRAM CANNERY', 150, { w: 800, ls: 6 });
    txt(1640, 1560, 'NO SLICES. PACKED BY SIZE.', 96, { fam: FONT.sans, w: 700 });
    out('</g>');
  }
  shape(R(px - rr, 30, rr * 2, 1940, rr), C.blushD, 3.4);
  fillOnly(R(px - rr * .5, 70, rr * .3, 1860, 6), C.blushL);
  shape(R(px - 10, -170, 20, 210), C.wallS, 3);
  shape(E(px, -220, 64), C.sun, 3.4); shape(E(px, -220, 30), C.paper, 3);
}

// ---------- outside: the inspector (Kubernetes) and what he writes down ----------
function inspector(t) {
  const x = 3890, tick = seg(t, T_TICK, T_TICK + .4);
  worker(x, GROUND, { s: 6, cap: C.teal, coat: C.cream, front: [lerp(95, 120, pulse(t, T_TICK - .2, .7)), -40], back: [-40, 110] });
  txt(x, 1580, 'INSPECTOR', 60, { fam: FONT.sans, w: 700, anchor: 'middle', ls: 2 });
  txt(x, 1680, 'KUBERNETES', 104, { w: 900, anchor: 'middle', ls: 3 });
  const sx = 3700, sy = 1100, sw = 400, sh = 360;
  shadow(R(sx, sy, sw, sh, 8), 12, 10);
  shape(R(sx, sy, sw, sh, 8), C.cream, 3.4);
  shape(R(sx + 140, sy - 22, 120, 44, 8), C.wallS, 3);
  txt(sx + 40, sy + 130, 'GPU × 2', 92, { w: 900, ls: 2 });
  txt(sx + 40, sy + 250, 'IN USE', 92, { w: 900, ls: 2 });
  shape(R(sx + 286, sy + 178, 78, 78, 6), C.wall, 3.4);
  if (tick > 0) out(`<path d="M${sx + 298} ${sy + 214}L${sx + 322} ${sy + 242}L${sx + 372} ${sy + 170}" fill="none" stroke="${C.red}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${f1(tick * 130)} 400"/>`);
  line([[sx + sw / 2, sy + sh], [sx + sw / 2, 1500]], 3);
}
