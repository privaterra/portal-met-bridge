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

## Ideas not done yet

- Read the Portal's status byte on a real unit to decide whether it is a battery percentage.
- Sensor calibration with Belka's solution is a device-side procedure; no command for it is known.
- A `/api/v1/action/*` panel (start/stop/tare/preheat) — deliberately left out of a first release of a tool that is mainly a logger.
- Export the calibration table (bean, k, n, LOOCV) as CSV.
- A small "machine shot browser" that pulls any past shot from `/api/v1/history` (not just the last) and lets you attach Portal recordings after the fact.
- Ensure Github commits are signed.