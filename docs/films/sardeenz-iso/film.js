// Twenty-Four Cubes · a Sardeenz explainer in the Isometric Infographic style (67 s, 1920×1080, 24 fps)
// One cube is one gigabyte. Everything is closed-form in t: any frame renders alone.
import { Iso, tri, pin, ring, haloText, FONT, C30, TAU, clamp, lerp, seg, ss, eo, eio, back, mix, hex } from './engine.js';

export const DUR = 67;
const INK = '#2E2522', BG = '#EFEAE0';
const HUE = { blue: '#2F6FE0', mint: '#35B592', amber: '#F0A732', coral: '#E8604C', graphite: '#4A4F5C', violet: '#7A5BD0', grey: '#B9B3A8', cube: '#DCD6C8', board: '#F9F5EC', stone: '#CFC8BA' };
const T = Object.fromEntries(Object.entries(HUE).map(([k, v]) => [k, tri(v)]));

// ---------- cues (seconds); the score and the mix read the same numbers through events() ----------
export const TL = {
  CUBE0: .5, ROW0: .9, ROW1: 3.3, A_LAND: 4.1, CORAL0: 4.9,
  A_LIFT: 8.2, W4: 8.9, BUMP1: 9.9, W4_OUT: 10.5, W2: 10.9, BUMP2: 11.9, W2_OUT: 12.4, A_LAND2: 13.7, LOCK: 14.3,
  P_IN: 16.6, P_BUMP: 17.6, GPU1_IN: 18.0, P_GO: 19.0, P_LAND: 20.3, IDLE0: 20.5, IDLE1: 22.3,
  TITLE: 23.4, UNLOCK: 25.4, P_HOP: 26.5, P_HOME: 27.6,
  B_LAND: 32.0, E_LAND: 33.0, P_PIN: 34.0, C_LAND: 35.0, FULL: 35.5,
  PULL: 40.0, REQ0: 40.6, PROXY_PIN: 41.2, CP_PIN: 42.0,
  DOWN: 48.0, RAM_PIN: 48.8, PARK: 51.3, LRU: 53.0, C_OUT: 53.6, C_DOWN: 55.8, D_UP: 55.9, D_HOME: 57.9, GO: 58.2,
  WIDE: 60.0, K8S: 60.8, CARD: 61.4,
};
export const SUBS = [
  { t0: .6, t1: 2.6, text: 'One GPU: 24 gigabytes.' }, { t0: 2.6, t1: 6.2, text: 'Your model takes 22. Two are left over.' },
  { t0: 8.0, t1: 10.0, text: "Slicing the GPU doesn't help." }, { t0: 10.0, t1: 14.4, text: 'Slices come in fixed sizes, and this model needs the whole card.' },
  { t0: 16.4, t1: 19.2, text: 'So a 2-gigabyte model gets a second GPU.' }, { t0: 19.2, t1: 21.8, text: '22 gigabytes sit idle.' },
  { t0: 23.4, t1: 25.3, text: "Sardeenz doesn't slice." }, { t0: 25.3, t1: 29.2, text: 'It tracks memory in software, and packs each GPU by size.' },
  { t0: 31.4, t1: 33.9, text: 'Generative, embedding, predictive.' }, { t0: 33.9, t1: 37.4, text: 'Different engines, different sizes, on the same GPUs.' },
  { t0: 40.4, t1: 43.9, text: 'One proxy routes every request to the right model.' },
  { t0: 48.4, t1: 52.3, text: 'More models than memory? Idle ones sleep in host RAM.' },
  { t0: 52.6, t1: 54.7, text: 'A request for a sleeping model waits,' }, { t0: 54.7, t1: 58.0, text: 'while the least recently used one is swapped out.' },
  { t0: 60.4, t1: 63.4, text: 'Kubernetes still sees two busy GPUs.' }, { t0: 63.6, t1: 66.7, text: 'Sardeenz: every gigabyte, working.' },
];

// ---------- the models: footprint is len × 2 cubes, so len × 2 gigabytes ----------
const G0 = [0, 0], G1 = [0, 5], RAM_Y = 12.4, UP = 2.6, BH = 1.1, CH = .6;
const M = {
  A: { len: 11, hue: 'blue', kind: 'GENERATIVE · LLM', gb: 22 },
  P: { len: 1, hue: 'amber', kind: 'PREDICTIVE', gb: 2 },
  B: { len: 6, hue: 'blue', kind: 'GENERATIVE · LLM', gb: 12 },
  C: { len: 4, hue: 'blue', kind: 'GENERATIVE · LLM', gb: 8 },
  E: { len: 2, hue: 'mint', kind: 'EMBEDDING', gb: 4 },
  D: { len: 4, hue: 'blue', kind: 'GENERATIVE · LLM', gb: 8 },
};
const key = (keys, t, ease = eio) => { if (t <= keys[0][0]) return keys[0][1]; for (let i = 0; i < keys.length - 1; i++) { const [a, va] = keys[i], [b, vb] = keys[i + 1]; if (t < b) return lerp(va, vb, ease(seg(t, a, b))); } return keys[keys.length - 1][1]; };
const drop = (t, t1, z1, h = 9, d = .5) => t < t1 - d ? null : lerp(z1 + h, z1, Math.pow(seg(t, t1 - d, t1), 2));
const squash = (t, t1) => t >= t1 && t < t1 + .35 ? Math.sin((t - t1) / .35 * Math.PI) * .18 : 0;
const gpu1Y = t => G1[1] + 16 * (1 - eo(seg(t, TL.GPU1_IN, TL.GPU1_IN + .9)));
const along = (pts, u) => { const L = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], (pts[i][2] || 0) - (pts[i - 1][2] || 0)); L.push(l); tot += l; } let s = clamp(u) * tot; for (let i = 1; i < pts.length; i++) { if (s <= L[i - 1] || i === pts.length - 1) { const f = L[i - 1] ? clamp(s / L[i - 1]) : 0; return pts[i - 1].map((v, j) => lerp(v, pts[i][j], f)); } s -= L[i - 1]; } return pts[pts.length - 1]; };

// where each model is at t: {x, y, z, grey 0..1, sq} or null
function pose(L, t) {
  if (L === 'A') {
    if (t < TL.A_LAND - .5) return null;
    let z = drop(t, TL.A_LAND, CH) ?? CH;
    if (t >= TL.A_LAND) z = key([[TL.A_LIFT, CH], [TL.W4, 3.6], [TL.BUMP1 - .3, 3.6], [TL.BUMP1, 2.34], [TL.BUMP1 + .5, 3.6], [TL.BUMP2 - .3, 3.6], [TL.BUMP2, 2.34], [TL.BUMP2 + .5, 3.6], [TL.A_LAND2 - .5, 3.6], [TL.A_LAND2, CH]], t, t > TL.A_LAND2 - .5 ? (u => u * u) : eio);
    return { x: 0, y: 0, z, grey: 0, sq: squash(t, TL.A_LAND) + squash(t, TL.A_LAND2), shake: (t > TL.BUMP1 && t < TL.BUMP1 + .3) || (t > TL.BUMP2 && t < TL.BUMP2 + .3) ? Math.sin(t * 70) * .05 : 0 };
  }
  if (L === 'P') {
    if (t < TL.P_IN - .1) return null;
    if (t < TL.P_GO) { const x = key([[TL.P_IN, 21], [TL.P_BUMP, 12.25], [TL.P_BUMP + .5, 13.2]], t, t < TL.P_BUMP ? eo : eio); return { x, y: .5, z: 0, grey: 0, sq: squash(t, TL.P_BUMP) * .8, w: 1, d: 1 }; }
    if (t < TL.P_HOP) { const p = along([[13.2, .5, 0], [13.2, 3.4, 0], [0, 3.4, 0], [0, 5, 0]], eio(seg(t, TL.P_GO, TL.P_LAND - .35))); const h = Math.sin(seg(t, TL.P_LAND - .35, TL.P_LAND) * Math.PI) * 1.2; return { x: p[0], y: p[1], z: lerp(0, CH, seg(t, TL.P_LAND - .35, TL.P_LAND)) + h, grey: 0, sq: squash(t, TL.P_LAND) }; }
    const u = eio(seg(t, TL.P_HOP, TL.P_HOME)); return { x: lerp(0, 11, u), y: lerp(5, 0, u), z: CH + Math.sin(u * Math.PI) * 3.2, grey: 0, sq: squash(t, TL.P_HOME) };
  }
  if (L === 'B' || L === 'E') { const tl = L === 'B' ? TL.B_LAND : TL.E_LAND, z = drop(t, tl, CH); return z == null ? null : { x: L === 'B' ? 0 : 10, y: 5, z, grey: 0, sq: squash(t, tl) }; }
  if (L === 'C') {
    const z0 = drop(t, TL.C_LAND, CH); if (z0 == null) return null;
    if (t < TL.C_OUT) return { x: 6, y: 5, z: z0, grey: 0, sq: squash(t, TL.C_LAND) };
    const u = eio(seg(t, TL.C_OUT + .5, TL.C_DOWN - .5));
    return { x: 6, y: lerp(5, RAM_Y, u), z: key([[TL.C_OUT, CH], [TL.C_OUT + .5, UP], [TL.C_DOWN - .5, UP], [TL.C_DOWN, -2]], t), grey: ss(seg(t, TL.C_OUT, TL.C_DOWN - .5)), sq: squash(t, TL.C_DOWN) };
  }
  if (L === 'D') {
    if (t < TL.PULL) return null;
    if (t < TL.D_UP) return { x: 1, y: RAM_Y, z: -2 - 9 * (1 - eo(seg(t, TL.PULL, TL.PULL + 1))), grey: 1, sq: 0 };
    const u = eio(seg(t, TL.D_UP + .45, TL.D_HOME - .5));
    return { x: lerp(1, 6, u), y: lerp(RAM_Y, 5, u), z: key([[TL.D_UP, -2], [TL.D_UP + .45, UP], [TL.D_HOME - .5, UP], [TL.D_HOME, CH]], t), grey: 1 - ss(seg(t, TL.D_HOME - .4, TL.D_HOME + .4)), sq: squash(t, TL.D_HOME) };
  }
}
// cube n of a GPU (n = column × 2 + row) pops in on an accelerating grid
const cubeT = n => n === 0 ? TL.CUBE0 : TL.ROW0 + (TL.ROW1 - TL.ROW0) * Math.pow((n - 1) / 22, .62);
const idleT = n => TL.IDLE0 + (TL.IDLE1 - TL.IDLE0) * (n / 21);

// ---------- requests: small parcels from the client, through the proxy gate, to a model ----------
const GATE_X = -3.6, LANE_Y = 3.5, REQ_V = 9;
const TARGETS = ['A', 'B', 'P', 'E', 'C', 'A', 'B', 'C', 'E', 'P', 'B', 'A'];
function targetXY(L) { const g1 = 'BCED'.includes(L), x = { A: 5.5, P: 11.5, B: 3, C: 8, E: 11, D: 8 }[L]; return [x, g1 ? 5 : 2]; }
function requests(t) {
  const res = [];
  for (let i = 0; ; i++) {
    const t0 = TL.REQ0 + i * .5; if (t0 > 60.2 || t0 > t) break;
    let L = TARGETS[i % TARGETS.length]; if (L === 'C' && t0 > TL.LRU - 2.5) L = t0 > TL.GO ? 'D' : 'B';
    const [tx, ty] = targetXY(L), p = along([[-14, LANE_Y], [tx, LANE_Y], [tx, ty]], 1), path = [[-14, LANE_Y], [tx, LANE_Y], [tx, ty]];
    const len = (tx + 14) + Math.abs(ty - LANE_Y), u = (t - t0) * REQ_V / len; if (u >= 1) continue;
    const q = along(path, u); res.push({ x: q[0], y: q[1], hue: M[L].hue, i });
  }
  // the one that has to wait: a request for sleeping model D
  const tp = TL.PARK - (GATE_X - 1 + 14) / REQ_V;
  if (t >= tp) {
    const [tx, ty] = targetXY('D'), stopX = GATE_X - 1;
    if (t < TL.GO) res.push({ x: Math.min(stopX, -14 + (t - tp) * REQ_V), y: LANE_Y, hue: 'blue', parked: t >= TL.PARK, hero: true });
    else { const len = (tx - stopX) + Math.abs(ty - LANE_Y), u = (t - TL.GO) * REQ_V / len; if (u < 1) { const q = along([[stopX, LANE_Y], [tx, LANE_Y], [tx, ty]], u); res.push({ x: q[0], y: q[1], hue: 'blue', hero: true }); } }
  }
  return res;
}

// ---------- camera: world centre + log zoom ----------
const CAM = [
  [0, .9, .5, .9, 120], [1.1, .9, .5, .9, 120], [3.5, 6, 1, .5, 88], [7.6, 6, 1, .8, 86], [8.8, 6.3, 1, 1.5, 82], [15.6, 6.3, 1, 1.5, 80],
  [17.6, 7, 2.2, .5, 62], [19.2, 6, 3.5, .5, 56], [22.6, 6, 3.6, .5, 57],
  [23.8, 6, 5, .3, 52], [39.8, 6, 5, .3, 54], [41.6, 5, 4, 0, 37], [47.8, 5, 4, 0, 38.5],
  [49.6, 5.6, 6.5, -.6, 37], [59.8, 5.6, 6.5, -.6, 38.5], [62.0, 4.6, 5.2, 0, 29.5], [67, 4.6, 5.2, 0, 30.2],
];
function camera(t) { const k = i => key(CAM.map(c => [c[0], i === 4 ? Math.log(c[4]) : c[i]]), t); return { x: k(1), y: k(2), z: k(3), k: Math.exp(k(4)) }; }

// ---------- drawing ----------
let TEXTS = [];
export const texts = () => TEXTS;
function note(id, text, x, y, w, h, pass) { const o = { id, text, x0: x, y0: y, x1: x + w, y1: y + h }; if (pass) o.pass = true; TEXTS.push(o); }
function lab(iso, id, x, y, z, a, o) {
  if (a <= 0) return; pin(iso, x, y, z, { ...o, a });
  if (a > .7 && (o.fade ?? 1) > .5) { const [sx, sy] = iso.P(x, y, z), dir = o.dir ?? 1, up = o.up ?? 130, len = o.len ?? 60, tx = sx + dir * (len + 12), w = Math.min(300, 15 * Math.max((o.title || '').length, ((o.num || '') + (o.unit || '')).length + 1)); const s = [o.title, o.num, o.unit].filter(Boolean).join(' '); note(id, s, dir > 0 ? tx : tx - w, sy - up - 36, w, 90, o.pass); }
}
const greyed = (hue, g) => g <= 0 ? T[hue] : tri(hex(mix(HUE[hue], HUE.grey, g)));

function tray(iso, g, oy, t, which) {
  const x0 = g[0];
  iso.box(x0 - .35, oy - .35, -.5, 12.7, 2.7, .5, T.graphite, { layer: .3 });
  for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++) {
    const n = i * 2 + j; let s = 1, hue = 'cube';
    if (which === 0) {
      const ct = cubeT(n); if (t < ct) continue; s = back(seg(t, ct, ct + .28), 2.4);
      if (i === 11 && t >= TL.CORAL0 + j * .15 && t < TL.P_HOME) { hue = 'coral'; s *= 1 + .25 * Math.sin(seg(t, TL.CORAL0 + j * .15, TL.CORAL0 + j * .15 + .3) * Math.PI); }
    } else if (i > 0) {
      const k = n - 2, it = idleT(k);
      if (t >= it && t < TL.P_HOP + .3) { hue = 'coral'; s *= 1 + .22 * Math.sin(seg(t, it, it + .25) * Math.PI); }
    }
    const e = (1 - s) * .5 + .04;
    iso.box(x0 + i + e, oy + j + e, 0, 1 - 2 * e, 1 - 2 * e, CH * Math.min(s, 1.15), T[hue], { layer: .6 });
  }
}
function block(iso, L, p) {
  const m = M[L], w = (p.w || m.len), d = p.d || 2, sq = p.sq || 0, e = .05 - sq * .25, t3 = greyed(m.hue, p.grey);
  const x = p.x + (p.shake || 0);
  iso.box(x + e, p.y + e, p.z, w - 2 * e, d - 2 * e, BH * (1 - sq), t3);
  // cube seams on the top, so a block still reads as gigabytes
  const zt = p.z + BH * (1 - sq) + .002;
  for (let i = 1; i < w; i++) iso.line3([[x + i, p.y + e, zt], [x + i, p.y + d - e, zt]], t3[1], 1.5, { depth: x + w / 2 + p.y + d / 2 + p.z + BH / 2 + .01 });
  if (w > 1) iso.line3([[x + e, p.y + 1, zt], [x + w - e, p.y + 1, zt]], t3[1], 1.5, { depth: x + w / 2 + p.y + d / 2 + p.z + BH / 2 + .01 });
  iso.text3(L, x + (w > 1 ? .28 : .22), p.y + d - e + .001, p.z + .22, { plane: 'xz', size: w > 1 ? .78 : .62, weight: 700, face: '#FFFFFF', tri: ['#FFFFFF', '#FFFFFF', '#FFFFFF'], depth: x + w / 2 + p.y + d / 2 + p.z + BH / 2 + .02 });
}
function mark(g, x, y, ok, a) {
  if (a <= 0) return; g.save(); g.translate(x, y); g.scale(back(a, 2.4), back(a, 2.4)); g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = ok ? HUE.mint : HUE.coral; g.beginPath();
  if (ok) { g.moveTo(-18, 2); g.lineTo(-5, 16); g.lineTo(20, -16); } else { g.moveTo(-15, -15); g.lineTo(15, 15); g.moveTo(15, -15); g.lineTo(-15, 15); } g.stroke(); g.restore();
}

function world(iso, t) {
  const oy1 = gpu1Y(t);
  // the board: a pale plinth, and one step down in front of it, host RAM
  iso.box(-7, -6, -1.9, 25, 17, 1.4, T.board, { layer: 0, cull: false });
  const ramZ = -9 * (1 - eo(seg(t, TL.PULL, TL.PULL + 1)));
  if (t > TL.PULL) iso.box(-1, 11, -3 + ramZ, 14, 4.6, 1, T.stone, { layer: 0, cull: false });
  // GPUs
  tray(iso, G0, 0, t, 0);
  if (t > TL.GPU1_IN - .05) tray(iso, G1, oy1, t, 1);
  // slice walls
  for (const [cuts, t0, t1] of [[[3, 6, 9], TL.W4, TL.W4_OUT], [[6], TL.W2, TL.W2_OUT]]) {
    const a = eo(seg(t, t0, t0 + .45)) * (1 - eo(seg(t, t1, t1 + .35))); if (a <= 0) continue;
    for (const c of cuts) iso.box(c - .07, -.2, 0, .14, 2.4, (CH + 1.7) * a, T.graphite);
  }
  // the lock plate on the two spare cubes
  if (t > TL.LOCK - .5 && t < TL.UNLOCK + .7) {
    const z = drop(t, TL.LOCK, CH, 6, .45) ?? CH, sl = eio(seg(t, TL.UNLOCK, TL.UNLOCK + .6));
    const x = 11.03 + sl * 5, y = .03 - sl * 0;
    if (sl < 1) { iso.box(x, y, z, .94, 1.94, .2, T.graphite); iso.line3([[x + .15, y + .2, z + .21], [x + .8, y + 1.75, z + .21]], HUE.coral, 4, { bias: 2 }); iso.line3([[x + .8, y + .2, z + .21], [x + .15, y + 1.75, z + .21]], HUE.coral, 4, { bias: 2 }); }
  }
  // models
  for (const L of Object.keys(M)) { const p = pose(L, t); if (!p) continue; if ('BCE'.includes(L) && t < TL.C_OUT) p.y = oy1; block(iso, L, p); }
  // route lines, drawn just ahead of what follows them
  const route = (pts, a, o = {}) => { if (a <= 0) return; const n = 24, q = []; for (let i = 0; i <= n * clamp(a); i++) q.push(along(pts, i / n).concat(0).slice(0, 3).map((v, j) => j === 2 ? (pts[0][2] ?? .01) : v)); if (q.length > 1) iso.line3(q, INK, 2, { dash: [7, 6], layer: .5, a: o.a ?? 1 }); };
  route([[21, .5], [12.4, .5]], seg(t, TL.P_IN - .5, TL.P_IN + .3), { a: 1 - seg(t, TL.P_GO, TL.P_GO + .4) });
  route([[13.2, .5], [13.2, 3.4], [0.5, 3.4], [0.5, 5]], seg(t, TL.P_GO - .5, TL.P_GO + .5), { a: 1 - seg(t, TL.P_LAND, TL.P_LAND + .5) });
  if (t > TL.REQ0 - .8) { const a = eo(seg(t, TL.REQ0 - .8, TL.REQ0 + .6)); route([[-14, LANE_Y], [12.6, LANE_Y]], a); for (const L of 'APBE') { const [x, y] = targetXY(L); route([[x, LANE_Y], [x, y]], seg(t, TL.REQ0, TL.REQ0 + 1.2)); } const [x, y] = targetXY('C'); route([[x, LANE_Y], [x, y]], seg(t, TL.REQ0, TL.REQ0 + 1.2)); }
  // the proxy gate and the control plane
  if (t > TL.PULL - .2) {
    const a = back(seg(t, TL.PULL, TL.PULL + .6), 1.6), h = 1.7 * a;
    iso.box(GATE_X - .4, LANE_Y - 1.2, 0, .8, .4, h, T.violet); iso.box(GATE_X - .4, LANE_Y + .8, 0, .8, .4, h, T.violet);
    iso.box(GATE_X - .5, LANE_Y - 1.3, h, 1, 2.6, .35 * a, T.violet, { bias: 1 });
    const b = back(seg(t, TL.PULL + .3, TL.PULL + .9), 1.6), pulse = 1 + .06 * Math.sin(seg(t, TL.LRU, TL.LRU + .5) * Math.PI);
    iso.box(13.6, -4.4, 0, 2.2, 2.2, 2.6 * b * pulse, T.violet); iso.box(14.1, -3.9, 2.6 * b * pulse, 1.2, 1.2, .7 * b, T.violet, { bias: 1 });
    iso.line3([[14.7, -2.2, .01], [14.7, -.9, .01], [12.9, -.9, .01]], HUE.violet, 2.5, { dash: [5, 5], layer: .5, a: b });
  }
  // requests
  for (const r of requests(t)) iso.box(r.x - .22, r.y - .22, 0, .44, .44, .44, T[r.hue]);
  // the title, standing on the front edge of the board
  if (t > TL.TITLE - .1) { const a = back(seg(t, TL.TITLE, TL.TITLE + .7), 1.5); iso.text3('SARDEENZ', .2, 10.3, 0, { plane: 'xz', size: 1.75 * a, extrude: .45, weight: 700, track: 6, tri: T.violet, bias: 8.8 }); }
  // sleeping marks
  for (const L of 'CD') { const p = pose(L, t); if (p && p.grey > .9 && p.z < -1.9 && p.z > -2.1 && t > TL.DOWN) iso.bill(p.x + 3.4, p.y + .4, p.z + BH + .5, (g) => { g.font = `700 0.6px ${FONT}`; g.fillStyle = INK; for (let i = 0; i < 3; i++) { const u = (t * .5 + i / 3) % 1; g.globalAlpha = 1 - u; g.font = `700 ${.35 + u * .35}px ${FONT}`; g.fillText('z', u * .7, -u * 1.1); } }, { bias: 5 }); }
}

function backdrop(g, iso) {
  g.fillStyle = BG; g.fillRect(0, 0, 1920, 1080);
  // faint isometric dot lattice
  const k = iso.cam.k, step = k > 70 ? 1 : k > 40 ? 2 : 4; g.fillStyle = 'rgba(46,37,34,.13)';
  const [cx, cy] = [Math.round(iso.cam.x / step) * step, Math.round(iso.cam.y / step) * step], n = Math.ceil(1500 / (k * step));
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) { const [sx, sy] = iso.P(cx + i * step, cy + j * step, -1.9); if (sx < -5 || sx > 1925 || sy < -5 || sy > 1085) continue; g.fillRect(sx - 1.5, sy - 1.5, 3, 3); }
  // soft shadow under the board
  const c = [[-7, -6], [18, -6], [18, 15.6], [-1, 15.6], [-7, 11]].map(p => iso.P(p[0] + 1.2, p[1] + 1.2, -3.4));
  g.save(); g.filter = `blur(${Math.max(4, k * .5)}px)`; g.beginPath(); c.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.fillStyle = 'rgba(70,62,80,.22)'; g.fill(); g.restore();
}

function labels(g, iso, t) {
  const A = (t0, t1 = 999, d = 1.1) => seg(t, t0, t0 + d) * (t < t1 ? 1 : 0), F = t1 => 1 - seg(t, t1 - .35, t1);
  // act 1
  lab(iso, 'gb', 1, 0, CH, A(.7, 3.9, .6), { title: 'ONE CUBE', num: '1', unit: 'GB', dir: 1, up: 120, fade: F(3.9) });
  lab(iso, 'gpu0', 0, 2, 0, A(3.0, 7.9), { title: 'GPU 0', num: '24', unit: 'GB', dir: -1, up: 150, len: 40, fade: F(7.9) });
  lab(iso, 'a22', 3, 0, CH + BH, A(4.3, 7.9), { title: 'MODEL A · LLM', num: '22', unit: 'GB', dir: -1, up: 120, len: 50, fade: F(7.9) });
  lab(iso, 'un2', 12, 1, CH, A(TL.CORAL0 + .2, 8.3), { title: 'LEFT OVER', num: '2', unit: 'GB', dir: 1, up: 150, len: 40, dot: HUE.coral, fade: F(8.3) });
  // slicing schemes and their verdicts
  {
    const a = A(TL.W4 - .4, 15.9, .8), fd = F(15.9);
    lab(iso, 'mig', 12.3, -.2, 2.2, a, { title: 'FIXED SLICES · MIG', dir: 1, up: 200, len: 40, fade: fd });
    const [sx, sy] = iso.P(12.3, -.2, 2.2), tx = sx + 52, ty = sy - 200;
    [['4 × 6 GB', TL.W4, TL.BUMP1, 0], ['2 × 12 GB', TL.W2, TL.BUMP2, 0], ['1 × 24 GB', TL.W2_OUT + .5, TL.A_LAND2, 1]].forEach(([name, t0, tm, ok], i) => {
      const q = seg(t, t0, t0 + .3); if (q <= 0 || a <= 0) return;
      g.save(); g.globalAlpha = q * fd; haloText(g, name, tx, ty + 38 + i * 46, { font: `400 38px ${FONT}`, track: .5 }); mark(g, tx + 210, ty + 26 + i * 46, ok, seg(t, tm, tm + .3)); g.restore();
      if (q >= 1 && fd > .5) note('scheme' + i, name, tx, ty + 6 + i * 46, 180, 40);
    });
  }
  lab(iso, 'lock', 11.5, 2, CH + .2, A(TL.LOCK + .2, 18.7, .8), { title: 'LOCKED OUT', num: '2', unit: 'GB', dir: -1, up: -100, len: 40, dot: HUE.coral, fade: F(18.7) });
  lab(iso, 'p2', pose('P', t)?.x ?? 0, (pose('P', t)?.y ?? 0), (pose('P', t)?.z ?? 0) + BH, A(TL.P_IN, TL.P_LAND - .2, .5), { title: 'MODEL P · PREDICTIVE', num: '2', unit: 'GB', dir: 1, up: 110, len: 40, fade: F(TL.P_LAND - .2) });
  if (t >= TL.IDLE0 && t < TL.P_HOP) { const n = Math.min(22, 1 + Math.floor((t - TL.IDLE0) / (TL.IDLE1 - TL.IDLE0) * 21)); lab(iso, 'idle', 12, 7, 0, 1, { title: 'GPU 1 · IDLE', num: String(n), unit: 'GB', dir: 1, up: -56, len: 60, dot: HUE.coral, fade: F(TL.P_HOP), pass: n < 22 }); }
  // act 2
  lab(iso, 'g0full', 12, 1, CH + BH, A(TL.P_HOME + .2, 39.6), { title: 'GPU 0', num: '24 / 24', unit: 'GB', dir: 1, up: 150, len: 50, dot: HUE.mint, fade: F(39.6) });
  lab(iso, 'kb', 2, 5, CH + BH, A(TL.B_LAND + .15, 39.2, .8), { title: 'GENERATIVE', num: '12', unit: 'GB', dir: -1, up: 190, len: 60, dot: HUE.blue, fade: F(39.2) });
  lab(iso, 'ke', 12, 6, CH + BH, A(TL.E_LAND + .15, 39.2, .8), { title: 'EMBEDDING', num: '4', unit: 'GB', dir: 1, up: -56, len: 60, dot: HUE.mint, fade: F(39.2) });
  lab(iso, 'kp', 11.5, 0, CH + BH, A(TL.P_PIN, 39.2, .8), { title: 'PREDICTIVE', num: '2', unit: 'GB', dir: 1, up: 250, len: 50, dot: HUE.amber, fade: F(39.2) });
  lab(iso, 'g1full', 0, 7, 0, A(TL.FULL, 39.6, .8), { title: 'GPU 1', num: '24 / 24', unit: 'GB', dir: -1, up: 20, len: 80, dot: HUE.mint, fade: F(39.6) });
  // act 3
  const endA = A(TL.WIDE + .6);
  lab(iso, 'proxy', GATE_X, LANE_Y - 1, 2.05, A(TL.PROXY_PIN), { title: 'ROUTING PROXY', num: 'one way in', dir: 1, up: 150, len: 40, ns: 34, dot: HUE.violet });
  lab(iso, 'cp', 14.7, -3.3, 3.3, A(TL.CP_PIN), { title: 'CONTROL PLANE', num: t < TL.C_OUT || t > TL.D_HOME ? '48 / 48' : '40 / 48', unit: 'GB', dir: 1, up: 80, len: 40, dot: HUE.violet });
  lab(iso, 'ram', 0, 15, -2, A(TL.RAM_PIN), { title: 'HOST RAM', num: 'asleep', dir: -1, up: 40, len: 70, ns: 34, dot: HUE.grey });
  lab(iso, 'lru', 8, 5, CH, A(TL.LRU - .4, 56.4, .6), { title: 'LEAST RECENTLY USED', num: 'model C', dir: 1, up: 250, len: 40, ns: 34, fade: F(56.4) });
  lab(iso, 'k8s', 12.35, 6, -.5, endA, { title: 'KUBERNETES SEES', num: '2 GPUs', unit: 'ALLOCATED', dir: 1, up: -60, len: 80, dot: HUE.graphite });
  // tracking ring on the request that waits
  const hero = requests(t).find(r => r.hero);
  if (hero) { const [sx, sy] = iso.P(hero.x, hero.y, .25), a = hero.parked ? 1 : .0001 + seg(t, TL.PARK - .8, TL.PARK - .3) * (t < TL.GO ? 1 : 1 - seg(t, TL.GO + .6, TL.GO + 1.2)); if (a > .01) { ring(g, sx, sy, 34, clamp(a), t, hero.parked ? 'PARKED · WANTS D' : 'REQUEST FOR D', { ang: -2.3 }); } }
}
// the legend card, top left: grows into the end frame
function legend(g, t) {
  const a = eo(seg(t, 33.4, 34.0)); if (a <= 0) return;
  const end = eo(seg(t, TL.CARD, TL.CARD + .6)), rows = [['blue', 'GENERATIVE'], ['mint', 'EMBEDDING'], ['amber', 'PREDICTIVE']]; if (t > TL.RAM_PIN) rows.push(['grey', 'ASLEEP']);
  const x = 64, y = 60, w = lerp(300, 560, end), h = 58 + rows.length * 44 + end * 190;
  g.save(); g.globalAlpha = a; g.translate((1 - a) * -30, 0);
  g.beginPath(); g.roundRect(x, y, w, h, 10); g.fillStyle = 'rgba(251,247,238,.96)'; g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke();
  let yy = y + 44;
  if (end > 0) { g.save(); g.globalAlpha = a * end; haloText(g, 'SARDEENZ', x + 26, y + 62, { font: `700 44px ${FONT}`, track: 8, halo: false }); g.fillStyle = HUE.violet; g.fillRect(x + 26, y + 78, 250, 5); haloText(g, '6 MODELS · 2 GPUs', x + 26, y + 122, { font: `500 28px ${FONT}`, track: 2.5, halo: false }); haloText(g, '48 / 48 GB WORKING', x + 26, y + 160, { font: `600 28px ${FONT}`, track: 2.5, halo: false, color: HUE.mint }); g.restore(); yy += end * 150; note('endtitle', 'SARDEENZ 6 MODELS · 2 GPUs 48 / 48 GB WORKING', x, y, w, 170); }
  else haloText(g, 'ONE CUBE = 1 GB', x + 26, y + 40, { font: `600 22px ${FONT}`, track: 3, halo: false });
  rows.forEach(([hue, name], i) => {
    const cy = yy + 30 + i * 44, s = 15, ix = x + 44, P = (u, v, z) => [ix + (u - v) * C30 * s, cy + ((u + v) * .5 - z) * s];
    const f = (pts, c) => { g.beginPath(); pts.forEach((p, i) => { const q = P(...p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.closePath(); g.fillStyle = c; g.fill(); };
    f([[-.5, .5, -.5], [.5, .5, -.5], [.5, .5, .5], [-.5, .5, .5]], T[hue][1]); f([[.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5], [.5, -.5, .5]], T[hue][2]); f([[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]], T[hue][0]);
    haloText(g, name, x + 76, cy + 9, { font: `600 24px ${FONT}`, track: 3, halo: false });
  });
  if (end > 0) { g.globalAlpha = a * end; haloText(g, 'NOT TO SCALE', x + 26, y + h - 20, { font: `500 18px ${FONT}`, track: 3, halo: false, color: 'rgba(46,37,34,.6)' }); }
  g.restore();
}
function subtitle(g, text, a, fade) {
  if (a <= 0 || fade <= 0) return;
  g.save(); g.font = `500 42px ${FONT}`; const tw = g.measureText(text).width, pad = 28, icon = 46, w = tw + pad * 2 + icon, h = 76, x = 960 - w / 2, y = 1080 - 64 - h;
  g.globalAlpha = ss(fade); g.translate(0, (1 - ss(fade)) * 8);
  g.beginPath(); g.roundRect(x, y, w, h, 10); g.fillStyle = 'rgba(251,247,238,.97)'; g.fill();
  g.save(); g.beginPath(); g.rect(x - 4, y - 4, (w + 8) * eo(seg(a, 0, .35)), h + 8); g.clip(); g.beginPath(); g.roundRect(x, y, w, h, 10); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); g.restore();
  const ix = x + pad + 14, iy = y + h / 2 + 2, s = 13, P = (u, v, z) => [ix + (u - v) * C30 * s, iy + ((u + v) * .5 - z) * s];
  const f = (pts, c) => { g.beginPath(); pts.forEach((p, i) => { const q = P(...p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.closePath(); g.fillStyle = c; g.fill(); };
  f([[-.5, .5, -.5], [.5, .5, -.5], [.5, .5, .5], [-.5, .5, .5]], T.violet[1]); f([[.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5], [.5, -.5, .5]], T.violet[2]); f([[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]], T.violet[0]);
  g.save(); g.beginPath(); g.rect(x + pad + icon - 6, y, (tw + 12) * ss(seg(a, .2, .75)), h); g.clip();
  g.fillStyle = INK; g.textBaseline = 'middle'; g.fillText(text, x + pad + icon, y + h / 2 + 2); g.restore();
  g.restore();
}

export function render(g, t) {
  TEXTS = [];
  const iso = new Iso(g); iso.cam = camera(t);
  backdrop(g, iso);
  world(iso, t); iso.flush();
  labels(g, iso, t);
  legend(g, t);
  const sub = SUBS.find(s => t >= s.t0 && t < s.t1 + .3);
  if (sub) subtitle(g, sub.text, seg(t, sub.t0, sub.t0 + .6), 1 - seg(t, sub.t1, sub.t1 + .3));
}

// sound and cue events for the mixer
export function events() {
  const ev = [];
  for (let n = 0; n < 24; n++) ev.push({ t: +cubeT(n).toFixed(3), type: 'cube', n });
  for (let n = 0; n < 22; n++) ev.push({ t: +idleT(n).toFixed(3), type: 'idle', n });
  const one = (k, type, x = {}) => ev.push({ t: TL[k], type, ...x });
  one('A_LAND', 'land', { big: 1 }); one('CORAL0', 'coral'); one('A_LIFT', 'lift'); one('W4', 'walls'); one('BUMP1', 'bump'); one('W2', 'walls'); one('BUMP2', 'bump'); one('A_LAND2', 'land', { big: 1 }); one('LOCK', 'lock');
  one('P_IN', 'slide'); one('P_BUMP', 'bump', { small: 1 }); one('GPU1_IN', 'whoosh'); one('P_GO', 'slide'); one('P_LAND', 'land'); one('TITLE', 'title'); one('UNLOCK', 'unlock'); one('P_HOP', 'hop'); one('P_HOME', 'full');
  one('B_LAND', 'land', { big: 1 }); one('E_LAND', 'land'); one('P_PIN', 'pin'); one('C_LAND', 'land'); one('FULL', 'full'); one('PULL', 'whoosh'); one('PROXY_PIN', 'pin'); one('CP_PIN', 'pin'); one('DOWN', 'whoosh'); one('RAM_PIN', 'pin');
  one('PARK', 'park'); one('LRU', 'pin'); one('C_OUT', 'lift'); one('C_DOWN', 'land', { soft: 1 }); one('D_UP', 'lift'); one('D_HOME', 'land', { big: 1 }); one('GO', 'go'); one('WIDE', 'whoosh'); one('K8S', 'pin'); one('CARD', 'full');
  for (let i = 0; TL.REQ0 + i * .5 < 60; i++) ev.push({ t: +(TL.REQ0 + i * .5).toFixed(2), type: 'req' });
  return ev.sort((a, b) => a.t - b.t);
}
