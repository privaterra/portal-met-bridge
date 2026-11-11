# Portal Met Bridge — Home Assistant app

The [portal-met-bridge](https://github.com/privaterra/portal-met-bridge) web app as a Home Assistant app: the page is served from your Home Assistant machine on port 8787 and the files it writes (shot files, exports, reports, AI reviews, backups, logs) are kept in `/share/portal-met-bridge`.

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fprivaterra%2Fportal-met-bridge)

Read the **Documentation** tab after installing (or [DOCS.md](DOCS.md)): the Portal's Bluetooth link and the Meticulous are reached from the browser that opens the page, not from the Pi, and Chrome needs one flag to allow Bluetooth on a LAN address. How this folder is built and published is in [docs/PACKAGING.md](../../docs/PACKAGING.md).
