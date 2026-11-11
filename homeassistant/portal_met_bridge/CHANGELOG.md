# Changelog

## 0.14.0

- First release as a Home Assistant app: the server runs on the Home Assistant machine with `HOST=0.0.0.0` and keeps the page's files in `data_dir` (default `/share/portal-met-bridge`).
- Matches portal-met-bridge v0.14.0, which added the *Files and folders* setting (downloads / a folder picked in Chrome / the server's data folder; a root folder and a subfolder per kind; an automatic full backup after every change).
