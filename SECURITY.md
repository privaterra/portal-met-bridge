# Security

## Reporting a problem

Please report a vulnerability privately: on GitHub, **Security → Report a vulnerability** on this repository (private vulnerability reporting is on). Say what you did, what happened and which version (Settings → About). You will get an answer there; a fix ships as the next patch release and the advisory is published with it. For anything that is not sensitive, an ordinary issue is fine.

Only the latest release is supported — the project is in alpha and every release replaces the one before.

## What this app is, and what it trusts

portal-met-bridge is a web page plus a small static server (`serve.mjs`). It has **no accounts and no passwords**: it is meant for one household.

| Part | Runs where | Talks to | Holds |
| --- | --- | --- | --- |
| The page | your browser (Chrome/Edge) | the Portal over Bluetooth, the Meticulous over your LAN, the AI provider you chose over https | shots, settings and **your AI API keys**, in that browser's IndexedDB |
| `serve.mjs` | your Mac (localhost only), or the Home Assistant app (your LAN) | the page; the machine, when the page asks it to relay; the files in its data folder | shot files, exports, reports, backups, the debug log — never API keys |

What that means in practice:

- **On a Mac** the server listens on `127.0.0.1` only. Other devices cannot reach it.
- **In Home Assistant** it listens on your LAN (ports 8787 and 8788). Anyone on that network can open the page, read and write the files in its data folder (`/share/portal-met-bridge`), use the relay to reach the machine, and stop the app. That is the same trust the espresso machine itself extends — its API has no login either — but do not forward these ports to the internet, and put the app behind a reverse proxy with authentication if your LAN has people on it you would not hand the machine to.
- **API keys never leave the browser** except to the provider they belong to. They are not in *Export settings*, not in backups, not in the files the server writes, and not in the log (which shows a masked form). Anyone with access to the browser profile can read them, as with any saved credential; create keys with a spending limit.
- **The AI review** sends the digest of the shots you selected (numbers, profile, coffee names, your notes) to the provider you configured. Nothing is sent until you press *Review*.
- **A custom OpenAI-compatible endpoint** receives your OpenAI key with every request. The page says where the key will go, warns when the address is plain http on the internet, and a settings file can never change this address (below).

## What it defends against

The realistic attacker is not someone on your LAN but **a web page you visit while the app is running**, and **data that arrives from outside** (the machine's answers, a backup or settings file from someone else, the AI model's text).

| Threat | Defence |
| --- | --- |
| A website makes your browser call the local server: stop it, **start a brew through the relay**, probe your LAN, write files (cross-site request forgery) | `serve.mjs` refuses any `api/` or `machine/` request — and any WebSocket — that the browser marks as coming from another origin (`Origin`, `Sec-Fetch-Site`). Requests without those headers are not from a browser. |
| A website re-points its own name at `127.0.0.1` and so becomes "same origin" with the server (DNS rebinding), then reads your data folder | The server answers only to names that cannot be forged that way: IP addresses, `localhost`, single-label and `.local`/`.lan`/`.home`/`.internal` names, the computer's hostname, the names in its TLS certificate. Any other name gets `421` and must be listed in `ALLOWED_HOSTS` (Home Assistant: the `allowed_hosts` option). |
| Text from the machine, a backup, a coffee name or the AI's report contains markup that runs as script in the page (and reads your API keys) | Everything from outside is escaped where it is shown; imported backups are normalised to the app's own types first; the report is parsed as Markdown into escaped HTML with only `http(s)` links. Behind that, a **Content-Security-Policy** (`script-src 'self'`, no inline script, no `eval`) means markup that slipped past an escape still cannot execute. |
| A file in the data folder (`.html`, `.svg`) is opened from the server and runs as the app | Data files are served as downloads with a neutral type, `nosniff`, and a `sandbox` policy. |
| The page is framed by another site and you are tricked into clicking *Start brew* | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| The server hands out more than the app: `.git/`, tests, tools | Only `index.html`, `css/`, `js/`, `vendor/`, `assets/`, `docs/`, `LICENSE` and `README.md` are served; dot-files never. |
| A symbolic link in the data folder leads a read, write or delete elsewhere | Paths are checked against the real filesystem after links are followed. |
| The relay is used to reach things that are not espresso machines | Private addresses and LAN names only; never a cloud metadata address or Home Assistant's Supervisor; the machine's answers cannot set cookies or policy for the app, and its HTML is sandboxed; your cookies and credentials are not forwarded. |
| A settings file from someone else redirects your API key | Import skips the endpoint (and never reads keys); the page tells you it did. |
| A spreadsheet runs a formula hidden in an exported CSV | Fields starting with `=`, `+`, `-`, `@` are neutralised (CWE-1236). |
| A shipped library has a known vulnerability, or is silently replaced | See the next section. |

The Content-Security-Policy, directive by directive (it is the `<meta>` in `index.html`; `serve.mjs` sends the same as a header and adds `frame-ancestors 'none'`):

- `default-src 'self'`, `script-src 'self'` — only this app's own script files; no inline script, no `eval`, nothing from a CDN.
- `style-src 'self' 'unsafe-inline'` — the charts and tables set inline styles; styles cannot run code.
- `img-src 'self' data: blob: http: https:` — chart snapshots, the QR code, and the profile images the machine serves.
- `connect-src 'self' http: https: ws: wss:` — the machine is at an address you type, and the AI provider or a local model is one you choose, so connections cannot be narrowed further.
- `worker-src 'self' blob:`, `font-src 'self' data:`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.

## Libraries: what is shipped, how it is kept current, how advisories surface

The app has no build step. Five libraries are copied into `vendor/` from their npm packages, byte for byte, and loaded directly:

| Library | Used for | What the app calls |
| --- | --- | --- |
| uPlot | the charts | plotting only |
| socket.io-client | the machine's live status stream | a WebSocket to the machine (or the relay) |
| qrcode-generator | the Beanconqueror QR code | SVG output |
| jsPDF | PDF reports and reviews, loaded only when a PDF is asked for | `text`, lines and rectangles, `addImage` with JPEGs the page rendered itself, `save` — **not** `html()`, AcroForm, `addJS`, annotations or opening a new window, which is where its advisories have been |
| fflate | zip exports and `.docx` reviews | `zipSync` |

Because the files are copies, GitHub's Dependabot could not see them: the Security tab showed no alerts while `vendor/` held jsPDF 2.5.2, which had twelve published advisories. Four things now close that gap:

1. **`vendor/manifest.json`** records, for every file, the package, version, the file inside the package and its SHA-256. `node tools/vendor.mjs verify` — part of the unit tests — fails if a file is missing, edited or unlisted.
2. **`vendor/package.json`** (generated from the manifest) lists the same versions as an ordinary npm manifest, so GitHub's dependency graph and **Dependabot alerts** cover them.
3. **`node tools/vendor.mjs check`** asks npm's advisory database (the GitHub Advisory Database) about exactly the shipped versions and lists newer releases. It runs
   - on every push and pull request (`.github/workflows/ci.yml`) — an open advisory turns the commit red, with the advisory and its fix in the job summary;
   - before a tag is made (`tools/tag-release.sh`) and before a release is built (`.github/workflows/release.yml`) — a high or critical advisory stops the release.
4. **`node tools/vendor.mjs update`** fetches the latest version of every library (npm verifies each download's integrity), copies the files and rewrites the manifest. The **Dependency updates** workflow does this every Monday, runs the unit and end-to-end tests against the result, and opens a pull request; if an advisory remains that no update fixes, it opens an issue.

An advisory that does not apply to how the app uses a library can be recorded in `vendor/advisories-accepted.json`, with a reason and an end date after which it counts again:

```json
{ "accepted": [ { "id": "GHSA-xxxx-xxxx-xxxx", "reason": "only reachable through html(), which the app never calls", "until": "2027-03-01" } ] }
```

Everything else that is fetched is fetched fresh, and checked:

- **Node for the macOS app**: the newest release of the current LTS line at build time, verified against nodejs.org's `SHASUMS256.txt` (`tools/package-macos.sh`).
- **The Home Assistant image**: the current `ghcr.io/home-assistant/base` for its Alpine line, with `apk upgrade` at build so OpenSSL and Node are at their latest patch level.
- **GitHub Actions and development tools** (Playwright, socket.io for the mock machine — never shipped): Dependabot opens weekly pull requests (`.github/dependabot.yml`); `npm audit` on them is part of `vendor.mjs check`, as a note.
- **The projects the protocols come from** (`vendor/sources.json`: the Portal driver in variegated-rs, the machine's backend, Decenza, Beanconqueror and others): the weekly workflow lists their commits since they were last read against this app and opens an issue when there are any; `node tools/vendor.mjs sources --record` marks them read.

The workflows themselves: the token is read-only except in the one job that creates the release; nothing typed by a person (a tag name, an input) is pasted into a shell script; the release is made with GitHub's own CLI, so no third-party action holds a write token.

## The review of 13 November 2026 (fixed in 0.19.0)

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | High | The server checked neither `Origin` nor `Host`. Any website open in the same browser could `POST` to it: stop it, call the machine through the relay — **including starting a brew** — and use the relay to probe the LAN; with DNS rebinding, read and write the data folder. | Cross-site requests and unknown host names are refused (`crossSite()`, `hostAllowed()`), for REST and for the WebSocket upgrade. |
| 2 | High (by advisory) | jsPDF 2.5.2 in `vendor/` carried twelve advisories, two critical. The functions they concern are not the ones the app calls, but nothing would have told anyone when one was. | jsPDF 4.2.1; the manifest, check and update tooling above. |
| 3 | Medium | Files in the data folder were served with their own type from the app's origin: an `.html` placed there ran as the app. | Served as downloads, typed as data, sandboxed. |
| 4 | Medium | The static server served the whole folder — `.git/`, tests, tools, `package.json`. | An allowlist of the app's own folders. |
| 5 | Medium | *Import settings* applied the OpenAI-compatible endpoint from the file: a settings file from someone else could send your stored key to their server at the next review. | The endpoint is never imported; the page says so, and warns about plain-http endpoints. |
| 6 | Medium | The Analysis tab's *What the review will read* panel wrote a shot's **profile name** into the page unescaped. A profile name comes from the machine — and profiles are shared between people — so a profile named with markup would have run script in the page (which can read the stored API keys) when a shot brewed with it was ticked for review. Found by the end-to-end test that restores a backup with markup in every field. | Escaped; the policy below would now block it regardless; the test walks every view. |
| 7 | Low | Two attribute values (`data-id`, a file path in a tooltip) were written unescaped; a restored backup was stored as it came. | Escaped; backups are normalised on import; a Content-Security-Policy was added. |
| 8 | Low | A symbolic link in the data folder was followed out of it; the files API decoded the path twice. | Real-path check; decoded once. |
| 9 | Low | The relay passed the machine's `Set-Cookie` and policy headers through, forwarded the page's cookies, and would address a cloud metadata service or Home Assistant's Supervisor. | Stripped, not forwarded, refused. |
| 10 | Low | No security headers. | `nosniff`, `no-referrer`, frame denial, same-origin resource policy, a permissions policy. |
| 11 | Low | Workflows: a tag or input name was pasted into shell; the write token was granted to every job; a third-party action created the release. | Passed through `env`; read-only by default; `gh release`. |

Looked at and found sound: API keys (never exported, never in backups or logs, sent in headers only), the Markdown renderer for the AI report, the escaping of machine-provided text after 0.17.1, CSV formula neutralisation, the Node download's checksum verification, the self-signed certificate's key handling in the Home Assistant app. GitHub's code scanning shows no open alerts.

## What is deliberately not there

- **Authentication.** A password on a LAN tool that drives a machine with no password of its own would add friction without adding much; the checks above close the routes a stranger could actually use. If you need accounts, put a reverse proxy in front and list its name in `ALLOWED_HOSTS`.
- **Encryption of the browser's database.** The keys in it are protected by your OS account, like the browser's own saved passwords.
- **Signed releases** of the macOS app, until the Apple secrets are added (docs/PACKAGING.md 2.3). The release page's files come from the workflow run linked there.
