# Contributing

Thanks for looking. This is a small, vibe-coded tool (see "How this was built" in the README) and it needs exactly the kind of help a one-person, one-machine project can't give itself.

## Most useful things right now

1. **Run it against a real Belka Portal** and report what you see: does the Chrome chooser list it, do notifications arrive at the expected cadence, what does the status byte do as the battery drains, do the show/hide-graph commands work. Attach a CSV export (Files → CSV) of one shot.
2. **Compare estimates with your refractometer** over 5–10 shots of one coffee, then share the calibration numbers from the Calibration panel (k, LOOCV error, EC/g range). That tells everyone whether a proportional model is enough.
3. **Try it on a different Meticulous firmware** (stable channel, older ESP firmware). The endpoints are documented in `docs/NOTES.md` against 0.2.24-beta; anything that differs is worth an issue.
4. **Beanconqueror imports** — confirm the deep link lands correctly on iOS and Android, and which fields show up.

## Running locally

```bash
node serve.mjs            # http://localhost:8787
node tests/run.mjs        # unit tests (analysis maths, hand-off round-trip)
```

Web Bluetooth needs Chrome or Edge and a `localhost` origin. `window.__pb` exposes the app's state and chart instances in the console while debugging.

To work without hardware, use *Add a demo shot* / *Replay a demo live*, or run a mock machine: the backend protocol is small enough that a 60-line socket.io server covers it (see `docs/NOTES.md` for payloads).

## Code shape

No build step, plain ES modules. Each file in `js/` is one concern; `analysis.js` and `beanconqueror.js` are pure (they run in Node for the tests) and should stay that way. Keep vendored libraries pinned and their licenses in `vendor/`.

Please keep these invariants:

- EC is never displayed as TDS without a calibration, and estimates always carry their flags.
- Nothing is sent anywhere but the machine on the LAN and the Portal over BLE.
- The app never sends `/api/v1/action/*` commands unless a future feature explicitly adds a control panel with confirmation.

## Pull requests

Small and focused, with a sentence on what you tested it against (firmware version, Portal yes/no, browser). If an AI assistant wrote part of the change, say so in the PR — it helps reviewers know where to look harder.

## License

By contributing you agree your contribution is MIT-licensed like the rest of the project.
