# Portal Met Bridge — Home Assistant app

The [portal-met-bridge](https://github.com/privaterra/portal-met-bridge) web app as a Home Assistant app: the page is served from your Home Assistant machine on port 8787 and the files it writes (shot files, exports, reports, AI reviews, backups, logs) are kept in `/share/portal-met-bridge`.

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fprivaterra%2Fportal-met-bridge)

The badge opens *your* Home Assistant at the address my.home-assistant.io has stored for it (it assumes `http://homeassistant.local:8123`); if that page says *refused to connect*, press *change* there and enter the address you use — or add the repository by hand: Settings → Apps → Install app → ⋮ → Repositories → paste `https://github.com/privaterra/portal-met-bridge`.

Read the **Documentation** tab after installing (or [DOCS.md](DOCS.md)): the Portal's Bluetooth link is made by the browser that opens the page, not by the Pi, and needs a secure page — the app's https address on port 8788 once its certificate is trusted, or the Chrome flag; the page explains both. The machine is reached directly on the http page and through the app on the https one. The page's Stop button can stop the app in Home Assistant. How this folder is built and published is in [docs/PACKAGING.md](../../docs/PACKAGING.md).
