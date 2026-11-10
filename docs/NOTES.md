# Protocol and integration notes

Collected while building portal-met-bridge, 2026-11-08. Everything below comes from the public repositories cited or from the author's own machine; the Portal BLE layout has been verified on hardware by the Decenza project, not by this project yet.

## Belka Portal (Bluetooth LE)

Source: [variegated-coffee/variegated-rs](https://github.com/variegated-coffee/variegated-rs), crate `variegated-belka-portal-trouble-driver` (MIT, Magnus Nordlander), mirrored by Decenza in `src/ble/protocol/belkaportalprotocol.h`.

- The Portal measures **electrical conductivity (EC) and temperature**, not refractive index. Belka's page lists EC as a "concentration indicator"; the companion app shows EC, temperature, flow and weight. There is no TDS in the protocol.
- One BLE central at a time: close the Belka phone app before connecting from elsewhere.

| Item | Value |
| --- | --- |
| Service | `0x7400` (16-bit UUID) |
| Measurement characteristic | `0x7410`, read + notify, **13 bytes** |
| &nbsp;&nbsp;bytes 0–3 | EC, `f32` little-endian, units presumed mS/cm |
| &nbsp;&nbsp;bytes 4–7 | internal temperature (?), `f32` LE |
| &nbsp;&nbsp;bytes 8–11 | outlet temperature °C, `f32` LE |
| &nbsp;&nbsp;byte 12 | status byte; looks like battery but semantics unverified, so shown raw |
| Command characteristic | `0x7420`, write **with response**, 4 bytes |
| Show graph on the Portal's screen | `40 00 01 2D` |
| Hide graph | `40 00 01 2E` |

The command bytes are written exactly as captured in Apple PacketLogger — they are *not* little-endian like the floats. The Portal acknowledges the write and never says whether it understood it.

Decenza's EC → TDS method (fork janhcla/Decenza, tag `portal-calibration-20261101`): mass-weighted integral ∫EC dm over cumulative cup weight; `meanEcPerG = ∫EC dm / covered mass`; proportional model `TDS% = k · meanEcPerG` with leave-one-out error; affine model only when it clearly wins; estimates flagged below 5 reference shots or outside the measured EC range; EC never presented as TDS without calibration; slow-wetting, thermal and gap gates exclude a shot from the reference set. `js/analysis.js` is an independent JavaScript implementation of the same idea.

## Meticulous (observed on firmware 0.2.24-475, image 2026M1510-beta)

Source: [MeticulousHome/meticulous-backend](https://github.com/MeticulousHome/meticulous-backend) plus the author's own machine on his LAN. The [nickwilsonr/meticulous-addon](https://github.com/nickwilsonr/meticulous-addon) README/code was the hint for the port.

- **Port 80.** nginx on the machine fronts the backend's REST and socket.io. The backend process listens on 8080 bound to `127.0.0.1`, so `:8080` is unreachable from the LAN. CORS is `*`, so a page on `http://localhost` can call the machine directly.
- socket.io `status` (~10 Hz): `{ name, state, extracting, time (ms since shot start, -1 idle), profile, profile_time, sensors: { p bar, f ml/s, w g, t °C, g gravimetric ml/s }, setpoints: { active, pressure?, flow? }, loaded_profile, id }`.
- socket.io `sensors` (same cadence): `{ t_ext_1, t_ext_2, t_bar_up, t_bar_mu, t_bar_md, t_bar_down, t_tube, t_motor_temp, lam_temp, p, a_0..a_3, m_pos, m_spd, m_pwr, m_cur, bh_pwr, bh_cur, w_stat, motor_temp, weight_pred, weight_kalman, weight_pred_kalman }`.
- Other events: `settings`, `notification`, `profile`, `profileHover`, `action`, `button`, `OSUpdate`, `calibrate`.
- `GET /api/v1/machine` → `{ name, hostname, firmware, mainVoltage, serial, color, batch_number, build_date, software_version, image_build_channel, image_version, repository_info{component:{branch,commit}}, version_history[], tare_behavior_supported, disturbance_resilience, pour_over_profiles_supported, … }`.
- `GET /api/v1/history/stats` → `{ totalSavedShots, byProfile: [{ name, count, profileVersions }], mileage }` (mileage = ESP lifetime counter).
- `GET /api/v1/history/last` → `{ id, db_key, time (epoch s), file, debug_file, name, profile_name, push_to_brew_time, profile{ id, name, temperature, final_weight, stages[], variables[], display{…} }, data: [{ time ms, profile_time, status, shot{ pressure, flow, weight, gravimetric_flow, setpoints{active,…} }, sensors{ external_1, external_2, bar_up, bar_mid_up, bar_mid_down, bar_down, tube, motor_temp, lam_temp, motor_position, motor_speed, motor_power, motor_current, bandheater_power, bandheater_current, pressure_sensor, adc_0..3, water_status, motor_thermistor, … } }] }`. ~7.5 samples/s. Stage names on the author's profile: `Saturate`, `Bloom`, `Gentle Rebuild`, `Extract`, then `retracting`. **The JSON contains bare `NaN` tokens** (seen in `sensors.motor_speed`); strict parsers must replace `: NaN` / `: Infinity` before parsing.
- `POST /api/v1/history` body `{ query, ids, start_date, end_date, order_by: ["date"], sort: "desc", max_results, dump_data }` → `{ history: [...] }`.
- `GET /api/v1/profile/list` → array of `{ id, name, author, author_id, temperature, final_weight, last_changed (epoch s), version, variables: [{ name, key, type, value }], display: { accentColor, description, shortDescription, image: "/api/v1/profile/image/<hash>.jpeg" } }` (stages omitted unless `?full=true`).
- `GET /api/v1/settings` → flat object: `enable_sounds, heat_on_boot, heating_timeout, auto_start_shot, auto_purge_after_shot, tare_behavior, disturbance_resilience, partial_retraction, update_channel, idle_screen, time_zone, clock_format_24_hour, ssh_enabled, usb_mode, profile_order[], …`.
- `GET /api/v1/wifi/config` → `{ config: { mode, apName, apPassword }, status: { connected, connection_name, gateway, routes[], ips[], dns[], mac, hostname }, health: { link_connected, has_ipv4, gateway_reachable, dns_resolves, internet_reachable, ap_active, degraded, message, … }, known_wifis }`. Note that `apPassword` is in this response — don't log it.
- `GET /api/v1/notifications`, `POST /api/v1/notifications/acknowledge`; `GET /api/v1/action/{start,stop,continue,preheat,tare,…}` (not used by this app).

## Beanconqueror hand-off

Source: [graphefruit/Beanconqueror](https://github.com/graphefruit/Beanconqueror) `docs/brew-import-api.md`.

- Deep link `beanconqueror://ADD_BREW?len=N&shareBrew0=…&shareBrew1=…` (batch: `ADD_BREWS`, ≤ 50 brews). Payload = `base64url(gzip(JSON))`, unpadded, split into 400-character chunks, ≤ 1,024 chunks, inflated ≤ 512 KiB per brew.
- Envelope v1: `app{name,version}`, `brew{date ISO, doseIn{g}, waterIn{ml} (required), beverageOut{g} (required), brewTime s (required), temperature °C, grindSize, grinderName, grinderRpm, preparationMethod (required), preparationType e.g. "METICULOUS", bloomTime, firstDripTime, rating 0–10, note}`, optional `bean{name, roaster, roastingDate, origin, …}`, `flow{fidelity full|downsampled, t[] delta ms, waterDispensed[] delta decigrams, weight[] delta decigrams, temperature[] absolute}`, `metrics[]{key, name, unit, kind measured|target, t[] absolute ms, v[]}` (≤ 100 metrics, ≤ 10,000 points each), `imported{source, sourceName, sourceUrl https, device, schema, params}` (required).
- **No TDS field.** The estimate goes in `brew.note` and `imported.params`; the EC trace is sent as a custom metric. Type the refractometer value into Beanconqueror's own TDS field for its EY.
- Beanconqueror has native Meticulous support (same socket.io `status` payload) and BLE refractometer support (DiFluid R2), but no Belka Portal support.

## Web Bluetooth on macOS Chrome (what the app relies on)

- `navigator.bluetooth.requestDevice({ filters: [{ services: [0x7400] }, { namePrefix: 'PORTAL' }, …], optionalServices: [0x7400] })` — filters are OR-ed; a 16-bit alias is accepted for the service. The variegated firmware and Decenza both identify a Portal by the advertised `0x7400`, so the service filter should match; the name prefixes are belt-and-braces (Decenza labels an unnamed Portal "PORTAL").
- `requestDevice` must run inside a user gesture (the Connect button) and shows Chrome's own chooser; nothing on the page can pick for you.
- `getAvailability()` returns false when Bluetooth is off **or** Chrome lacks the macOS Bluetooth permission; the Connection check surfaces this before the chooser.
- `writeValueWithResponse` is used for the 4-byte display commands (the Portal expects write-with-response).
- No background mode: notifications stop when the tab is discarded, so keep the tab open during a shot.
- `tests/fake-bluetooth.js` is a minimal stand-in for `navigator.bluetooth` that covers exactly this surface, useful for any other Portal tool written for the browser.

## File System Access API (log / export folder)

- `window.showDirectoryPicker({ mode: 'readwrite' })` needs a user gesture and Chrome/Edge; Safari and Firefox have no directory picker, so the app falls back to downloads.
- The returned `FileSystemDirectoryHandle` is structured-cloneable and is stored in IndexedDB; after a browser restart `queryPermission()` returns `prompt` and `requestPermission()` must again run inside a user gesture (the *Re-allow folder* button).
- Appending: `getFileHandle(name, { create: true })`, `createWritable({ keepExistingData: true })`, `seek(file.size)`, `write`, `close`. The log flushes every 3 s and on `beforeunload`.
- Removing the app's files: `folder.removeEntry('portal-met-bridge', { recursive: true })`; only that subfolder is ever touched. `BluetoothDevice.forget()` (Chrome 110+) drops the pairing permission; `indexedDB.deleteDatabase()` never settles while another tab holds the database open, so the wipe reports that case instead of hanging.
- `tests/fake-folder.js` stands in for all of this in tests.

## Settings save model (v0.7)

Before v0.7 every setting input saved on its `change` event, i.e. on blur. Typing an address and pressing Enter, reloading, or closing the tab never blurred the field, so the value was lost and the Shots-tab address kept the old value — the bug reported as "the machine address does not change on the main screen". There is no `<form>`, so Enter did nothing.

Now: toggles and `<select>`s still commit on change; text and number inputs are compared against the stored value on every keystroke (`dirtySettings()`), listed in the save bar, and committed only by Enter, ⌘/Ctrl+S, the Save button, or `showView()` leaving Settings (`saveAllSettings({quiet:true})`). `beforeunload` warns while something is pending. Every commit funnels through `flashSaved(keys)`, which keeps the keys saved during the current 4 s flash so the button can report fields that landed a moment earlier. `applySetting('meticulousHost')` updates `#meticulous-addr` and reconnects.

## Shot persistence (v0.8)

Record of truth is IndexedDB (`shots` store). Lifecycle of a live shot:

1. `extracting` rises → `ShotRecorder` starts; every `sample` event calls `checkpointLiveShot()`, which at most every 2 s writes a snapshot `{…shot, inProgress: true, checkpointAt}` under the shot's final id. The first checkpoint makes the row appear in History as "recording now…".
2. Pump stops → settle window → `shot` event. The handler awaits any checkpoint write still in flight, then overwrites the id with the finished record (`inProgress` removed). Too-short recordings delete their checkpoint instead.
3. `autoSaveFiles` (default on): JSON + CSV written to `<folder>/portal-met-bridge/shots/<base>.json|csv` via `log.saveFile`; `shot.files = {json, csv, at}`. Repeated after the machine record attaches (same names, overwritten).
4. `autoAttach`: after `attachDelaySec`, `/history/last` is matched by time (±45 s) and swapped in. Shots that still lack `machineSource` after 7 days-worth of lookback get `backfillMachineRecords()` 1.5 s after every machine connect: `POST /history` (60 newest, no data) → match by time → `shotById` for the data.
5. On start, `recoverUnfinishedShots()` runs `finalizeCheckpoint()` over any `inProgress` rows (pure, in `recorder.js`): duration = last sample time, `recovered: true`, `endedAt = checkpointAt`. Fewer than 5 samples → dropped.
6. `beforeunload` warns while recording and fires one last best-effort checkpoint.

History (`renderHistory`) is a plain sorted/filtered render of `state.shots` (the `listShots()` result, 200 newest); TDS column = reading, else `estimateShot()` over the cached analysis summary. Edits go through `openShotDialog/saveShotDialog`, deletes through `deleteShots()` + `confirmDialog()`. The "This coffee" fields write into the selected shot only while it is the newest one.

## Beverage weighed vs. machine weight (v0.8.2, reworked in v0.10)

`shot.finalWeightG` is what the machine's scale reported (max cup weight during the shot) and is never edited. `shot.beverageG` is optional: the cup weight the user measured on their own scale, entered in History → Edit or with a refractometer reading. `beverageOf(shot)` (analysis.js) is what yield, EY, the ratio, the summary CSV (`beverage_g`, next to `beverage_source`, `profile_target_g` and `machine_weight_g`), the PDF and the Beanconqueror `beverageOut` use. The History row marks a value other than the scale's with ⚖ (weighed) or ◎ (profile target), tooltip showing the scale's value; the Shots header says "41.5 g out (weighed; machine 40.0 g)". Analysis and calibration stay in machine-mass space: EC is integrated against the scale's curve, not the hand weight.

Up to v0.9 a cup weighed together with a reading was stored only as `refractometer.beverageG`, and `beverageOf` fell back to it. v0.10 drops that: `store.promoteLegacyBeverage()` runs once (`beveragePromoted` setting) and copies such values to `shot.beverageG` when they differ from `finalWeightG` by ≥ 0.25 g (equal values were the app's own fallback, not typed). New readings store only `tdsPct`, `eyPct` (a snapshot) and `at`; `measuredEy(shot)` recomputes EY from the current beverage wherever it is shown, so switching the beverage default never leaves a stale EY.

## Profile target as the beverage (v0.10)

The machine stops the pump at the profile's `final_weight`, so the cup ends at that target plus drips; the scale's reading during the shot misses the drips and is noisy. `beverageSource(shot)` resolves `'weighed'` (`beverageG`) → `'profile'` (`profileTargetOf(shot)`, when the module preference is `'profile'`) → `'scale'` (`finalWeightG`) → `'profile'` again if the scale has nothing. `setBeveragePreference('profile'|'scale')` is the module-level switch fed by the `beverageDefault` setting (`#set-beverage-default`, Settings → Recording → Beverage weight; default `'profile'`); since export.js and beanconqueror.js import the same module instance, the hand-off and CSV follow automatically. `beverageDefaultOf(shot)` is the resolution ignoring `beverageG`, used for placeholders and the EY of a blanked field.

`profileTargetOf(shot)` reads `shot.profileTargetG`, else `shot.machineSource.profile.final_weight` (so every earlier shot with its record attached gets the target without a migration). `profileTargetG` is stamped in three places (main.js): at the recorder's `recording` state from `state.profileTargets` — a `Map` name → `final_weight` filled by `refreshProfileTargets()` from `GET /api/v1/profile/list` on every machine connect and whenever a name is missing (the profile name itself can arrive a few status packets late, so the `sample` handler re-applies); at the final save as a last chance; and in `attachMachineRecord()` from `saved.profile.final_weight`, which is what was actually brewed and so overrides the list. The live header shows "Profile: X · target 38.0 g" once known. `tests/mock-meticulous.mjs` brews a 38 g target while its demo shot's scale ends at 40 g so the two are told apart in the e2e.

## Grind column (v0.10)

`context.grindSize` is stored as the string the forms build ("420 µm"); `grindMicrons(context)` (analysis.js) parses it (also bare numbers) for the sortable History column (`data-sort="grind"`, after Profile) and the search haystack.

## AI review (v0.11)

`js/review.js` does everything deterministic so the model interprets rather than computes. `buildShotDigest(shot, analysis)` splits the machine samples into stages by the `status` name the machine sends with every sample (`splitStages`; idle / click to start / heating / retracting are not stages, and the first retracting sample marks the pump stop), and for each stage reports time span, water in (∫ flow dt, as the hand-off does), cup start → end and rate, pressure start / max (and when) / end / slope, mean and max flow, water temperature start → end, EC at the boundaries (Portal time shifted by the shot's lag); then first drop (cup ≥ 0.5 g), pump stop, drips after the pump, total water, water before the first drop, temperature start / min / max / end, and — when the Portal was there (≥ 10 samples and a weight curve) — the EC summary: mean EC/g, ∫EC dm, peak and where, final EC, coverage, mass at 90 % of the integral, the last-5 g tail, the Portal's outlet temperature, and the share of ∫EC dm by stage end and at 5 g cup-mass milestones (from `analysis.curve`). A `gaps` list names what is missing (no dose, no grind, no machine samples, **no Portal data**, no temperature, record not attached), and a `series` table gives one row per second (t, pressure, flow, cup, temperature, EC). Shots without Portal data go through the same path with `ec: null`, so the review falls back to the machine's data by design. `compactProfile()` strips the record's profile to name, temperature, final weight, description, variables and stages (dynamics, exit triggers, limits) — no image, no ids.

`buildReviewMessages(shots, options)` returns `{ system, user }`. The system prompt is the method of the "Meticulous espresso profile review" query (read the setup → stage by stage against the profile's design → where the extraction happened → cross-check the records → judge → recommend one change per shot in grinder steps; several shots → series first) and the report template taken from the Shot review doc (Verdict · Shots compared · Stages table · What stands out · Suggested changes · Open questions · Sources, with the rules: use the digest's numbers, never invent, no title/preamble, don't describe the chart). The user message carries the grinder step, usual drink, standing notes, taste, question, and per shot the gaps, the digest JSON (minus the series), the profile JSON and the series JSON. `approxTokens` (chars ÷ 3.6) feeds the size note. `renderMarkdown` is a small escaping renderer (headings shifted down one level, lists with one nesting level, tables, code, blockquotes, bold/italic/code, http(s) links only).

`js/ai.js` holds the three providers: `buildRequest` (Anthropic `/v1/messages` with `anthropic-dangerous-direct-browser-access: true`, OpenAI `/v1/chat/completions`, Gemini `:streamGenerateContent?alt=sse` with `x-goog-api-key`; **no `temperature`/`top_p` unless passed explicitly** — v0.11.2, after Opus 5.5 answered `400 · \`temperature\` is deprecated for this model`; the current reasoning models on every provider refuse sampling knobs, and a review does not need them), `isParamRejection` + `stripOptionalParams` (a 400 whose message names a sampling parameter → the same request once more without `temperature`/`top_p`/`top_k`, also inside Gemini's `generationConfig`; any other 400, or a second refusal, is reported as is; `onRetry` lets the app log it), `deltaFromEvent` per provider, `makeSseParser` (events split on blank lines, multi-line `data:` joined), `streamCompletion` (falls back to a plain JSON body when the response is not an event stream), `listModels` + `normalizeModelList` (text models only, newest first; OpenAI-compatible servers keep their own ids), `testKey` (a one-word reply), `maskKey`. Defaults: `claude-sonnet-5-5`, `gpt-6.1-sol`, `gemini-3.8-flash`; the OpenAI base URL is overridable (`aiBaseOpenai`) for OpenRouter / local servers, which is also how the e2e drives the mock (`tests/mock-meticulous.mjs` answers `/v1/models` and `/v1/chat/completions` with SSE and echoes the shot count and the no-Portal flag it saw in the prompt).

Settings: `aiProvider`, per provider `aiKey…` (`secret: true` → masked in the log, excluded from `settingsDocument()`), `aiModel…`, `aiBaseOpenai`, `aiGrindStepUm`, `aiDrink`, `aiNotes`; all in the `SETTINGS` table so the save bar, Enter/⌘S and import/reset apply. Keys live only in IndexedDB `settings`. Saved reviews are a new `reviews` store (DB v4: `{ id, createdAt, title, shotIds, shotLabels, provider, model, taste, question, markdown, digests (no series), durationMs, app }`), included in `exportAll()/importAll()` and the erase dialog. The Analysis view (`an` state in main.js): picker over `state.shots`, digest tables + a second `TimeChart`, streamed Markdown re-rendered every 150 ms, Stop (AbortController), Save/Download/Copy, saved list with Open/.md/Delete. History's *Analyze selected* calls `openAnalysis(ids)` (≤ 8).

## Brew from the app (v0.11)

`meticulous.action(name)` → `POST /api/v1/action/<name>` (backend `api/action.py`: ESP actions `start, stop, tare, scale_master_calibration, preheat, continue, finish, home, purge`, backend actions `reset, abort`; 409 when the ESP refuses — busy or a motor-strain alarm — 400 with `allowed_actions` otherwise; `abort` answers with an empty body). `start` is the dial click: from idle the backend sends the last loaded profile to the ESP and the compiled profile's own "click to start" stage waits for a second click, unless the machine's `auto_start_shot` setting skips it. `abort` runs `Machine.end_profile()` — `home` during a shot (piston retracts), `stop` otherwise — which is why the Stop button uses it. `meticulous.loadProfile(id)` → `GET /api/v1/profile/load/<id>` (409 while busy). The rail's Brew block appears on connect, lists `state.profileList` (kept by `refreshProfileTargets`), follows the status stream (`renderBrewState`: "click to start" → *Start brew now*), and never sends anything on its own. The mock plays idle → heating (0.8 s) → click to start on `start`, back to idle on `abort`/`stop`, and records the actions at `/mock/dial`.

## Ratio and compare (v0.9)

`ratioOf(shot)` = `beverageOf(shot) / context.doseG` (null without a dose) feeds the History column, the shot header, the compare legend and the summary CSV (`ratio`). Compare (`openCompare(ids)` in main.js, `CompareChart` in charts.js) overlays up to eight ticked shots (`COMPARE_COLORS`) on one uPlot: series are aligned with `uPlot.join` and drawn with `spanGaps`, so the x grid is the union of every shot's x values. Graph choices are in `COMPARE_SERIES` (mass-based: EC and ∫EC dm from `analyzeShot().curve`; time-based: EC from the Portal samples, cup weight / flow / pressure from the machine samples). For mass-based graphs the x-axis can be grams or brew ratio (x ÷ dose); shots without a dose are listed but not drawn in that view. The chart is rebuilt on every change — the series count varies and uPlot construction is cheap.

## Ideas not done yet

- Read the Portal's status byte on a real unit to decide whether it is a battery percentage.
- Sensor calibration with Belka's solution is a device-side procedure; no command for it is known.
- A `/api/v1/action/*` panel (start/stop/tare/preheat) — deliberately left out of a first release of a tool that is mainly a logger.
- Export the calibration table (bean, k, n, LOOCV) as CSV.
- A small "machine shot browser" that pulls any past shot from `/api/v1/history` (not just the last) and lets you attach Portal recordings after the fact.
