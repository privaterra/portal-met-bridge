# portal-met-bridge

A local web app for the Mac that records a **Belka Portal**'s conductivity stream alongside a **Meticulous** espresso shot, integrates it against the cup weight, estimates TDS from a per-coffee refractometer calibration, hands the finished brew to **Beanconqueror**, and shows a machine dashboard (status, temperatures, profiles, statistics, device info, connectivity) in the style of the Home Assistant add-on.

It runs entirely on your machine: no account, no cloud, nothing leaves the LAN. Shots live in the browser's IndexedDB (use *Back up all* to export them).

> **Status: early, vibe-coded, lightly tested on one machine.** The Portal driver has not yet been run against a physical Portal by the author. See [How this was built](#how-this-was-built) and [Contributing](CONTRIBUTING.md) before relying on it. Issues and pull requests are welcome.

![Shots view](docs/screenshot-shots.png)
![Machine view](docs/screenshot-machine.png)

## What the Portal actually measures

The Portal is not a refractometer. Its stainless sensor reports **electrical conductivity (EC)** of the liquid passing through it, plus outlet temperature, over Bluetooth LE. EC tracks dissolved ions; a refractometer tracks everything dissolved; the ratio between the two depends on the coffee, the water and the sensor. So:

- the primary number here is **∫EC dm** — conductivity integrated over cumulative cup mass — and its normalisation, **mean EC per gram**;
- **TDS / EY are estimates**, produced only after you have saved refractometer readings for the same bean name. Each estimate carries uncertainty flags: *preliminary* below five reference shots, *extrapolated* outside the measured EC range, *unreliable* when the Portal missed part of the pour.

This follows the approach the Decenza project took for the Portal on Decent machines (mass-weighted EC, proportional `TDS = k × meanEC` with leave-one-out error, affine only when it clearly wins).

## Requirements

- macOS with **Chrome or Edge** (Web Bluetooth; Safari and Firefox do not have it).
- Node ≥ 18 *or* Python 3 to serve the folder. Web Bluetooth only works from a secure origin, and `http://localhost` qualifies — opening `index.html` as a file does not, and neither does a LAN address.
- A Meticulous on the same network. The machine serves its API on **port 80** (nginx in front of the backend; the backend's own 8080 is bound to localhost on the machine). Default address in the app: `192.168.30.2` — change it to yours or to `meticulous.local`.
- Close the Belka app on your phone first: the Portal takes one Bluetooth connection at a time.

## Run it

```bash
git clone https://github.com/privaterra/portal-met-bridge.git
cd portal-met-bridge
./start.command        # or: node serve.mjs   /   python3 -m http.server 8787 --bind 127.0.0.1
```

`start.command` serves on `http://localhost:8787` and opens Chrome. You can also double-click it in Finder (first time: right-click → Open, since it is unsigned).

Then, in the app:

1. **Machine** → enter the machine's IP → Connect. The dot turns green when the socket.io stream is up; the hint shows the machine's saved-shot count once `/api/v1` answers.
2. **Portal** → Connect over Bluetooth → pick *Belka Portal* in Chrome's chooser. The live EC readout starts.
3. Fill in **This coffee** (bean name, dose, grind). Calibration is grouped by bean name.
4. Pull a shot. Recording starts when the machine reports `extracting`, continues for a few seconds after the pump stops (drips), then saves. About four seconds later the app fetches the machine's own saved record of the shot (with stage names: Saturate, Bloom, Gentle Rebuild, Extract…) and swaps it in for the live samples.
5. Measure the cup with your refractometer and type the TDS into **Refractometer reading for this shot** → Save. The calibration for that bean updates, and every other shot of the same bean gets an estimate.
6. **Send to Beanconqueror**: scan the QR with the phone, or *Copy full link* and send it to yourself (Messages, Notes, AirDrop) and tap it there.

The **Machine** tab (top bar) shows live state, stage, shot timer, setpoints, boiler/brew-head/bar/tube/motor temperatures with a five-minute chart, heater and motor power, the profiles on the machine with their images and variables, shot statistics by profile, device info (firmware, image channel, serial, component versions), Wi-Fi status and health, notifications, and read-only settings.

No hardware handy? *Add a demo shot* and *Replay a demo live* exercise everything with a synthetic shot. `node tests/run.mjs` runs the unit tests.

## What is in the box

```
index.html, css/app.css      the page (Shots view + Machine view)
js/portal-ble.js             Belka Portal Web Bluetooth driver
js/meticulous.js             socket.io status/sensors stream + /api/v1 client
js/machine-panel.js          Machine dashboard (status, temps, profiles, stats, device, connectivity)
js/recorder.js               joins both streams on one clock; auto start/stop
js/analysis.js               mass-space integration, tail features, calibration fits
js/beanconqueror.js          ADD_BREW envelope, gzip → base64url → chunked deep link, QR sizing
js/charts.js                 uPlot views (time with stage markers, EC vs mass, calibration)
js/store.js                  IndexedDB
js/demo.js                   synthetic shot
tests/run.mjs                node tests/run.mjs
serve.mjs, start.command     local server / launcher
vendor/                      uPlot 1.6.32, socket.io-client 4.8.4, qrcode-generator 2.0.4 (all MIT)
docs/NOTES.md                protocol findings, with sources
```

## How this was built

This project was **vibe-coded**: the author described what he wanted in conversation and an AI assistant wrote the code, ran it against a mock and against the real machine's REST API, and iterated on screenshots. Nothing here was typed by hand. That is worth knowing when you read the code — it is coherent, but it has had one pair of eyes on it and no field use yet.

**AI used**

- Claude (Anthropic) — model `claude-fable-5-1`, in the Claude app's agentic mode with a Linux sandbox, a headless Chrome for UI checks, and a Chrome extension to read the real machine's API at `192.168.30.2`. Sessions on 2026-11-08.

**What the AI read before writing**

- [variegated-coffee/variegated-rs](https://github.com/variegated-coffee/variegated-rs/tree/main/crates/variegated-belka-portal-trouble-driver) — the Rust Belka Portal BLE driver (MIT, Magnus Nordlander). Source of the service/characteristic UUIDs, the 13-byte notification layout and the two display commands.
- [janhcla/Decenza](https://github.com/janhcla/Decenza) (fork of [Kulitorum/Decenza](https://github.com/Kulitorum/Decenza), GPL-3.0) — the Portal integration for Decent machines, especially `src/ai/portaltailanalyzer.h/.cpp` and `openspec/specs/belka-portal/spec.md`. The mass-weighted analysis and calibration *approach* were learned from it; the code here is an independent JavaScript implementation, not a port, so no GPL code is included.
- [MeticulousHome/meticulous-backend](https://github.com/MeticulousHome/meticulous-backend) — the machine's Tornado/socket.io backend: event payloads, REST routes, shot file format.
- [nickwilsonr/meticulous-addon](https://github.com/nickwilsonr/meticulous-addon) — the Home Assistant add-on (MIT). Source of the port-80 finding and the sensor catalogue the Machine view mirrors.
- [hessius/MeticAI](https://github.com/hessius/MeticAI) — how another tool talks to the machine's history API.
- [graphefruit/Beanconqueror](https://github.com/graphefruit/Beanconqueror) `docs/brew-import-api.md` — the `beanconqueror://ADD_BREW` hand-off contract, decoder limits and envelope schema.
- Belka's product page and Kickstarter FAQ, and the Daily Coffee News write-up, for what the device measures.

**Libraries (vendored, all MIT)**

- [uPlot](https://github.com/leeoniya/uPlot) 1.6.32 — charts
- [socket.io-client](https://github.com/socketio/socket.io-client) 4.8.4 — the machine's live stream
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 — QR for the Beanconqueror link

No build step, no framework, no bundler: plain ES modules served statically.

**Platform APIs**: Web Bluetooth (Portal), `fetch` + socket.io over CORS (machine), `CompressionStream` (gzip for the hand-off), IndexedDB (storage).

**To replicate or extend with an AI assistant**, the prompts that mattered were, roughly: (1) the four source links above plus "build a tool to integrate the Portal with the Meticulous, graph it, show TDS, integrate with Beanconqueror"; (2) "the machine is at 192.168.30.2" (which surfaced the port-80 issue); (3) "add graphs of real-time brewing data, machine status, profiles, statistics, device info, connectivity" — the add-on's feature list. Give the assistant the machine's real `/api/v1/machine`, `/api/v1/history/last`, `/api/v1/profile/list`, `/api/v1/wifi/config` and `/api/v1/settings` responses early; the saved shot JSON contains bare `NaN` tokens that break strict parsers, which is the kind of thing only real data reveals.

## Protocol notes

See [docs/NOTES.md](docs/NOTES.md) for the Portal BLE layout, the Meticulous endpoints as observed on firmware 0.2.24 (beta), and the Beanconqueror envelope. Short version:

| | |
| --- | --- |
| Portal service / measurement / command | `0x7400` / `0x7410` (notify, 13 bytes: EC f32, internal °C f32, outlet °C f32, status u8) / `0x7420` (write `40 00 01 2D` show graph, `40 00 01 2E` hide) |
| Meticulous | `http://<ip>/` port 80; socket.io `status` (~10 Hz) and `sensors`; `GET /api/v1/machine`, `/history/stats`, `/history/last`, `/profile/list`, `/settings`, `/wifi/config`; `POST /api/v1/history` |
| Beanconqueror | `beanconqueror://ADD_BREW?len=N&shareBrew0=…` — `base64url(gzip(JSON))`, 400-char chunks; **no TDS field**, so the estimate goes in the note and `imported.params` |

## Known limits

- Web Bluetooth has no background mode: keep the tab open while pulling shots.
- The QR code carries a thinned trace (≈30 points) so phones can read it; the copied link is full resolution.
- Beanconqueror only accepts the deep link on its own device (phone/iPad).
- The Portal driver is written from the protocol source and a second project's on-device verification, not from the author's own Portal. The first live connection may need the lag and settle settings tuned.
- The machine's saved shot carries the external-probe temperatures but no "brew temperature" field; the live stream's `sensors.t` is kept when the saved record is attached.
- Everything about EC → TDS is empirical. Keep the same Portal, water and mounting while you collect references, and expect k to shift between coffees.

## License

MIT — see [LICENSE](LICENSE). Vendored libraries keep their own MIT licenses in `vendor/`.
