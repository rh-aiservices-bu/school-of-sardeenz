"""Write subtitles_en.srt from timeline.json (the subtitles are also burned into the picture)."""
import json, os
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def ts(t): h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60; return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s % 1) * 1000)):03d}"
subs = json.load(open(os.path.join(H, 'timeline.json')))['subs']
open(os.path.join(H, 'subtitles_en.srt'), 'w').write(''.join(f"{i}\n{ts(s['t0'])} --> {ts(s['t1'])}\n{s['en']}\n\n" for i, s in enumerate(subs, 1)))
