# Changelog

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
