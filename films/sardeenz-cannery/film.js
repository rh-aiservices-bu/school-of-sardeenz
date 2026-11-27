// The Tin Never Changes · camera, one frame, subtitles (60 s, 1920×1080, 24 fps)
// One world (the tin on its legs), one camera moving in the plane of the drawing.

let TL;
let ZL = 1;
window.DUR = 60;

// camera keys: [t, x, y, z]; eio between keys, so every key is a hold
const CAM = [
  [0, 1750, 1010, .40], [5.0, 1750, 1010, .40],
  [9.6, 700, 520, 1.0], [12.6, 1000, 480, 1.0],
  [13.9, 2380, 560, 1.0], [15.0, 1700, 1640, 1.1], [16.6, 1700, 1640, 1.14],
  [17.4, 760, 500, 1.0], [18.8, 1000, 480, 1.0], [20.2, 1900, 480, 1.0], [26.0, 1930, 480, 1.03],
  [28.0, 3130, 470, 1.38], [35.0, 3130, 470, 1.43],
  [36.4, 1800, 1330, .56], [44.8, 1800, 1330, .585],
  [45.9, 1900, 480, 1.0], [48.4, 1900, 480, 1.0], [50.6, 700, 560, 1.0],
  [54.0, 1750, 1010, .395], [60, 1790, 1010, .405],
];
const WHIP = [[13.9, 15.0], [16.6, 17.4], [35.0, 36.4], [45.0, 45.9]];
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

async function boot() {
  TL = await (await fetch('timeline.json')).json();
  window.DUR = TL.dur;
  await Promise.all(['900 40px BSD', '800 40px BSD', '700 40px BSD', '800 40px ARC', '700 40px ARC', '600 40px ARC'].map(f => document.fonts.load(f, 'A')));
  await document.fonts.ready;
  makeGrain();
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
