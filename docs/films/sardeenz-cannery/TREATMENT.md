# The Tin Never Changes — treatment

A 60-second explainer of Sardeenz for platform engineers, in the Assembly-Line Diagram style.
English voice and subtitles, 1920×1080, 24 fps.

## 1. Candidate structures

1. **A tour of the components.** Proxy, control plane, dashboard, runners, one station each.
   Complete, but it is the architecture diagram again: no turn, no reason to keep watching.
2. **Before / after.** The same GPU under Kubernetes scheduling (one model per GPU, five idle)
   and under Sardeenz. Clear payoff, but half the film is spent on what Sardeenz is not, and the
   mechanism (park, wake, evict) gets ten seconds.
3. **One order that hits a sleeping model.** Follow a single request. The first one goes straight
   through; the second asks for a model that is asleep while the tin is full. Everything Sardeenz
   does happens because of that one order. **Chosen:** it has a turn, it shows the mechanism in
   the order it really happens, and every station appears only when the cargo needs it.

Opening image: the sealed tin from outside, six fish for three places. Ending: the outside view
again, nothing moved, while we now know what happens inside. Score: a cannery march that stops
dead when the order is parked and restarts when the gate lifts.

## 2. Logline and arc

A request arrives for a model that is asleep in a GPU that is already full, and the cannery
repacks the tin before the client notices more than a slow first token.

- **Setup.** One tin (a GPU's VRAM) with three places, six models to serve. A first order goes
  straight from the proxy to an awake model.
- **Turn.** The next order wants a sleeping model. The proxy does not refuse: it parks the
  connection and rings the control plane once.
- **Ending.** The control plane moves the least recently used model out to host RAM, wakes the
  one that is wanted, the map updates, the gate lifts. From outside, the tin never changed.

## 3. Benchmark

- **Fritz Kahn, *Der Mensch als Industriepalast* (1926).** Learn: one silhouette cut into rooms,
  a colour per circuit, workers as scale. Do not take: the body, the plate layout, the lettering.
- **Powers of Ten (Eames, 1977), last minute.** Learn: one continuous camera move that ends on
  the whole, so the viewer keeps the map in their head. Do not take: the framing square, the
  numbers on the side.

## 4. The factory

The silhouette is a **sardine tin lying on its side** with a rolled key: the GPU. Inside, two
floors of rooms above the tin's packing floor.

| # | Plaque (metaphor / real thing) | What it does in the film |
|---|---|---|
| 1 | DISPATCH DESK / ROUTING PROXY | every order lands here; a clerk reads the board |
| 2 | DEPARTURES BOARD / ROUTING MAP · REDIS | one row per model: AWAKE or ASLEEP |
| 3 | WAITING ROOM / CONNECTION PARKING | gatekeeper with a STOP sign holds the order; one bell cord |
| 4 | FOREMAN / CONTROL PLANE | memory ledger, a clock per model (last used), decides |
| 5 | THE TIN / GPU VRAM | three places, a crane above |
| 6 | PANTRY SHELF / HOST RAM | where a sleeping model is put |

Colour is the legend, one meaning each for the whole film:

- **vermilion** = inference traffic (the order, its pipe, the tokens streaming back)
- **ochre** = control (the bell cord, wake and sleep commands, the crane)
- **teal** = state (the board, the reports going up from the tin)

Models are sardines with a name tag. Awake: eye open, lamp lit above its place. Asleep: eye
closed, lamp off. Palette A of the style (paper, ink, indigo ground, cream walls).

## 5. Shot list

| # | Time | Framing and move | What happens | Why |
|---|---|---|---|---|
| 1 | 0–6 | Wide, static then slow push | The tin from outside. Six sardines queue for three places. The gantry sign drops: SARDEENZ. | Hook is the arithmetic; the title is an object. |
| 2 | 6–10 | Push through the intake hatch | A vermilion order capsule rides the belt in. | Entering the system. |
| 3 | 10–17 | Truck with the cargo | Desk (1) starts, clerk looks up, board (2) row LLAMA = AWAKE; whip down the vermilion pipe to the tin, tokens stream back up. | The hot path is short, so the shot is fast. |
| 4 | 17–26 | Medium, held; band stops | Second order: MISTRAL = ASLEEP. STOP sign up (3). Clerk pulls the bell cord once. Three more orders pile up behind the gate; the bell does not ring again. | The turn. Stillness and silence make the parking readable. |
| 5 | 26–35 | Follow the ochre cord, tilt up | Foreman's office (4): ledger gauge reads FULL, three clocks, one far behind. He points. | Follow one colour = follow the command. |
| 6 | 35–45 | Tilt down, then pull back to the whole floor | The tin (5): crane lifts the sleepy sardine to the shelf (6), lowers MISTRAL in, lamp lights. | Signature shot: the repacking. |
| 7 | 45–51 | Whip up the teal pipe | Board flips to AWAKE, STOP sign drops, parked orders run down the pipe, tokens stream out. | Release after the hold; the fastest shot. |
| 8 | 51–60 | The great pull-back | Whole tin, every number lit. Outside, an inspector with a clipboard (Kubernetes) ticks "1 tin". Nameplate. | Bookend: same outside view, new meaning. |

## 6. Beat sheet and voice

120 BPM, bars of 2 s. The voice says what the picture cannot.

| t | Voice |
|---|---|
| 1.0 | One GPU. Room for three models. You need to serve six. |
| 7.0 | Every request lands at the proxy. |
| 10.5 | It reads the routing map. If the model is awake, the request goes straight through. |
| 18.0 | But this model is asleep. |
| 20.5 | The proxy doesn't refuse. It parks the connection and rings the control plane. Once. |
| 27.5 | The control plane keeps the memory ledger. The tin is full. |
| 32.0 | So it picks the model nobody has asked for the longest. |
| 36.5 | It moves that one out to host RAM, and wakes the one that's wanted. |
| 45.5 | The map updates. The gate lifts. |
| 48.0 | All the client saw was a slow first token. |
| 53.0 | To Kubernetes, nothing moved. |
| 56.0 | Sardeenz: more models than memory. |

## 7. Cue map

- 0–6: woodblock tick and a bassoon figure alone. Sign bounce on bar 3.
- 6–17: clarinet joins at the desk (bar 4), glockenspiel as numbers 1 and 2 light.
- 17.5: **band stops dead** (STOP sign). Clock tick only. Bell at 22.0 is the first sound after
  the silence.
- 26–35: low bassoon and bass drum only, slow; a clock ticks.
- 35–45: march rebuilds, crane chain foley; **second near-silence** at 43.5 as the fish settles,
  then the lamp ding.
- 45–51: full band, fastest passage.
- 51–60: full band, numbers pop in order on glockenspiel, final stamp on the nameplate at 57.

## 8. Sound design

| Section | Ambience | Foley | Music |
|---|---|---|---|
| 1 | harbour air, distant gulls (noise bed) | sign chain, bounce | tick + bassoon |
| 2–3 | belt hum | hatch, desk stamp, board flap, pipe whoosh | + clarinet, glock |
| 4 | room tone only | STOP sign clack, bell, orders bumping the gate | stopped |
| 5 | clock tick | ledger page, gauge needle | low, sparse |
| 6 | belt hum | crane chain, lift, settle, lamp ding | rebuilding |
| 7 | belt hum | board flaps, gate, pipe whoosh ×3 | full |
| 8 | harbour air | pencil tick, nameplate stamp | full, final chord |

## 9. Type

Big Shoulders Display for plaques and title, Archivo for labels and subtitles. One language, so
each plaque is `[n] METAPHOR | REAL THING` with the real component name in the second position.
Subtitles are work tickets, bottom left, stub showing the current station number.

## 10. Where the metaphor simplifies (goes into FACTS.md)

- One worker with one GPU and three equal places. Real workers have several devices and models
  of different sizes.
- Eviction shown as sleep to host RAM (L1). Models can also be stopped; not every engine can sleep.
- The proxy forwards on a Redis pub/sub notification; shown as the board flipping.
- Kubernetes sees static worker Pods; drawn as an inspector who counts one tin.
