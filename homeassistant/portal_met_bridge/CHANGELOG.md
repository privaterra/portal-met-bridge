# Changelog

## 0.15.0

- Matches portal-met-bridge v0.15.0: the Stop button (the server part is disabled in this app with `ALLOW_QUIT=0`, since Home Assistant would only restart it), the green *Start brew* when the water has reached the profile's temperature (Settings → Machine → Ready to brew), consecutive numbering in AI reviews, and the fixed PDF report layout.

## 0.14.0

- First release as a Home Assistant app: the server runs on the Home Assistant machine with `HOST=0.0.0.0` and keeps the page's files in `data_dir` (default `/share/portal-met-bridge`).
- Matches portal-met-bridge v0.14.0, which added the *Files and folders* setting (downloads / a folder picked in Chrome / the server's data folder; a root folder and a subfolder per kind; an automatic full backup after every change).
