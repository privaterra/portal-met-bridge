# Changelog

## 0.19.1

- **Security release** — matches portal-met-bridge v0.19.1, the first release of the 0.19 changes (0.19.0 was tagged but its release build failed; the app is the same). The app's server now refuses requests that come from another website (before, a page you visited could have reached the app on your LAN, including the machine relay) and answers only to addresses, `homeassistant`, `.local` names and its certificate's names; a new option **`allowed_hosts`** lists any other name you use (a DuckDNS name, a reverse proxy). If the page suddenly says *421*, that is the option to fill in.
- A profile name containing markup no longer runs in the Analysis tab. The page runs under a Content-Security-Policy; restored backups are normalised; a settings file can no longer change where an API key is sent.
- The PDF library was replaced by its current version (jsPDF 2.5.2 → 4.2.1, which closes twelve published advisories); every bundled library is now checksummed and checked for advisories before a release.
- The container upgrades its Alpine packages on every build.

## 0.18.0

- Matches portal-met-bridge v0.18.0: rating settings (on/off, 1–5 or 1–9 scale, rate when the shot completes or afterwards), switches for where per-shot files and History exports go, *Write a backup now* and *Restore…* ask (the restore picker lists the backups in `/share/portal-met-bridge/backups`), *Export selected* in History, a Beans tab with an editor and a link per coffee; the duplicate Shots block on the left is gone.

## 0.17.1

- Matches portal-met-bridge v0.17.1: the macOS build fixed (the v0.17.0 tag had no release), the Machine tab escapes everything the machine answers, CSV exports neutralize formula-like fields, the Analysis shot picker keeps rated rows on one line.

## 0.17.0

- Matches portal-met-bridge v0.17.0: the PDF report ends with the shot's saved AI review; reviews of several shots are continued automatically when the model stops at its output limit; *Suggested changes* comments on every stage; a 1–5 star rating and a comment after each shot (History ★ column, the review reads them); the new tagline.

## 0.16.0

- The page is also served over **https on port 8788** (`ssl: self-signed` makes a certificate on first start, `ssl: home-assistant` uses Home Assistant's own from `/ssl`, `off` disables it) — the way to get Web Bluetooth for the Portal on a LAN address; the plain-http page links to the certificate and explains the trust step, and the Chrome flag route still works. On the https page the machine is reached through the app's `/machine/` relay.
- The page's **Stop** button now stops this app in Home Assistant (Supervisor API; `hassio_api: true`).
- Reviews of several shots compare them in every section.
- Docs: what to do when the *Add repository* badge says *refused to connect*.

## 0.15.0

- Matches portal-met-bridge v0.15.0: the Stop button (the server part is disabled in this app with `ALLOW_QUIT=0`, since Home Assistant would only restart it), the green *Start brew* when the water has reached the profile's temperature (Settings → Machine → Ready to brew), consecutive numbering in AI reviews, and the fixed PDF report layout.

## 0.14.0

- First release as a Home Assistant app: the server runs on the Home Assistant machine with `HOST=0.0.0.0` and keeps the page's files in `data_dir` (default `/share/portal-met-bridge`).
- Matches portal-met-bridge v0.14.0, which added the *Files and folders* setting (downloads / a folder picked in Chrome / the server's data folder; a root folder and a subfolder per kind; an automatic full backup after every change).
