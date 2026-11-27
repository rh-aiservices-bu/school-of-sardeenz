"""film.js SUBS → out/srt.json for core/render/srt.py, and a hold check against the voice durations."""
import json, os, subprocess
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
js = "globalThis.document={};import('./film.js').then(m=>console.log(JSON.stringify(m.SUBS))).catch(e=>{console.error(e);process.exit(1)})"
src = open(os.path.join(D, 'film.js'), encoding='utf-8').read()
a = src.index('export const SUBS = ['); b = src.index('];', a) + 2
subs = json.loads(subprocess.check_output(['node', '-e', src[a:b].replace('export const SUBS =', 'const SUBS =') + ';console.log(JSON.stringify(SUBS))']))
os.makedirs(os.path.join(D, 'out'), exist_ok=True)
json.dump([{'t0': s['t0'], 't1': s['t1'], 'text': s['text']} for s in subs], open(os.path.join(D, 'out', 'srt.json'), 'w'), indent=1)
bad = [s for s in subs if s['t1'] - s['t0'] < 1.8]
print(len(subs), 'subtitles;', 'all hold >= 1.8 s' if not bad else 'SHORT: %s' % bad)
