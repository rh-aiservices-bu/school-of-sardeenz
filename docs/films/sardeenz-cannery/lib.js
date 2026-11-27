// Assembly-Line Diagram · shared drawing library (includes:
//   KS line-weight factor (ink lines thin by z^0.6 when the camera pulls out and thicken only slightly when it pushes in, so the picture always reads as one printed sheet), easing, keyframe interpolation)
// All vector: SVG generated in code. The print feel = each colour plate with its own misregistration (ink lines stay put) + a very faint paper texture.
// The palette uses semantic colour names; three colour schemes share the same drawing code (change PAL below to switch).

// Look B, "bold outline cartoon": the Sardeenz logo's colours (blue sardines, navy tin, cream), thick navy outlines,
// flat offset shadows. Semantic names are kept from the first version so the drawing code reads the same:
// blush = the tin's body, ground = inside the tin, wall = a room, red = inference traffic, sun = control, teal = state (awake).
const C = {
  paper: '#fffeda', paperD: '#f3efb4', shade: '#113f6f',
  ink: '#113f6f', ground: '#1f5a94', groundL: '#2a69a8', groundD: '#113f6f',
  wall: '#ffffff', wallD: '#dfe7ef', wallS: '#c4d3e2',
  blush: '#113f6f', blushD: '#0b2f55', blushL: '#3f79b5', blushK: '#0b2f55',
  red: '#ff5a6e', redD: '#d63a52', redL: '#ffb3bd',
  sun: '#ffcf40', sunD: '#e3a800', sunL: '#ffe89a',
  teal: '#4394e5', tealD: '#357abd', tealL: '#a9cdf3',
  cream: '#ffffff', skin: '#ffd9b8', lid: '#fffeda', pupil: '#333333',
  gen: '#4394e5', genD: '#357abd', emb: '#3cc7a6', embD: '#23967c', pred: '#ff9a4d', predD: '#d9722a', sleep: '#c4d6ea', sleepD: '#9db6d1',
};
const LW = 2.0;                       // every outline is this much heavier than in the printed look
const reg = () => [0, 0];

const S = []; let UID = 0; let KS = 1;   // KS: ink line-weight factor, set each frame from the camera distance
const out = s => S.push(s);
const tr = () => '';
const f1 = v => (Math.round(v * 10) / 10);

// ---------- Basic shapes ----------
const R = (x, y, w, h, r = 0) => r ? `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z` : `M${x} ${y}h${w}v${h}h${-w}Z`;
const E = (cx, cy, rx, ry = rx) => `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
const PL = pts => 'M' + pts.map(p => f1(p[0]) + ' ' + f1(p[1])).join('L');
function shape(d, fill, sw = 3, extra = '') {
  if (fill) out(`<path d="${d}" fill="${fill}"${tr(fill)} ${extra}/>`);
  if (sw) out(`<path d="${d}" fill="none" stroke="${C.ink}" stroke-width="${f1(sw * LW * KS * 100) / 100}" stroke-linejoin="round" stroke-linecap="round"/>`);
}
const fillOnly = (d, fill, extra = '') => out(`<path d="${d}" fill="${fill}"${tr(fill)} ${extra}/>`);
const line = (pts, w = 3, col = C.ink, extra = '') => out(`<path d="${PL(pts)}" fill="none" stroke="${col}" stroke-width="${f1(w * (col === C.ink ? 1.5 : 1) * KS * 100) / 100}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`);
// lines of geometric width (conveyor belts, piston rods etc.: scale with the camera, ignore KS)
const gline = (pts, w, col = C.ink, extra = '') => out(`<path d="${PL(pts)}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`);
// Holmes-style flat drop shadow: the same shape offset to the lower right, a single light colour
const shadow = (d, dx = 18, dy = 14) => out(`<path d="${d}" fill="${C.shade}" opacity=".2" transform="translate(${dx} ${dy})"/>`);

// ---------- Text ----------
const FONT = { en: 'BSD', sans: 'ARC', zh: 'ARC' };
const _cv = document.createElement('canvas').getContext('2d');
function tw(s, size, weight, fam) { _cv.font = `${weight} ${size}px ${fam}`; return _cv.measureText(s).width; }
function txt(x, y, s, size, o = {}) {
  if (typeof ZL !== 'undefined' && ZL < .2) return;   // small text is skipped when pulled out
  const fam = o.fam || FONT.en, w = o.w || 800, fill = o.fill || C.ink, anchor = o.anchor || 'start', ls = o.ls || 0;
  out(`<text x="${f1(x)}" y="${f1(y)}" font-family="${fam}" font-size="${size}" font-weight="${w}" fill="${fill}" text-anchor="${anchor}" dominant-baseline="alphabetic" letter-spacing="${ls}"${fill !== C.ink ? tr(fill) : ''}>${s}</text>`);
}

// ---------- Pipes: ink edge → colour → highlight strip (masked inside the pipe) ----------
function pipe(pts, w, col, colL, o = {}) {
  const d = o.d || PL(pts), id = 'pm' + (UID++), cap = o.cap || 'butt';
  out(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-300" y="-300" width="2600" height="1700"><path d="${d}" fill="none" stroke="#fff" stroke-width="${w - 3}" stroke-linejoin="round" stroke-linecap="${cap}"/></mask>`);
  out(`<path d="${d}" fill="none" stroke="${C.ink}" stroke-width="${f1(w + 11 * KS)}" stroke-linejoin="round" stroke-linecap="${cap}"/>`);
  out(`<g${tr(col)}><path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="${cap}"/>`);
  const k = w * 0.22;
  out(`<g mask="url(#${id})"><path d="${d}" fill="none" stroke="${colL}" stroke-width="${f1(w * 0.18)}" stroke-linejoin="round" transform="translate(${f1(-k)} ${f1(-k)})"/></g></g>`);
}
// rounded polyline → path d (each corner an arc of radius r)
function rpoly(pts, r = 30) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by), rr = Math.min(r, l1 / 2, l2 / 2);
    const p1 = [bx - (bx - ax) / l1 * rr, by - (by - ay) / l1 * rr], p2 = [bx + (cx - bx) / l2 * rr, by + (cy - by) / l2 * rr];
    d += `L${f1(p1[0])} ${f1(p1[1])}Q${bx} ${by} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  const L = pts[pts.length - 1]; return d + `L${L[0]} ${L[1]}`;
}
function flange(x, y, w, vertical, col = C.wallD) {
  const t = 12, L = w + 16;
  shape(vertical ? R(x - L / 2, y - t / 2, L, t, 2) : R(x - t / 2, y - L / 2, t, L, 2), col, 2.5);
}
function chev(x, y, rot, col = C.ink, k = 1, op = .85) { out(`<path d="M-10 -6L0 4L10 -6" transform="translate(${x} ${y}) rotate(${rot}) scale(${k})" fill="none" stroke="${col}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="${op}"/>`); }

// ---------- Kahn's number circles + room plaques (mainly English, plus one short Chinese line) ----------
function num(cx, cy, n, r = 22, on = true) {
  if (typeof ZL !== 'undefined' && ZL < .2) return;
  shape(E(cx, cy, r), on === false ? C.cream : C.sun, 2.8);
  txt(cx, cy + r * 0.42, n, r * 1.25, { fam: FONT.en, w: 900, anchor: 'middle' });
}
// plaque(x, y, 'CRUSHER', zh, {n, size}): zh = the short Chinese line; x,y = plaque top-left; returns the plaque width
function plaque(x, y, en, zh, o = {}) {
  if (typeof ZL !== 'undefined' && ZL < .2) return 0;
  const size = o.size || 34, zs = o.zs || 26, padX = size * 0.5;
  const we = tw(en, size, 800, FONT.en) + en.length * 1.2, wz = zh ? tw(zh, zs, 700, FONT.zh) : 0;
  const h = Math.max(size, zs) * 1.42, w = padX * 2 + we + (zh ? padX * 1.5 + wz : 0);
  let x0 = x;
  if (o.n) { const q = size / 34; num(x + 22 * q, y + h / 2, o.n, 22 * q * (o.pop || 1), o.on); x0 = x + 52 * q; }
  shadow(R(x0, y, w, h, 3), 6, 5, o.sh || C.shade);
  shape(R(x0, y, w, h, 3), o.bg || C.cream, 2.6);
  txt(x0 + padX, y + h / 2 + size * 0.36, en, size, { fam: FONT.en, w: 800, ls: 1.2 });
  if (zh) {
    const dx = x0 + padX + we + padX * 0.75;
    line([[dx, y + 9], [dx, y + h - 9]], 2, C.ink, 'opacity=".55"');
    txt(dx + padX * 0.75, y + h / 2 + zs * 0.36, zh, zs, { fam: FONT.zh, w: 700, ls: .6 });
  }
  return (x0 - x) + w;
}
// legend tag hanging on a pipe: colour swatch + text (the colour is the legend)
function tag(x, y, en, zh, col, o = {}) {
  if (typeof ZL !== 'undefined' && ZL < .2) return 0;
  const size = o.size || 30, zs = o.zs || 34, h = 52;
  const we = tw(en, size, 800, FONT.en) + en.length * 1.2, wz = tw(zh, zs, 700, FONT.zh);
  const w = 46 + we + 18 + wz + 18;
  shadow(R(x, y, w, h, 4), 6, 5);
  shape(R(x, y, w, h, 4), C.cream, 2.6);
  shape(R(x, y, 34, h, 4), col, 0); out(`<path d="M${x + 34} ${y}V${y + h}" stroke="${C.ink}" stroke-width="2.6"/>`);
  shape(R(x, y, w, h, 4), null, 2.6);
  txt(x + 46, y + h / 2 + size * 0.36, en, size, { fam: FONT.en, w: 800, ls: 1.2 });
  txt(x + 46 + we + 18, y + h / 2 + zs * 0.36, zh, zs, { fam: FONT.zh, w: 700 });
  return w;
}
// Holmes-style right-angle leader: solid dot → vertical → horizontal → text
function callout(px, py, ty, len, s, size = 40, o = {}) {
  out(`<circle cx="${px}" cy="${py}" r="6" fill="${C.ink}"/>`);
  const dir = o.left ? -1 : 1;
  line([[px, py], [px, ty], [px + dir * len, ty]], 3);
  txt(px + dir * (len + 14), ty + size * 0.34, s, size, { fam: FONT.en, w: 800, anchor: o.left ? 'end' : 'start', ls: 1 });
}

// ---------- Little worker: feet at (x,y), about 64·s tall. Angles 0=hanging down, 90=right, 180=up, -90=left ----------
function worker(x, y, o = {}) {
  if (typeof ZL !== 'undefined' && ZL < .2) return;
  const s = o.s || 1, coat = o.coat && o.coat !== C.cream ? o.coat : C.gen, lean = o.lean || 0, flip = o.flip ? -1 : 1, hat = o.cap || C.sun;
  out(`<g transform="translate(${x} ${y}) rotate(${lean}) scale(${s * flip} ${s})">`);
  const arm = (side, a, b = 0, L1 = 13, L2 = 12) => {
    const sx = side * 9, sy = -45, r = Math.PI / 180;
    const ex = sx + Math.sin(a * r) * L1, ey = sy + Math.cos(a * r) * L1;
    const hx = ex + Math.sin((a + b) * r) * L2, hy = ey + Math.cos((a + b) * r) * L2;
    out(`<path d="M${sx} ${sy}L${f1(ex)} ${f1(ey)}L${f1(hx)} ${f1(hy)}" fill="none" stroke="${C.ink}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`);
    out(`<path d="M${sx} ${sy}L${f1(ex)} ${f1(ey)}L${f1(hx)} ${f1(hy)}" fill="none" stroke="${coat}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`);
    out(`<circle cx="${f1(hx)}" cy="${f1(hy)}" r="4.2" fill="${C.skin}" stroke="${C.ink}" stroke-width="2.4"/>`);
    return [hx, hy];
  };
  if (o.back !== undefined) arm(-1, o.back[0], o.back[1] || 0);
  out(`<path d="M-5 -22L-6 -3M5 -22L6 -3" stroke="${C.ink}" stroke-width="8" stroke-linecap="round"/>`);
  out(`<path d="M-11 -1h9M2 -1h9" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>`);
  out(`<path d="M-11 -50Q0 -54 11 -50L13 -22Q0 -17 -13 -22Z" fill="${coat}" stroke="${C.ink}" stroke-width="2.8" stroke-linejoin="round"/>`);
  out(`<circle cx="0" cy="-64" r="12" fill="${C.skin}" stroke="${C.ink}" stroke-width="2.8"/>`);
  for (const ex of [-4.4, 4.8]) { out(`<ellipse cx="${ex}" cy="-64.5" rx="3.5" ry="3.8" fill="#fff" stroke="${C.ink}" stroke-width="1.2"/>`); out(`<circle cx="${ex + .9}" cy="-64" r="1.6" fill="${C.pupil}"/>`); }
  out(`<path d="M-3 -58Q.6 -55.4 4.2 -58.2" fill="none" stroke="${C.pupil}" stroke-width="1.4" stroke-linecap="round"/>`);
  out(`<path d="M-12.6 -67Q-12 -80.5 0 -80.5Q12 -80.5 12.6 -67Z" fill="${hat}" stroke="${C.ink}" stroke-width="2.6" stroke-linejoin="round"/>`);
  out(`<rect x="-15" y="-69.4" width="30" height="4.6" rx="2.3" fill="${hat}" stroke="${C.ink}" stroke-width="2.2"/>`);
  let hand = null;
  if (o.front !== undefined) hand = arm(1, o.front[0], o.front[1] || 0);
  if (o.prop) o.prop(hand);
  out('</g>');
}
// gear
function gear(cx, cy, r, teeth, ang, col = C.sun) {
  let d = ''; const n = teeth * 2;
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2 + ang * Math.PI / 180; const rr = i % 2 ? r : r * 0.82; d += (i ? 'L' : 'M') + f1(cx + Math.cos(a) * rr) + ' ' + f1(cy + Math.sin(a) * rr); }
  shape(d + 'Z', col, 2.6);
  shape(E(cx, cy, r * 0.42), C.wall, 2.4);
  shape(E(cx, cy, r * 0.12), C.ink, 0);
}
// gauge
function gauge(cx, cy, r, v) {
  shape(E(cx, cy, r), C.cream, 2.6);
  const a0 = -210, a1 = 30, a = (a0 + (a1 - a0) * v) * Math.PI / 180;
  out(`<path d="M${f1(cx + Math.cos(30 * Math.PI / 180) * r * .72)} ${f1(cy + Math.sin(30 * Math.PI / 180) * r * .72)}A${r * .72} ${r * .72} 0 0 0 ${f1(cx + Math.cos(-20 * Math.PI / 180) * r * .72)} ${f1(cy + Math.sin(-20 * Math.PI / 180) * r * .72)}" fill="none" stroke="${C.red}" stroke-width="${r * .18}"/>`);
  line([[cx, cy], [cx + Math.cos(a) * r * .7, cy + Math.sin(a) * r * .7]], 2.6);
  out(`<circle cx="${cx}" cy="${cy}" r="3" fill="${C.ink}"/>`);
}
// pendant lamp
function lamp(x, y0, y1, on = false) {
  line([[x, y0], [x, y1 - 12]], 2);
  if (on) out(`<path d="M${x - 16} ${y1}L${x - 90} ${y1 + 200}H${x + 90}L${x + 16} ${y1}Z" fill="${C.sunL}" opacity=".22"/>`);
  shape(`M${x - 18} ${y1}Q${x - 18} ${y1 - 14} ${x} ${y1 - 14}Q${x + 18} ${y1 - 14} ${x + 18} ${y1}Z`, C.sun, 2.4);
  shape(E(x, y1 + 2, 5), C.sunL, 1.8);
}
// floor slab: flesh-coloured slab + dark bottom edge + rivets
function slab(x, y, w, h) {
  shape(R(x, y, w, h), C.blush, 3);
  fillOnly(R(x + 2, y + h - 9, w - 4, 7), C.blushD);
  for (let xx = x + 16; xx < x + w; xx += 44) out(`<circle cx="${xx}" cy="${y + 10}" r="2.6" fill="${C.ink}"/>`);
}
// room: coloured frame + light wall + floor strip
function room(x, y, w, h, frame, o = {}) {
  shadow(R(x, y, w, h), 14, 10, o.sh || C.groundD);
  shape(R(x, y, w, h), frame, 3);
  shape(R(x + 14, y + 14, w - 28, h - 28), C.wall, 2.2);
  if (o.floor !== false) shape(R(x + 14, y + h - 14 - 22, w - 28, 22), C.wallD, 2.2);
  return { x: x + 14, y: y + 14, w: w - 28, h: h - 28, fl: y + h - 14 - 22 };
}
// conveyor (can tilt), rollers
function belt(a, b, k = 1) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  gline([a, b], 22 * k + 6 * KS, C.ink); gline([a, b], 18 * k, '#4A4D5C');
  for (let s = 8; s <= len - 6; s += 32 * k) { const t = s / len; out(`<circle cx="${f1(a[0] + (b[0] - a[0]) * t)}" cy="${f1(a[1] + (b[1] - a[1]) * t)}" r="${6.5 * k}" fill="${C.wallD}" stroke="${C.ink}" stroke-width="${f1(2 * KS)}"/>`); }
}
// A-frame stand
function trestle(x, ytop, yfl, spread = 26) {
  line([[x - spread, yfl], [x, ytop], [x + spread, yfl]], 5.5);
  line([[x - spread * .6, (ytop + yfl) / 2 + 8], [x + spread * .6, (ytop + yfl) / 2 + 8]], 3.5);
}

// ---------- Easing / interpolation (same as core/lib.js) ----------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const ss = t => { t = clamp(t); return t * t * (3 - 2 * t); };
const eio = t => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const eo = t => 1 - Math.pow(1 - clamp(t), 3);
const ei = t => Math.pow(clamp(t), 3);
const backE = (t, s = 1.8) => { t = clamp(t) - 1; return 1 + t * t * ((s + 1) * t + s); };
const spring = (t, k = 7, z = .35) => { t = Math.max(0, t); return 1 - Math.exp(-z * k * t) * Math.cos(k * Math.sqrt(1 - z * z) * t * 1.6); };
const hash = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const pulse = (t, a, d) => (t >= a && t < a + d) ? Math.sin(Math.PI * (t - a) / d) : 0;   // 0→1→0
function monotone(keys) {
  const n = keys.length, xs = keys.map(k => k[0]), ys = keys.map(k => k[1]);
  if (n === 1) return () => ys[0];
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], q = a * a + b * b;
    if (q > 9) { const k = 3 / Math.sqrt(q); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return t => {
    if (t <= xs[0]) return ys[0]; if (t >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (t > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], u = (t - xs[i]) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m[i + 1];
  };
}
// smooth segments: keys = [[t, v], ...], eio within each segment (holds on every keyframe)
function steps(keys, t, ease = eio) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [a, va] = keys[i], [b, vb] = keys[i + 1];
    if (t < b) return lerp(va, vb, ease(seg(t, a, b)));
  }
  return keys[keys.length - 1][1];
}
