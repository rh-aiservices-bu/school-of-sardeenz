"""Every Gigabyte · sound: a synthesized cannery march (numpy only, no sample libraries), procedural foley
on the picture's events (events.json, exported from window.EV) and the narration (voices/*.wav) -> out/mix.wav
Run: $LIB/.venv/bin/python mix.py   (LIB = the Lemo-Opuscar library folder)
"""
import json, os, sys
import numpy as np, soundfile as sf, soxr
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or '/home/user/lemomo-ai/lemo-opuscar'
sys.path.insert(0, LIB)
from core.audio import sfx as X
from core.audio.sfx import SR, add, bp, lp, hp, compress, limit, noise, env_exp, t_, norm

EVJ = json.load(open(os.path.join(HERE, 'events.json')))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
DUR = TL['dur']; N = int(DUR * SR)
EV = EVJ['ev']
music = np.zeros((N, 2)); fx = np.zeros((N, 2)); voice = np.zeros((N, 2))
B = 0.5

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
NOTE = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
def midi(p):
    n = NOTE[p[0]]; i = 1
    if p[i] == '#': n += 1; i += 1
    elif p[i] == 'b': n -= 1; i += 1
    return 12 * (int(p[i:]) + 1) + n

# ---------------- instruments ----------------
def marimba(p, v=1.0):
    f = hz(midi(p)); d = .5; tt = t_(d)
    return (np.sin(2 * np.pi * f * tt) * env_exp(d, .11) + .28 * np.sin(2 * np.pi * 4 * f * tt) * env_exp(d, .03) + .1 * hp(noise(d), 3000) * env_exp(d, .004)) * v * .5
def pizz(p, v=1.0):
    f = hz(midi(p)); d = .7; tt = t_(d)
    x = sum(a * np.sin(2 * np.pi * f * k * tt) * env_exp(d, tau) for k, a, tau in [(1, 1, .22), (2, .5, .14), (3, .28, .09), (4, .12, .06)])
    return x * v * .5
def reed(p, d=.22, v=1.0):       # a staccato bassoon / clarinet: odd harmonics, short swell
    f = hz(midi(p)); tt = t_(d + .08)
    x = sum(np.sin(2 * np.pi * f * k * tt) / k for k in (1, 3, 5, 7, 9))
    e = np.minimum(1, tt / .015) * np.where(tt < d, 1, np.exp(-(tt - d) / .025))
    return lp(x * e, 2600) * v * .22
def glock(p, v=1.0):
    f = hz(midi(p)); d = 1.4; tt = t_(d)
    return (np.sin(2 * np.pi * f * tt) * env_exp(d, .45) + .4 * np.sin(2 * np.pi * 2.76 * f * tt) * env_exp(d, .2) + .2 * np.sin(2 * np.pi * 5.4 * f * tt) * env_exp(d, .08)) * v * .3
def wood(v=1.0, f=1.0):
    d = .12; tt = t_(d)
    return (np.sin(2 * np.pi * 880 * f * tt) * env_exp(d, .018) + .6 * np.sin(2 * np.pi * 1420 * f * tt) * env_exp(d, .012)) * v * .5
def hat(v=1.0):
    d = .06; return hp(noise(d), 6000) * env_exp(d, .012) * v * .3
def drum(v=1.0): return X.thump(v, 62)
def snare(v=1.0):
    d = .14; tt = t_(d); return (bp(noise(d), 900, 5000) * env_exp(d, .035) + .5 * np.sin(2 * np.pi * 190 * tt) * env_exp(d, .03)) * v * .4

# ---------------- score ----------------
T_MARCH, T_STOP, T_GATE, T_FINAL = 19.6, 48.5, 58.1, 66.0
PROG = [(['C2', 'G2', 'C3', 'G2'], ['C5', 'G4', 'E5', 'G4']), (['F2', 'C3', 'F3', 'C3'], ['F5', 'C5', 'A5', 'C5']),
        (['G2', 'D3', 'G3', 'D3'], ['B4', 'D5', 'G5', 'D5']), (['C2', 'G2', 'C3', 'E3'], ['C5', 'E5', 'G5', 'E5'])]
PROG2 = [(['D2', 'A2', 'D3', 'A2'], ['D5', 'A4', 'F#5', 'A4']), (['G2', 'D3', 'G3', 'D3'], ['G5', 'D5', 'B5', 'D5']),
         (['A2', 'E3', 'A3', 'E3'], ['C#5', 'E5', 'A5', 'E5']), (['D2', 'A2', 'D3', 'F#3'], ['D5', 'F#5', 'A5', 'F#5'])]
MOT = [(0, 'E5'), (.5, 'G5'), (.75, 'C6'), (1.25, 'G5'), (1.5, 'F5'), (1.75, 'E5')]
MOT2 = [(0, 'F#5'), (.5, 'A5'), (.75, 'D6'), (1.25, 'A5'), (1.5, 'G5'), (1.75, 'F#5')]

# act 1: a workshop with nothing going right. A lone woodblock, then a grumbling reed that stops at every buzzer.
buzz = [e['t'] for e in EV if e['type'] == 'buzz']
t = 0.5; k = 0
while t < 13.9:
    add(music, wood(.5 + .15 * (k % 4 == 0), 1.0 if k % 2 == 0 else .84), t, 1, -.3)
    halted = any(b - .05 <= t < b + .9 for b in buzz)
    if t >= 7.5 and not halted:
        add(music, reed(['A2', 'E3', 'A2', 'C3', 'A2', 'E3', 'G2', 'B2'][k % 8], .2, .9), t, 1, .2)
        if k % 2 == 0: add(music, pizz(['A1', 'A1', 'E2', 'E2'][(k // 2) % 4], .7), t, 1, .1)
    t += B; k += 1
for i, tt in enumerate(np.arange(15.9, 17.5, B)): add(music, wood(.25, .84), tt, 1, -.3)            # near-silence: one hollow tick
for i, tt in enumerate(np.arange(17.6, 19.55, .125)): add(music, snare(.25 + .75 * i / 16), tt, 1, 0)   # roll into the march

def march(a, b, prog, mot, tune_from, full=True):
    t = a; k = 0
    while t < b - 1e-6:
        bass, ost = prog[(k // 16) % 4]
        add(music, marimba(ost[(k // 1) % 4], .5 + .1 * (k % 2 == 0)), t, 1, -.25)
        if k % 2 == 0:
            add(music, pizz(bass[(k // 2) % 4], .85), t, 1, .1)
            add(music, reed(bass[(k // 2) % 4].replace('2', '3').replace('1', '2'), .16, .7), t, 1, .2)
        add(music, hat(.5 + .3 * (k % 2)), t, 1, .35)
        if k % 4 == 2: add(music, wood(.6), t, 1, -.4)
        if full and k % 8 == 0: add(music, drum(.5), t, 1, 0)
        if t >= tune_from and (k // 16) % 2 == 0 and k % 8 == 0:
            for dt, p in mot: add(music, reed(p, .13, 1.1), t + dt * B, 1, -.1)
        t += B / 2; k += 1
march(T_MARCH, T_STOP - .05, PROG, MOT, 24.6)
# the stop: the band is gone. A clock, then a slow bass drum while the foreman decides, then the bass walks back in.
for tt in np.arange(50.6, T_GATE - .1, B): add(music, wood(.3, 1.3 if int(tt * 2) % 2 else 1.1), tt, 1, .3)
for tt in np.arange(51.6, T_GATE - .1, 2.0): add(music, drum(.6), tt, 1, 0)
for i, tt in enumerate(np.arange(55.1, T_GATE - .1, B)): add(music, pizz(['D2', 'A2', 'D3', 'A2'][i % 4], .5 + .05 * i), tt, 1, .1)
march(T_GATE, T_FINAL - .05, PROG2, MOT2, T_GATE)
for p, pan in [('D2', 0), ('A3', -.3), ('D4', .3), ('F#4', -.1), ('A4', .2)]: add(music, pizz(p, 1.0) + 0, T_FINAL, 1, pan)
for p in ['D5', 'F#5', 'A5', 'D6']: add(music, glock(p, .9), T_FINAL, 1, 0)
add(music, drum(1.0), T_FINAL, 1, 0)

# ---------------- foley ----------------
def sweep(d, f0, f1, v=1.0):      # a rolling / sliding sound
    n = noise(d); o = np.zeros_like(n); st = 960
    for i in range(0, len(n), st):
        hi = min(len(n), i + st); f = f0 + (f1 - f0) * i / len(n)
        o[i:hi] = bp(n[max(0, i - 2000):hi], f * .7, f * 1.4)[-(hi - i):]
    return norm(o * np.minimum(1, np.minimum(t_(d), d - t_(d)) / .08)) * v
def chain(d, v=1.0):
    o = np.zeros(int(d * SR) + 4000)
    for tt in np.arange(0, d, .07): c = X.click(1.6 + .3 * np.sin(tt * 9), .5); o[int(tt * SR):int(tt * SR) + len(c)] += c
    return o * v
def buzzer(v=1.0):
    d = .45; tt = t_(d); return lp(np.sign(np.sin(2 * np.pi * 110 * tt)) * np.minimum(1, (d - tt) / .03), 1400) * v * .35
def bell(v=1.0):
    d = 2.2; tt = t_(d)
    return norm(sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(880, 1, .9), (1760, .5, .5), (2217, .35, .4), (2960, .2, .25)])) * v
def hollow(v=1.0):                # something small landing in a big empty tin
    d = .9; tt = t_(d)
    return norm(sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(220, 1, .25), (331, .6, .3), (517, .4, .2)]) + hp(noise(d), 1500) * env_exp(d, .01)) * v
def flap(v=1.0):
    o = np.zeros(int(.3 * SR))
    for i in range(4): c = X.click(1.2, .6); s = int(i * .05 * SR); o[s:s + len(c)] += c
    return o * v

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'blink': add(fx, X.click(2.0, .25), t, 1, .4)
    elif ty == 'callout': add(fx, X.pop(.5), t, 1, .4)
    elif ty == 'press': add(fx, sweep(.4, 300, 900, .5), t, 1, -.2)
    elif ty == 'press_up': add(fx, sweep(.4, 900, 300, .35), t, 1, -.2)
    elif ty == 'clank': add(fx, X.clack(.6, .9), t, 1, -.2); add(fx, X.thump(.6, 90), t, 1, -.2)
    elif ty == 'buzz': add(fx, buzzer(.9), t, 1, -.1)
    elif ty == 'stamp': add(fx, X.thump(.9, 80), t, 1, -.2); add(fx, X.ding(.35), t + .15, 1, 0)
    elif ty == 'hop': add(fx, X.whoosh(.9, .5), t, 1, .2)
    elif ty == 'hollow': add(fx, hollow(.9), t, 1, .4)
    elif ty == 'empty': add(fx, X.pop(.4), t, 1, .4)
    elif ty == 'truck': add(fx, X.whoosh(e['d'], .7), t, 1, 0)
    elif ty == 'roll': add(fx, sweep(e['d'], 500, 1400, .45), t, 1, 0); add(fx, chain(e['d'], .25), t, 1, .2)
    elif ty == 'lid_shut': add(fx, X.thump(.9, 70), t, 1, 0)
    elif ty == 'lever': add(fx, X.clack(.8, .8), t, 1, .5); add(fx, X.creak(.4), t + .05, 1, .5)
    elif ty == 'chain': add(fx, chain(max(.2, e['d']), .32), t, 1, .1)
    elif ty == 'grab': add(fx, X.clack(1.1, .7), t, 1, .1)
    elif ty == 'settle': add(fx, X.thump(.7, 95), t, 1, 0); add(fx, X.clack(.9, .5), t + .03, 1, 0)
    elif ty == 'full': add(fx, X.ding(.6), t, 1, 0); add(music, glock('C6' if e['n'] == 0 else 'E6', 1.0), t, 1, 0)
    elif ty == 'wake': add(fx, X.ding(.5), t, 1, 0); add(music, glock('A5', 1.0), t, 1, 0)
    elif ty == 'desk_stamp': add(fx, X.thump(.6, 110), t, 1, -.5); add(fx, X.clack(1.0, .5), t, 1, -.5)
    elif ty == 'flap': add(fx, flap(.6), t, 1, -.1)
    elif ty == 'bump': add(fx, X.clack(.7, .6), t, 1, .2)
    elif ty == 'drop': add(fx, X.whoosh(.35, .45), t, 1, .3)
    elif ty == 'ticket': add(fx, X.pop(.45), t, 1, 0)
    elif ty == 'stop': add(fx, X.clack(.5, 1.0), t, 1, .2); add(fx, X.thump(.8, 80), t, 1, .2)
    elif ty == 'bell': add(fx, bell(.8), t, 1, .3)
    elif ty == 'ring_c': add(fx, X.pop(.5), t, 1, .5)
    elif ty == 'gate': add(fx, sweep(.3, 400, 1200, .5), t, 1, .2); add(fx, X.clack(1.0, .7), t + .28, 1, .2)
    elif ty == 'num': add(music, glock(['G5', 'C6', 'E6', 'G6', 'A5', 'D6'][e['n'] - 1], .8), t, 1, 0)
    elif ty == 'tick': add(fx, sweep(.25, 2500, 4000, .4), t, 1, .5)
# ambience: workshop room tone, then the hum of the belt inside, then harbour air at the end
amb = np.zeros((N, 2)); tt = np.arange(N) / SR
room = lp(noise(DUR), 400) * .012; hum = (np.sin(2 * np.pi * 55 * tt) * .012 + lp(noise(DUR), 900) * .01)
g_in = np.clip((tt - 21.6) / 2, 0, 1) * np.clip((64.7 - tt) / 2, 0, 1)
for ch in (0, 1): amb[:, ch] = room[:N] * (1 - g_in) * 1.2 + hum[:N] * g_in

# ---------------- voice ----------------
for s in TL['subs']:
    x, sr = sf.read(os.path.join(HERE, 'voices', s['id'] + '.wav'), dtype='float64')
    if x.ndim > 1: x = x.mean(1)
    x = soxr.resample(x, sr, SR)
    add(voice, x, s['v'], 1, 0)
v = compress(voice[:, 0], thr=.12, ratio=3.0); v = v / (np.abs(v).max() + 1e-9) * .85
voice = np.stack([v, v], 1)

# ---------------- mix: duck the music under the voice, balance, limit ----------------
envv = np.abs(v); w = int(.05 * SR); envv = np.convolve(envv, np.ones(w) / w, 'same')
envv = lp(np.where(envv > .02, 1.0, 0.0), 4)                         # smooth gate, ~0.1 s
duck = 1 - .58 * np.clip(envv, 0, 1)
def rms(x): return np.sqrt((x ** 2).mean() + 1e-12)
mg = .10 / rms(music[int(22 * SR):int(46 * SR)])                     # march RMS about 10 dB under the voice
vg = .30 / rms(voice[np.abs(voice[:, 0]) > .02])
mixd = music * mg * duck[:, None] + fx * .5 * (1 - .3 * np.clip(envv, 0, 1))[:, None] + amb + voice * vg
fade = np.minimum(1, (DUR - tt) / .6)
mixd *= fade[:, None]
for ch in (0, 1): mixd[:, ch] = limit(mixd[:, ch], .9)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mixd, SR, subtype='PCM_24')
lo = rms(lp(mixd[:, 0], 120)); al = rms(mixd[:, 0])
print(f'mix.wav {DUR}s  peak {np.abs(mixd).max():.2f}  low-band/all {20 * np.log10(lo / al):.1f} dB  voice-vs-music {20 * np.log10(.30 / .10):.1f} dB')
