# Portal Met Bridge

Logs a Belka Portal's conductivity stream next to each Meticulous espresso shot, estimates strength from your own refractometer readings, and reviews shots with an AI model of your choice. This app runs the small web server on your Home Assistant machine (a Raspberry Pi 5, say) so the page is always up on your LAN and the files it writes stay on the Pi.

## How it fits together

The server serves the page, keeps files, and relays to the machine when asked. Everything that talks to the Portal happens **in the browser that opens the page**:

- the **Portal** is reached over Web Bluetooth from that browser (Chrome or Edge on a Mac or PC near the machine — a phone cannot do this);
- the **Meticulous** is reached over your LAN — directly from that browser on the plain `http` page, or through this app on the `https` page (Settings → Machine → address, e.g. `meticulous.local:80` or its IP, is the same either way);
- the **AI review** calls the provider you configured, from that browser, with your own API key.

Shots, settings and API keys live in that browser's database. The files the app writes — each shot's JSON and CSV, exports, PDF reports, AI reviews, backups of the whole database, the debug log — go to the folder below, so a browser reset loses nothing that was backed up.

## Install

1. Settings → Apps → **Install app** → ⋮ (top right) → **Repositories** → paste `https://github.com/privaterra/portal-met-bridge` → **Add** → close. (If you came here through the *Add repository to my Home Assistant* button on GitHub and got *refused to connect*, the my.home-assistant.io page has the wrong address for your instance — press *change* there and enter the address you use, e.g. `http://homeassistant.local:8123` — or simply paste the URL as above.)
2. Find **Portal Met Bridge** in the store, **Install** (the first install builds the image on the device: a minute or two on a Pi 5), then **Start**. Turn on *Start on boot* and *Watchdog* if you like (the page's Stop button stops the app through the Supervisor, which the watchdog respects).
3. Press **Open Web UI**, or go to `http://homeassistant.local:8787` (or `http://<the Pi's IP>:8787`) **in Chrome or Edge** on the computer next to the espresso machine. The machine connects from here; the Portal needs the next step.

## Bluetooth: use the https address once trusted (or the Chrome flag)

Chrome offers Web Bluetooth only on a *secure* page — `https://…`, or `http://localhost`. The page from the Pi at `http://homeassistant.local:8787` is neither, so the Portal's **Connect over Bluetooth** button is disabled there, and the note under it says so and links to both fixes. Either one works; the first is the lasting one.

**1. The https address.** The app also serves the page at **`https://homeassistant.local:8788`** (or `https://<IP>:8788`). With the default `ssl: self-signed` the certificate is one this app made itself, so Chrome will not trust it until you tell your computer to, once:

1. On the plain-http page, in the note under *Connect over Bluetooth*, press **download the certificate** (it is `http://homeassistant.local:8787/api/cert`, the public certificate only).
2. macOS: double-click the downloaded `portal-met-bridge.pem` → it lands in Keychain Access (login keychain) → open it there → **Trust** → *When using this certificate: Always Trust* → close (your password is asked). Windows: open the file → Install Certificate → Local Machine → *Trusted Root Certification Authorities*.
3. Quit Chrome completely and open it again, then open `https://homeassistant.local:8788`. The *Connection check* under Portal shows *Page is secure*, and Connect over Bluetooth works. Use the same name you put in the certificate: it is valid for `homeassistant.local`, `homeassistant`, the hostname Home Assistant reports, and the Pi's IP at the time it was made (change the name or IP and the Pi makes no new certificate; delete `/data/tls` of the app — Settings → Apps → Portal Met Bridge → ⋮ → *Rebuild* also does — to get one).

   On the https page the machine is reached **through this app** (the page itself may not call a plain-http machine; the app relays `http://<machine>` for it). Settings → Machine shows *through the server* and still takes the machine's address; the machine must be reachable from the Pi.

   If Home Assistant already has a real certificate (DuckDNS + Let's Encrypt, Nabu Casa with your own domain), set `ssl: home-assistant` and the app uses the same files from `/ssl`; open `https://<your domain>:8788` and nothing needs trusting.

**2. The Chrome flag, keeping plain http.** In Chrome open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, set it to **Enabled**, enter the address exactly as in the address bar (`http://homeassistant.local:8787`; several can be separated by commas), **Relaunch**. The flag is per browser and per exact origin (`homeassistant.local` and the IP are two origins). The note under the Connect button shows the exact string to paste.

Why not Ingress (the page inside Home Assistant's own window)? Home Assistant's address is usually plain http too, and an https Home Assistant would put the page in a frame that Chrome does not grant Bluetooth to. A direct port is simpler.

## Stop

The page's **Stop** button (top right) finishes a recording, writes pending files and disconnects everything; its last checkbox, ticked by default here, also **stops this app in Home Assistant** (through the Supervisor), so Settings → Apps → Portal Met Bridge shows it stopped until you press Start there. Untick it to stop only the page.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `data_dir` | `/share/portal-met-bridge` | Where the app's files go. `/share` is visible to the Samba and File editor apps; `/share/portal-met-bridge/{shots,exports,reports,reviews,backups,logs}/` is the layout (the names are settings in the page; the page's root folder is not repeated because the data folder already bears its name). |
| `ssl` | `self-signed` | `self-signed`: https on 8788 with a certificate this app makes (trust it once, above). `home-assistant`: https on 8788 with Home Assistant's own certificate from `/ssl` (`certfile`, `keyfile`). `off`: http only. |
| `certfile`, `keyfile` | `fullchain.pem`, `privkey.pem` | The files under `/ssl` used when `ssl` is `home-assistant`. |
| `log_level` | `info` | How much the app logs to the Home Assistant log (the app's own debug log is separate, under Settings → Logging and debug in the page). |

In the page, Settings → **Files and folders** shows the destination: *the data folder of the server* is preselected when no folder was picked in Chrome. You can still pick a folder on your own computer instead; then the Pi keeps only the page.

## Where to find things on the Pi

Install the **Samba share** app and open `\\homeassistant\share\portal-met-bridge` (macOS: Finder → Go → Connect to Server → `smb://homeassistant.local/share`). Every file the page wrote is there, including `backups/portal-met-bridge-latest.json`, which **Settings → Backup and restore → Restore** loads into any browser.

The app's files are not part of Home Assistant backups unless `/share` is included; the backups folder covers that.

## Updating

When a new version is published, the store shows an **Update** button; the image is rebuilt from the matching release tag. Your files in `/share`, the certificate in the app's `/data`, and the page's database in your browser are untouched.

## Troubleshooting

- **"Open page in your Home Assistant" says refused to connect** — that button lives on my.home-assistant.io, which remembers *your* instance address in your browser; it defaults to `http://homeassistant.local:8123`. Press *change* on that page and enter the address you actually use (with its port, and https if that is how you reach Home Assistant), or skip the button and add the repository URL by hand (Install, step 1).
- **Connect over Bluetooth is disabled** — the page is on plain http from a LAN address. Use the https address after trusting the certificate, or the Chrome flag, exactly as the note under the button says. After trusting the certificate Chrome must be quit and reopened; and the name in the address bar must be one the certificate covers.
- **The https page says "not private" even after trusting** — the certificate was trusted in the wrong keychain or for the wrong name; open Keychain Access, find *portal-met-bridge on …*, check Trust is *Always Trust*, and that you open the same name (`homeassistant.local`, not the IP, or the other way round).
- **The machine does not connect** — on the http page the address in Settings → Machine must be reachable *from your computer*; on the https page it must be reachable *from the Pi* (the app relays). `meticulous.local:80` or the machine's IP; port 80 is the default. *Test connection* says which way it is trying.
- **Nothing is written to /share** — Settings → Files and folders → *Where files go* must say the server's data folder (or *whatever is available* with no folder picked). The status line names the folder and counts the files written this session.
- **Stop in the page did not stop the app** — the app asks the Supervisor to stop it, which needs the `hassio_api` permission this version declares (after updating from 0.14 or 0.15, uninstall and install again if the Stop reports an error). If the Supervisor route fails the server simply exits; with *Watchdog* on, Home Assistant then starts it again.
- **Port 8787 or 8788 is taken** — change the host port in the app's Network settings (Configuration tab, *Show disabled ports*); the page's address changes with it, and so must the Chrome flag or the certificate's name.
- **Logs** — the app's Log tab shows the server's start lines (both addresses, the certificate's names) and errors; the page's own debug log is under Settings → Logging and debug and, when logging is on, `logs/<date>.log` in the data folder.
