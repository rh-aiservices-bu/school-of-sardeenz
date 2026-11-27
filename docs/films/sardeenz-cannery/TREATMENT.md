# Every Gigabyte — treatment (revision 2)

A 68-second explainer of Sardeenz for platform engineers, in the Assembly-Line Diagram style.
English voice and subtitles, 1920×1080, 24 fps.

Revision 2 moves the centre of the story. The selling point is **packing**: many models of
different kinds and sizes on a finite number of GPUs, where fixed slicing (MIG) wastes memory or
does not apply. Sleep and wake is the closing bonus, not the plot.

## 1. Candidate structures

1. **One request that hits a sleeping model** (revision 1). Shows the mechanism well, but makes
   wake-up the whole point and never shows mixed kinds or sizes.
2. **A tour of the components.** The architecture diagram again; no problem, no payoff.
3. **The wasted corner.** Start from a waste every GPU owner recognises: a 22 GB model on a
   24 GB card, 2 GB nobody can use, a small model sent to a GPU of its own. Fixed slicing fails
   on screen. Then Sardeenz packs by size, mixes kinds, routes requests, and finally swaps a
   sleeping model in. **Chosen:** the problem is concrete and measurable, the answer is one
   picture (a full tray), and wake-up arrives as "and there is more".

## 2. Logline and arc

A 2 GB corner of a GPU that slicing cannot offer becomes the home of a small predictive model,
and from there every gigabyte of every GPU is put to work.

- **Setup.** One GPU, 24 GB. The model needs 22. Two gigabytes sit empty.
- **Complication.** The slicing press tries its fixed schemes: 4 × 6, 2 × 12, 1 × 24. Only the
  whole-GPU slice fits, and it seals the corner. The small model gets a second GPU, 22 GB empty.
- **Turn.** Sardeenz does not slice. The control plane keeps a memory ledger and the crane drops
  the small model into the corner: 24 / 24.
- **Development.** A second GPU fills with an LLM, another LLM and an embedding model. Different
  engines, different sizes, same GPU. One proxy routes each request to the right model.
- **Bonus.** More models than memory: idle ones sleep in host RAM. A request for a sleeping
  model is parked while the least recently used one is swapped out.
- **Ending.** The lid closes. Kubernetes counts two GPUs in use; nothing moved.

## 3. Benchmark

- **Fritz Kahn, *Der Mensch als Industriepalast* (1926).** Learn: one silhouette cut into rooms,
  a colour per circuit, workers as scale. Do not take: the body, the plate layout, the lettering.
- **Powers of Ten (Eames, 1977).** Learn: a continuous move that ends on the whole. Do not take:
  the framing square, the side numbers.

## 4. The world

**Before Sardeenz** (on a bench, outside the cannery): two ordinary tins, each a GPU with a
ruler from 0 to 24 GB, and a slicing press over the first.

**The cannery** (a sardine tin cut open; its lid carries the title):

| # | Plaque (metaphor / real thing) | What it does in the film |
|---|---|---|
| 1 | FOREMAN / CONTROL PLANE | memory ledger per GPU, "last asked" clocks, command lever |
| 2 | PACKING FLOOR / GPU VRAM | two trays with rulers; models lie end to end, length = GB |
| 3 | DISPATCH DESK / ROUTING PROXY | every order lands here |
| 4 | DEPARTURES BOARD / ROUTING MAP · REDIS | one row per model: AWAKE or ASLEEP |
| 5 | WAITING ROOM / CONNECTION PARKING | STOP sign holds an order; one bell cord |
| 6 | PANTRY SHELF / HOST RAM | where a sleeping model is put |

Models are sea creatures whose **length is their memory** and whose **species is their kind**:
a sardine is an LLM (generative), a small striped fish is an embedding model, a prawn is a
predictive model. Each carries a card: kind and gigabytes.

| Model | Kind | Size | Where |
|---|---|---|---|
| A | LLM | 22 GB | GPU 0 |
| P | predictive | 2 GB | GPU 0, in the corner |
| B | LLM | 12 GB | GPU 1 |
| C | LLM | 8 GB | GPU 1, later swapped out |
| E | embedding | 4 GB | GPU 1 |
| D | LLM | 8 GB | asleep, later swapped in |

Colour is the legend: **red** = inference traffic, **ochre** = control, **teal** = state (awake).

## 5. Shot list

| # | Time | Framing and move | What happens |
|---|---|---|---|
| 1 | 0–7 | Medium on the bench, slow push | GPU 0: model A, 22 GB. The last 2 GB blink: EMPTY. |
| 2 | 7–14 | Same, held | Slicing press: 4 × 6 fails, 2 × 12 fails, 1 × 24 fits and seals the corner. |
| 3 | 14–18 | Pan right | The prawn hops into GPU 1: 22 GB EMPTY. |
| 4 | 18–24 | Fast truck to the cannery, wide | The lid, SARDEENZ, rolls back on its key. |
| 5 | 24–31 | Push to the packing floor | Crane drops the prawn into the corner. GPU 0: 24 / 24. |
| 6 | 31–39 | Held, slow push | Crane adds the embedding model to GPU 1: 24 / 24. Cards show kind and size. |
| 7 | 39–47 | Whip up, truck right | Orders for P, A, B pass the desk and board, drop to their models; answers stream back. |
| 8 | 47–51 | Medium, music stops | Order for D: ASLEEP. STOP sign, bell rings once. |
| 9 | 51–61 | Pull back to the whole cannery | Clock ring on C, crane swaps C to the shelf and D into the tray, board flips, gate lifts. |
| 10 | 61–68 | The great pull-back | Lid closes. Inspector Kubernetes ticks "GPU × 2, in use". |

## 6. Voice

| t | Line |
|---|---|
| 0.8 | One GPU. Twenty-four gigabytes. Your model needs twenty-two. The last two sit empty. |
| 7.4 | Slicing can't help: slices come in fixed sizes, and none leaves a two-gigabyte corner. |
| 14.0 | So the small model gets a GPU of its own. |
| 19.6 | Sardeenz doesn't slice. |
| 24.2 | It keeps a memory ledger and packs each GPU by size. |
| 31.2 | Generative, predictive, embeddings: different engines, different sizes, same GPU. |
| 39.6 | One proxy routes every request to the right model. |
| 47.4 | More models than memory? The idle ones sleep in host RAM. |
| 51.6 | A request for a sleeping model is parked while the least recently used one is swapped out. |
| 58.0 | The client just sees a slow first token. |
| 63.0 | To Kubernetes, nothing moved. |
| 65.8 | Sardeenz: every gigabyte, working. |

## 7. Cue map and sound

120 BPM march, bars of 2 s; bassoon and woodblock base, a new voice per station.

| Section | Ambience | Foley | Music |
|---|---|---|---|
| 1 | workshop room tone | a drip of a tap; the gap "blink" tick | solo woodblock tick |
| 2 | same | press descending, clank and buzzer twice, clean stamp once | bassoon joins, stops on each buzzer |
| 3 | same | hop, landing in an empty tin (hollow ring) | **near-silence** after the landing |
| 4 | harbour air | lid rolling on its key | march starts, full figure |
| 5–6 | belt hum | lever, crane chain, settle, ledger ding ×2 | + clarinet, glockenspiel on 24 / 24 |
| 7 | belt hum | stamp ×3, board flaps, pipe whooshes | full, fastest passage |
| 8 | room tone | STOP clack, bell | **band stops dead**; bell is the first sound after |
| 9 | clock tick | crane chain, settle, board flap, gate | rebuilds from bass drum |
| 10 | harbour air | lid rolling shut, pencil tick | full, final stamp |

## 8. Type

Big Shoulders Display for plaques and the title, Archivo for cards and subtitles. One language:
each plaque is `[n] METAPHOR | REAL THING`. Subtitles are work tickets, bottom left.

## 9. Where the metaphor simplifies (goes into FACTS.md)

- Memory is drawn as a length on a ruler; real placement uses each model's configured
  `requiredMemory` against the device budget.
- MIG is shown with three schemes of equal slices on a 24 GB card. Real MIG profiles vary by GPU
  model and include mixed layouts; the point shown is only that slice sizes are fixed.
- The swap replaces an 8 GB model with another 8 GB model. Real eviction frees enough memory for
  the incoming model and may sleep or stop more than one.
- Eviction is shown as sleep to host RAM. Models can also be stopped; not every engine can sleep.
- Kubernetes sees static worker Pods holding the GPUs; drawn as an inspector counting two GPUs.
