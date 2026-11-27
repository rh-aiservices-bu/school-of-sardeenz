"""Twenty-Four Cubes · score, foley and voice → out/mix.wav (48 kHz stereo).
Everything is synthesised with numpy (no samples). Cue times come from events.json (exported from film.js).
Run:  $LIB/.venv/bin/python mix.py   (LIB = the Lemo-Opuscar library folder)"""
import json, os, sys
import numpy as np, soundfile as sf, soxr
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or sys.exit('set LIB to the Lemo-Opuscar library folder')
sys.path.insert(0, os.path.join(LIB, 'core', 'audio'))
import sfx
from sfx import SR, add
EVJ = json.load(open(os.path.join(HERE, 'events.json'))); DUR = EVJ['dur']; EV = EVJ['ev']
VOICE_T = {'L1': .6, 'L2': 8.0, 'L3': 16.4, 'L4': 23.4, 'L5': 31.4, 'L6': 40.4, 'L7': 48.4, 'L8': 52.6, 'L9': 60.4, 'L10': 63.6}
N = int(DUR * SR)
music, fol, vox = (np.zeros((N, 2), np.float32) for _ in range(3))
hz = lambda m: 440 * 2 ** ((m - 69) / 12)

def marimba(m, d=.7, v=1.0):
    t = sfx.t_(d); f = hz(m)
    x = np.sin(2 * np.pi * f * t) * np.exp(-t / (.22 if m < 72 else .16)) + .35 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t / .05) + .12 * np.sin(2 * np.pi * f * 10 * t) * np.exp(-t / .015)
    x[:48] *= np.linspace(0, 1, 48); return (x * v).astype(np.float32)
def bass(m, d=.42, v=1.0):
    t = sfx.t_(d); f = hz(m)
    x = (np.sin(2 * np.pi * f * t) + .4 * np.sin(2 * np.pi * 2 * f * t) + .18 * np.sin(2 * np.pi * 3 * f * t)) * np.exp(-t / .22) * np.minimum(1, t / .006)
    return (x * v).astype(np.float32)
def glock(m, d=1.4, v=1.0):
    t = sfx.t_(d); f = hz(m); return ((np.sin(2 * np.pi * f * t) + .5 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / .2)) * np.exp(-t / .45) * v).astype(np.float32)
def shaker(v=1.0):
    d = .07; return (sfx.hp(sfx.noise(d), 6000) * np.exp(-sfx.t_(d) / .018) * v).astype(np.float32)
def block(v=1.0, f=900):
    d = .09; t = sfx.t_(d); return ((np.sin(2 * np.pi * f * t) + .5 * np.sin(2 * np.pi * f * 2.4 * t)) * np.exp(-t / .02) * v).astype(np.float32)

BEAT = .5
PENTA = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]
ev = lambda ty: [e for e in EV if e['type'] == ty]
T = {e['type'] + str(i): e['t'] for i, e in enumerate(EV)}
first = lambda ty: ev(ty)[0]['t']

# --- act 1: one note per cube, climbing ---
for e in ev('cube'):
    n = e['n']; add(music, marimba(PENTA[min(10, n * 10 // 23)] if n else 60, v=.5 + .3 * n / 23), e['t'], .55, pan=-.4 + .8 * n / 23)
    add(fol, sfx.pop(.5), e['t'], .25, pan=-.4 + .8 * n / 23)
# --- the problem: A minor, a pulse that stops on every bump ---
bumps = [e['t'] for e in ev('bump')]
def muted(t):
    if any(b <= t < b + .7 for b in bumps): return True
    return (22.9 <= t < 23.4) or (51.3 <= t < 53.0)
t = 8.0
while t < 22.9:
    if not muted(t):
        add(music, bass(45 if t < 16 else 41, v=.8), t, .5)
        if t >= 9: add(music, block(.5), t + BEAT / 2, .22, pan=.3)
    t += BEAT * (1 if t < 16 else 2)
for e in ev('idle'):
    add(music, marimba(81 - e['n'] % 5 * 2 - e['n'] // 5 * 3, d=.3, v=.5), e['t'], .32, pan=.5 - e['n'] / 22)
    add(fol, sfx.click(1.2 - e['n'] * .02, .5), e['t'], .2, pan=.5 - e['n'] / 22)
# --- Sardeenz: C major ostinato, C | Am | F | G, one bar each (2 s) ---
CH = [(48, [60, 64, 67, 72]), (45, [57, 60, 64, 69]), (41, [57, 60, 65, 69]), (43, [59, 62, 67, 71])]
add(music, sum(np.pad(marimba(m, 1.6, .8), (0, 0)) for m in [48 + 12, 64, 67, 72]), 23.4, .5)
add(music, bass(36, .9, 1), 23.4, .6)
t = 24.0; bar = 0
while t < 65.4:
    root, notes = CH[bar % 4]
    low = 48.0 <= t < 58.2                       # under the board: bass and woodblock only
    full = t >= 40 and not low
    for b in range(4):
        tb = t + b * BEAT
        if muted(tb) or tb >= 65.4: continue
        if b in (0, 2) or full: add(music, bass(root if b != 3 else root + 7, v=.8), tb, .5)
        if low:
            add(music, block(.5, 700), tb + BEAT / 2, .2, pan=.3); continue
        dens = 1 if t < 32 else 2                # quarters first, then eighths: the system fills up
        for k in range(dens):
            n = notes[(b * dens + k) % 4]
            add(music, marimba(n + (12 if full and k else 0), v=.6), tb + k * BEAT / dens, .34, pan=-.25 + .5 * ((b + k) % 2))
        add(music, shaker(.6), tb + BEAT / 2, .14 if t >= 32 else .08, pan=.4)
        if full and b == 2: add(music, block(.5), tb, .16, pan=-.3)
    t += 4 * BEAT; bar += 1
for m, dt in [(48 + 12, 0), (64, .02), (67, .04), (72, .06), (76, .08)]: add(music, glock(m, 1.5, .5), 65.5 + dt, .4)
add(music, bass(36, 1.2, 1), 65.5, .6)
for e in ev('full'): add(music, glock(84, 1.2, .5), e['t'], .35); add(music, glock(79, 1.2, .4), e['t'] + .12, .3)

# --- foley ---
hum = sfx.lp(sfx.brown(DUR), 220)[:N] * .5 + sfx.bp(sfx.noise(DUR), 110, 130)[:N] * .04
env = np.interp(np.arange(N) / SR, [0, 7, 8.5, 22.8, 23.4, 51.2, 51.6, 52.8, 53.3, 65, DUR], [0, 0, 1, 1, .5, 1, .15, .15, 1, 1, .3])
fol[:, 0] += hum * env * .05; fol[:, 1] += np.roll(hum, 311) * env * .05
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'land': add(fol, sfx.thump(1, 80 if e.get('big') else 130), t, .2 if e.get('soft') else .5 if e.get('big') else .35); add(fol, sfx.clack(.8, .6), t, .25)
    elif ty == 'bump': add(fol, sfx.clack(.6, 1), t, .3 if e.get('small') else .55); add(fol, sfx.thump(.8, 150), t, .3)
    elif ty == 'walls': add(fol, sfx.creak(.6), t, .18); add(fol, sfx.whoosh(.4, .5), t, .2)
    elif ty in ('lift', 'hop'): add(fol, sfx.whoosh(.5, .6), t, .28)
    elif ty == 'whoosh': add(fol, sfx.whoosh(.9, .7), t, .3)
    elif ty == 'slide': add(fol, sfx.whoosh(.7, .4), t, .16)
    elif ty in ('lock', 'unlock'): add(fol, sfx.click(.7, 1), t, .5); add(fol, sfx.clack(.5, .8), t + .03, .3)
    elif ty == 'coral': add(fol, sfx.pop(.8), t, .3); add(fol, sfx.pop(.8), t + .15, .3)
    elif ty == 'pin': add(fol, sfx.click(1.6, .5), t, .16)
    elif ty == 'req': add(fol, sfx.click(2.0, .3), t, .05, pan=-.5)
    elif ty == 'park': add(fol, sfx.clack(.7, .9), t, .4, pan=-.3)
    elif ty == 'go': add(fol, sfx.ding(.8), t, .32); add(fol, sfx.whoosh(.5, .5), t, .2)
    elif ty == 'title': add(fol, sfx.whoosh(.6, .7), t - .2, .25)

# --- voice: compress, place, duck the rest under it ---
duck = np.ones(N, np.float32)
for L in json.load(open(os.path.join(HERE, 'lines.json'))):
    x, sr = sf.read(os.path.join(HERE, 'voices', L['id'] + '.wav')); x = soxr.resample(x.astype(np.float64), sr, SR)
    x = sfx.compress(sfx.norm(sfx.hp(x, 80), .9), thr=.2, ratio=3)
    t0 = VOICE_T[L['id']]; add(vox, x.astype(np.float32), t0, .62)
    a, b = int((t0 - .15) * SR), int((t0 + len(x) / SR + .25) * SR); duck[max(0, a):b] = .38
k = int(.12 * SR); duck = np.convolve(duck, np.ones(k) / k, 'same')
mus = music * duck[:, None] * .9; mus[:, 0] = sfx.hp(mus[:, 0], 35); mus[:, 1] = sfx.hp(mus[:, 1], 35)
mixd = mus + fol * (.55 + .45 * duck[:, None]) + vox
fade = np.minimum(1, (DUR - np.arange(N) / SR) / .5); mixd *= fade[:, None]
for c in (0, 1): mixd[:, c] = sfx.limit(mixd[:, c], .89)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mixd, SR, subtype='PCM_16')
rms = lambda x: 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)
print('mix.wav %.1f s   rms: music %.1f  foley %.1f  voice %.1f  mix %.1f dB' % (DUR, rms(mus), rms(fol), rms(vox), rms(mixd)))
