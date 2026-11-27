// Every Gigabyte · camera, one frame, subtitles (68 s, 1920×1080, 24 fps)
// One world (the tin on its legs), one camera moving in the plane of the drawing.

let TL;
let ZL = 1;
window.DUR = 69.2;

// camera keys: [t, x, y, z]; eio between keys, so every key is a hold
const CAM = [
  [0, -3780, 1450, .76], [7, -3780, 1450, .80], [13.6, -3780, 1450, .82], [15.2, -2560, 1450, .70], [17.6, -2560, 1450, .71],
  [19.6, 1750, 1010, .40], [23.4, 1750, 1010, .40],
  [24.6, 1640, 1370, .66], [38.4, 1640, 1370, .69],
  [39.6, 1800, 1170, .48], [46.8, 1800, 1170, .50], [48.0, 1900, 480, 1.0], [50.2, 1900, 480, 1.0],
  [51.4, 1800, 1170, .48], [60.4, 1800, 1170, .495],
  [62.4, 1750, 1010, .395], [69.2, 1790, 1010, .405],
];
const WHIP = [[17.6, 19.6]];
function camera(t) {
  const k = i => steps(CAM.map(c => [c[0], i === 3 ? Math.log(c[3]) : c[i]]), t);
  return { x: k(1), y: k(2), z: Math.exp(k(3)) };
}
function toScreen(cam, x, y) { return [960 + (x - cam.x) * cam.z, 540 + (y - cam.y) * cam.z]; }

function world(t, cam) {
  ZL = cam.z;
  KS = cam.z < 1 ? Math.pow(cam.z, -0.6) : Math.pow(cam.z, -0.75);
  out(`<g transform="translate(960 540) scale(${cam.z.toFixed(5)}) translate(${(-cam.x).toFixed(2)} ${(-cam.y).toFixed(2)})">`);
  drawWorld(t);
  out('</g>');
}

function frame(t) {
  S.length = 0; UID = 0;
  out(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">`);
  out(`<rect width="1920" height="1080" fill="${C.paper}"/>`);
  const cam = camera(t);
  const fast = WHIP.some(([a, b]) => t > a && t < b);
  if (fast) {
    const dt = 1 / 48, a = camera(t - dt), b = camera(t + dt);
    const vx = (b.x - a.x) * cam.z / 2, vy = (b.y - a.y) * cam.z / 2;
    out(`<defs><filter id="mb" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${f1(Math.min(26, Math.abs(vx) * .35))} ${f1(Math.min(26, Math.abs(vy) * .35))}"/></filter></defs>`);
    out(`<g filter="url(#mb)">`); world(t, cam); out('</g>');
  } else world(t, cam);
  KS = 1; ZL = 1;
  subtitles(t);
  out('</svg>');
  return S.join('\n');
}

// work-ticket subtitles: cream ticket, ink frame, a stub with the current station number (a clock when there is none)
function subtitles(t) {
  for (const s of TL.subs) {
    if (t < s.t0 - .01 || t > s.t1 + .01) continue;
    const pin = eo(seg(t, s.t0, s.t0 + .2)), pout = ei(seg(t, s.t1 - .14, s.t1));
    const es = 34, we = tw(s.en, es, 600, FONT.sans) + s.en.length * .3;
    const stub = 72, pad = 26, w = stub + pad + we + pad + 4, h = 84;
    const x = s.right ? 1920 - 56 - w : 56, y = 1080 - 40 - h + (1 - pin) * 34 + pout * 40;
    out(`<g data-sub="1" opacity="${f1(Math.min(pin, 1 - pout) * 100) / 100}">`);
    out(`<path d="${R(x, y, w, h, 4)}" fill="${C.ground}" opacity=".28" transform="translate(7 6)"/>`);
    shape(R(x, y, w, h, 4), C.cream, 2.8);
    fillOnly(R(x + 2, y + 2, stub - 2, h - 4, 3), s.n ? C.sun : C.red);
    out(`<path d="M${x + stub} ${y + 8}V${y + h - 8}" stroke="${C.ink}" stroke-width="2.4" stroke-dasharray="5 6"/>`);
    shape(E(x + stub / 2, y + h / 2, 22), C.cream, 2.6);
    if (s.n) txt(x + stub / 2, y + h / 2 + 9.5, String(s.n), 28, { fam: FONT.en, w: 900, anchor: 'middle' });
    else { line([[x + stub / 2, y + h / 2], [x + stub / 2, y + h / 2 - 13]], 3); line([[x + stub / 2, y + h / 2], [x + stub / 2 + 10, y + h / 2 + 4]], 3); }
    shape(R(x, y, w, h, 4), null, 2.8);
    txt(x + stub + pad, y + h / 2 + 12, s.en, es, { fam: FONT.sans, w: 600 });
    out('</g>');
  }
}

function makeGrain() {
  const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
  const g = cv.getContext('2d'), im = g.createImageData(1920, 1080), d = im.data;
  let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < d.length; i += 4) { const v = 255 - rnd() * 34; d[i] = v; d[i + 1] = v - 2; d[i + 2] = v - 5; d[i + 3] = 255; }
  g.putImageData(im, 0, 0);
  g.globalAlpha = .05; g.strokeStyle = '#6B5A40';
  for (let i = 0; i < 900; i++) { const x = rnd() * 1920, y = rnd() * 1080, l = 20 + rnd() * 80; g.lineWidth = .6 + rnd(); g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y + (rnd() - .5) * 4); g.stroke(); }
  cv.id = 'grain'; document.body.appendChild(cv);
}

// sound and cue events for the mixer (core/render/events.mjs exports them)
function events() {
  const ev = [], E = (t, type, o = {}) => ev.push({ t: +t.toFixed(3), type, ...o });
  for (let t = .6; t < 6.8; t += 1.05) E(t, 'blink');
  E(1.6, 'callout');
  for (const [ts, , , fits] of SCHEMES) { E(ts + .4, 'press'); E(ts + .8, fits ? 'stamp' : 'clank'); if (!fits) { E(ts + .9, 'buzz'); E(ts + 1.5, 'press_up'); } }
  E(14.2, 'hop'); E(15.4, 'hollow'); E(15.6, 'empty');
  E(17.6, 'truck', { d: 2.0 });
  E(T_LID[0], 'roll', { d: T_LID[1] - T_LID[0] }); E(T_LID[2], 'roll', { d: T_LID[3] - T_LID[2] }); E(T_LID[3], 'lid_shut');
  for (const t of [24.2, 31.0, 51.2]) E(t, 'lever');
  for (const [L, t0, t1] of JOBS) { E(t0 - 1.5, 'chain', { d: .9 }); E(t0, 'grab'); E(t0 + .5, 'chain', { d: t1 - .7 - t0 - .5 }); E(t1, 'settle', { L }); }
  E(27.8, 'full', { n: 0 }); E(34.6, 'full', { n: 1 }); E(57.8, 'wake');
  for (const [L, tDesk, , tGate, slot, tGo] of ORDERS) { E(tDesk + .1, 'desk_stamp'); E(tDesk + .35, 'flap'); if (slot >= 0) E(tGate, 'bump'); E(tGo + .45, 'drop'); E(tGo + 1.0, 'ticket'); }
  E(48.5, 'stop'); E(49.6, 'bell'); E(50.8, 'ring_c'); E(54.6, 'flap'); E(58.0, 'flap'); E(58.1, 'gate');
  for (const n of Object.keys(N_ON)) E(N_ON[n], 'num', { n: +n });
  E(T_TICK, 'tick'); E(T_TICK + .6, 'final');
  return ev.sort((a, b) => a.t - b.t);
}

async function boot() {
  TL = await (await fetch('timeline.json')).json();
  window.DUR = TL.dur;
  await Promise.all(['900 40px BSD', '800 40px BSD', '700 40px BSD', '800 40px ARC', '700 40px ARC', '600 40px ARC'].map(f => document.fonts.load(f, 'A')));
  await document.fonts.ready;
  makeGrain();
  window.EV = events();
  window.render = t => { document.getElementById('stage').innerHTML = frame(Math.min(t, TL.dur - .001)); };
  window.TEXTS = t => {
    window.render(t);
    const res = [];
    for (const el of document.querySelectorAll('#stage text')) {
      if (el.closest('[data-sub]')) continue;
      let op = 1;
      for (let n = el; n && n.id !== 'stage'; n = n.parentElement) { const o = n.getAttribute('opacity'); if (o != null) op *= +o; }
      if (op < .5) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 14 || r.right <= 0 || r.bottom <= 0 || r.left >= 1920 || r.top >= 1080) continue;
      const s = el.textContent.trim(); if (!s) continue;
      res.push({ id: s, text: s, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
    }
    return res;
  };
  window.render(0);
  window.READY = true;
}
boot();
