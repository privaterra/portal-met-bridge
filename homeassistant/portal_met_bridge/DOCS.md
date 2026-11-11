# Portal Met Bridge

Logs a Belka Portal's conductivity stream next to each Meticulous espresso shot, estimates strength from your own refractometer readings, and reviews shots with an AI model of your choice. This app runs the small web server on your Home Assistant machine (a Raspberry Pi 5, say) so the page is always up on your LAN and the files it writes stay on the Pi.

## How it fits together

The server only serves the page and keeps files. Everything that talks to hardware happens **in the browser that opens the page**:

- the **Portal** is reached over Web Bluetooth from that browser (Chrome or Edge on a Mac or PC near the machine — a phone cannot do this);
- the **Meticulous** is reached over your LAN from that browser (Settings → Machine → address, e.g. `meticulous.local:80` or its IP);
- the **AI review** calls the provider you configured, from that browser, with your own API key.

Shots, settings and API keys live in that browser's database. The files the app writes — each shot's JSON and CSV, exports, PDF reports, AI reviews, backups of the whole database, the debug log — go to the folder below, so a browser reset loses nothing that was backed up.

## Install

1. Settings → Apps → **Install app** → ⋮ (top right) → **Repositories** → add `https://github.com/privaterra/portal-met-bridge` → close.
2. Find **Portal Met Bridge** in the store, **Install** (the first install builds the image on the device: a minute or two on a Pi 5), then **Start**. Turn on *Start on boot* and *Watchdog* if you like.
3. Press **Open Web UI**, or go to `http://homeassistant.local:8787` (or `http://<the Pi's IP>:8787`) **in Chrome or Edge** on the computer next to the espresso machine.

## Bluetooth needs one Chrome setting

Web Bluetooth only works on a page that comes from a *secure* address: `https://…` or `http://localhost`. The page from the Pi comes from `http://homeassistant.local:8787`, which Chrome treats as insecure, so the Portal's **Connect over Bluetooth** button stays disabled until you allow that address once:

1. In Chrome open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Set it to **Enabled** and enter the address you use, exactly as in the address bar: `http://homeassistant.local:8787` (several addresses can be separated by commas).
3. Relaunch Chrome. The *Connection check* under Portal now shows *Page is secure*.

Why not HTTPS or Ingress? The Meticulous only speaks plain `http`, and a page served over `https` is not allowed to call an `http` machine (mixed content). Serving over `http` with the exception above keeps both the Portal and the machine reachable. (An alternative without the flag: `ssh -L 8787:localhost:8787 root@homeassistant.local` and open `http://localhost:8787`.)

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `data_dir` | `/share/portal-met-bridge` | Where the app's files go. `/share` is visible to the Samba and File editor apps; `/share/portal-met-bridge/{shots,exports,reports,reviews,backups,logs}/` is the layout (the names are settings in the page; the page's root folder is not repeated because the data folder already bears its name). |
| `log_level` | `info` | How much the app logs to the Home Assistant log (the app's own debug log is separate, under Settings → Logging and debug in the page). |

In the page, Settings → **Files and folders** shows the destination: *the data folder of the server* is preselected when no folder was picked in Chrome. You can still pick a folder on your own computer instead; then the Pi keeps only the page.

## Where to find things on the Pi

Install the **Samba share** app and open `\\homeassistant\share\portal-met-bridge` (macOS: Finder → Go → Connect to Server → `smb://homeassistant.local/share`). Every file the page wrote is there, including `backups/portal-met-bridge-latest.json`, which **Settings → Backup and restore → Restore** loads into any browser.

The app's files are not part of Home Assistant backups unless `/share` is included; the backups folder covers that.

## Updating

When a new version is published, the store shows an **Update** button; the image is rebuilt from the matching release tag. Your files in `/share` and the page's database in your browser are untouched.

## Troubleshooting

- **The page loads but Connect over Bluetooth is disabled** — the Chrome flag above, for the exact address you use (`homeassistant.local` and the IP are different origins).
- **The machine does not connect** — the address in Settings → Machine must be reachable *from your computer*, not from the Pi: `meticulous.local:80` or the machine's IP. Port 80 is the default.
- **Nothing is written to /share** — Settings → Files and folders → *Where files go* must say the server's data folder (or *whatever is available* with no folder picked). The status line names the folder and counts the files written this session.
- **Port 8787 is taken** — change the host port in the app's Network settings (Configuration tab, *Show disabled ports*); the page's address changes with it, and so must the Chrome flag.
- **Logs** — the app's Log tab shows the server's start line and errors; the page's own debug log is under Settings → Logging and debug and, when logging is on, `logs/<date>.log` in the data folder.
