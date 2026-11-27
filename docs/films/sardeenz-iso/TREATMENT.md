# Twenty-Four Cubes — treatment

A 66-second explainer of Sardeenz for platform engineers, in the Isometric Infographic style.
English voice and burned-in English subtitles, 1920×1080, 24 fps. Second film of the series; it
carries the same message as "Every Gigabyte" with different pictures.

## 1. Candidate structures

1. **Follow one request** from the client to a model and back. Good for the proxy, but the
   selling point (packing mixed models) would be scenery.
2. **Two boards compared**: a sliced GPU farm next to a packed one, alternating. Clear, but it
   spends half the film on the thing Sardeenz is not.
3. **One icon that multiplies.** A single cube is one gigabyte. Twenty-four make a GPU. Every
   later number is counted in the same cubes: 2 unused, 22 idle, 48 of 48 working. The waste is
   shown first, slicing fails on screen, then the same cubes are packed. **Chosen:** the Isotype
   number is the argument, the film has one unit from first frame to last, and sleep/wake fits
   as a layer underneath (host RAM as a stratum below the GPUs).

## 2. Logline and arc

Twenty-four cubes are a GPU; two of them cannot be used, and a tiny model burns twenty-two more,
until memory is tracked in software and every cube goes to work.

- **Setup.** One cube = 1 GB. 24 = one GPU. Model A takes 22. Two are left over.
- **Complication.** Fixed slices: 4 × 6 and 2 × 12 cannot hold a 22 GB model; 1 × 24 can, and
  locks the two spare cubes. The 2 GB model P gets a second GPU: 22 cubes idle.
- **Turn.** Sardeenz does not slice. P moves into the two spare cubes: 24 / 24.
- **Development.** GPU 1 fills with an LLM, an embedding model and another LLM. One proxy routes
  requests to each.
- **Bonus.** Under the board lies host RAM. A request for sleeping model D waits at the proxy
  while the least recently used model sinks into host RAM and D rises.
- **Ending.** Pull back to the finished infographic: 6 models, 2 GPUs, 48 / 48 GB. Kubernetes
  still sees two allocated GPUs.

## 3. Benchmark

- **Isotype (Neurath / Arntz).** Learn: one icon, one quantity, counted not stated. Do not take:
  their pictograms.
- **Kurzgesagt explainers.** Learn: one metaphor per step, a steady push forward. Do not take:
  characters, palette, music.

## 4. Colour legend (one meaning each)

| Hue | Meaning |
|---|---|
| electric blue | generative model (LLM) |
| mint | embedding model |
| amber | predictive model |
| coral | memory nobody can use |
| graphite | GPU hardware, slice walls |
| violet | Sardeenz control (control plane, proxy) |
| warm grey | asleep / host RAM |

## 5. Shot list

| # | Time | Camera | What happens |
|---|---|---|---|
| 1 | 0–7.5 | close, locked, then slight pull | One cube pops: 1 GB. It multiplies to 24 on a tray: GPU 0. Block A (22) lands. Two cubes turn coral. |
| 2 | 7.5–16 | locked | A lifts. Slice walls rise: 4 × 6, A cannot land. 2 × 12, cannot land. 1 × 24: lands, the spare cubes get a lock plate. |
| 3 | 16–23 | pull out, pan right | P (2) follows a route line, is refused, GPU 1 slides in, P lands alone. 22 coral cubes count up. |
| 4 | 23–31 | locked wide, title on the ground plane | SARDEENZ rises as isometric type. Lock plate slides away; P hops into GPU 0. Counter 24 / 24. |
| 5 | 31–40 | locked while things accumulate | B (12), E (4), C (8) land on GPU 1, each with a kind pin. 48 / 48. Legend appears. |
| 6 | 40–48 | fast pull-out to the board | Plinth, proxy gate, control tower. Request parcels follow route lines to each model. |
| 7 | 48–60 | tilt down to the strata, push in | Host RAM layer with sleeping D. A request for D waits at the gate. C greys and sinks; D rises and takes its colour; the request goes through. |
| 8 | 60–66 | scale reveal | Every pin on screen; a Kubernetes pin on the GPUs; legend end frame, NOT TO SCALE. |

## 6. Voice (Kokoro, calm explainer)

| t | Line |
|---|---|
| 0.6 | One GPU: twenty-four gigabytes. Your model takes twenty-two. Two are left over. |
| 8.0 | Slicing the GPU doesn't help. Slices come in fixed sizes, and this model needs the whole card. |
| 16.4 | So a two-gigabyte model gets a second GPU. Twenty-two gigabytes sit idle. |
| 23.4 | Sardeenz doesn't slice. It tracks memory in software, and packs each GPU by size. |
| 31.4 | Generative, embedding, predictive. Different engines, different sizes, on the same GPUs. |
| 40.4 | One proxy routes every request to the right model. |
| 48.4 | More models than memory? Idle ones sleep in host RAM. |
| 52.6 | A request for a sleeping model waits, while the least recently used one is swapped out. |
| 60.4 | Kubernetes still sees two busy GPUs. Sardeenz: every gigabyte, working. |

## 7. Cue map and sound

120 BPM, bars of 2 s. Marimba motif for the cube (one note per cube as the row fills), synth bass,
shaker and woodblock, glockenspiel on totals.

| Section | Ambience | Foley | Music |
|---|---|---|---|
| 1 | near silence | cube pops on a rising marimba scale, block thud | marimba only |
| 2 | machine-room hum | walls rise (servo), bump ×2, lock clack | bass enters; drops out on each bump |
| 3 | hum | route tick, slab slide, small plink, coral count rattles | sparse, minor |
| 4 | hum | plate slides, hop, ding | **stop before the title**, then full pattern |
| 5 | hum | three landings on the beat, glock on 48 / 48 | accumulating: quarter notes, then eighths |
| 6 | hum + soft data clicks | parcels tick | full |
| 7 | low-passed as the camera goes down | **silence** as the request waits; sink and rise whooshes | bass and woodblock only |
| 8 | hum | one note per pin | full, final chord |

## 8. Type

Jost: titles 600 caps tracked, numbers 400 large. Label pins with halo. Subtitle is a map label:
pale card, ink border, small cube chip, bottom centre.

## 9. Where the metaphor simplifies (FACTS.md)

- Memory drawn as 24 equal cubes; real placement uses each model's configured memory requirement.
- MIG shown as three equal-slice schemes on a 24 GB card; real profiles vary by GPU.
- Swap shown as one 8 GB model for another; real eviction frees what the incoming model needs.
- Host RAM drawn as a layer under the GPUs.
