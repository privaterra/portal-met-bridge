# Packaging: a macOS app and a Home Assistant app, built and published on GitHub

portal-met-bridge is a static web page plus a 150-line Node server (`serve.mjs`). "Packaging" it means wrapping those two things so that someone can install them without a terminal:

| Package | What it is | Who builds it | Where it ends up |
| --- | --- | --- | --- |
| **Portal Met Bridge.app** (macOS) | A double-clickable app bundle: a launcher script, the page, and a bundled Node runtime for Apple silicon and Intel. It serves `http://localhost:8787`, keeps the files in `~/Documents/portal-met-bridge`, and opens Chrome. | `.github/workflows/release.yml` on a macOS runner, from `tools/package-macos.sh` | A GitHub **Release**, as a `.zip` and a `.dmg` |
| **Home Assistant app** (Raspberry Pi 5 and any other Home Assistant machine) | A container that runs the server on the Pi with `HOST=0.0.0.0` and keeps the files in `/share/portal-met-bridge`. | The Pi itself, from `homeassistant/portal_met_bridge/Dockerfile`; optionally `.github/workflows/ha-app.yml` publishes a prebuilt image to GHCR | The **app store** of any Home Assistant that has added this repository |

Both packages are tied to a **version tag** (`v0.14.0`): the release workflow builds the tag it was pushed for, and the Home Assistant Dockerfile downloads the source of the tag that matches its `config.yaml` version. So every release is the same three steps, below, and the rest of this document explains what each package does with them.

Home Assistant renamed add-ons to **apps** in 2026; the files and the UI paths here follow the current [contributor documentation](https://contributors.home-assistant.io/apps/). Older guides that say "add-on", `build.yaml` or `{arch}` images still work but are deprecated.

## 1. Releasing a version (every time)

```sh
cd ~/Sites/portal-met-bridge
node tools/bump-version.mjs 0.14.0      # package.json, cache-busting stamps, About line, and the Home Assistant config.yaml
node tests/run.mjs                      # the version test fails if anything disagrees
git commit -am "v0.14.0: …"
tools/publish.sh                        # sign the commit and push main (as for every delivery)
tools/tag-release.sh                    # create the signed tag v0.14.0 and push it
```

Pushing the tag does two things:

1. GitHub runs **Release** (Actions tab). It builds the macOS app, attaches `portal-met-bridge-0.14.0-macos.zip`, `…-macos.dmg` and `…-source.zip` to a **draft** release named after the tag, with release notes it writes itself. Open github.com/privaterra/portal-met-bridge/releases, read the draft, edit the notes if you like, and press **Publish release**.
2. Home Assistant machines that have the repository added see version 0.14.0 in the store, with an **Update** button for anyone who already has it installed, because the Supervisor reads `homeassistant/portal_met_bridge/config.yaml` from the repository's default branch and builds the image from the tag with the same number.

Publishing the release also runs **Home Assistant app image** (`ha-app.yml`), which pushes a prebuilt image to GHCR. That image is only used once `image:` is uncommented in `config.yaml` (section 3.4); until then the workflow is a build check.

One-time setup on GitHub, before the first release:

- **Actions enabled**: Settings → Actions → General → *Allow all actions and reusable workflows*. The release workflow creates releases with the automatic `GITHUB_TOKEN`; if its last step fails with a 403, set *Workflow permissions* on the same page to *Read and write permissions*.
- **Tag signing**: `tools/tag-release.sh` signs the tag with the same key `tools/publish.sh` uses (docs/SIGNED-COMMITS.md). GitHub shows *Verified* on the tag too.
- **Optional, for a quieter first launch on macOS**: the five signing secrets in section 2.3.

To build a package without a release (to try it): Actions → Release → *Run workflow* with the tag field empty builds the current commit and leaves the zip and dmg as workflow artifacts, without creating a release.

## 2. The macOS app

### 2.1 What the user gets

`portal-met-bridge-0.14.0-macos.zip` unzips to **Portal Met Bridge.app**. Dragged into Applications and opened, it:

1. starts `serve.mjs` with the bundled Node on `http://localhost:8787`, with `DATA_DIR=~/Documents/portal-met-bridge` so the page's Settings → Files and folders offers *the data folder of the server* and preselects it when no folder was picked in Chrome — the files appear in Documents without the folder-picker prompt Chrome otherwise repeats after every restart;
2. opens the page in Google Chrome (or Microsoft Edge, or the default browser — only Chrome and Edge can reach the Portal over Bluetooth);
3. stays in the Dock while it serves; **Quit** from the Dock stops the server. Opening the app while it is already running just brings the page up again.

It writes a log to `~/Library/Logs/portal-met-bridge.log`, and reads `~/Library/Application Support/portal-met-bridge/config` if that file exists, with any of `PORT=`, `DATA_DIR=`, `BROWSER=`, `HOST=` lines (the launcher script at `Contents/MacOS/portal-met-bridge` documents them).

The `.dmg` carries the same app with an *Applications* shortcut, the usual drag-to-install picture.

**First launch and Gatekeeper.** Unless the app is signed and notarized (2.3), macOS blocks a downloaded app the first time: *"Portal Met Bridge" can't be opened because Apple cannot check it for malicious software* (or *…cannot be opened because the developer cannot be verified*). The user opens it once in one of these ways and macOS remembers:

- macOS 15 and later: try to open it, then System Settings → Privacy & Security → scroll to the message about Portal Met Bridge → **Open Anyway**, and confirm;
- any version: right-click (control-click) the app in Finder → **Open** → **Open**;
- Terminal: `xattr -dr com.apple.quarantine "/Applications/Portal Met Bridge.app"`.

Put these three lines in the release notes (the workflow's generated notes already do).

Chrome itself may ask for Bluetooth permission the first time (System Settings → Privacy & Security → Bluetooth → Google Chrome), as with the plain `start.command`.

### 2.2 How it is built

`tools/package-macos.sh` assembles the bundle from the repository; it runs on macOS and on Linux (the layout is plain files):

```
Portal Met Bridge.app/
  Contents/Info.plist                bundle id org.privaterra.portal-met-bridge, version from package.json
  Contents/MacOS/portal-met-bridge   the launcher (bash)
  Contents/Resources/app/            index.html, js/, css/, vendor/, serve.mjs, README, LICENSE, docs/NOTES.md, docs/PACKAGING.md
  Contents/Resources/node/arm64/bin/node   Node for Apple silicon   } with --download-node or --node-arm64/--node-x64;
  Contents/Resources/node/x64/bin/node     Node for Intel           } without them the launcher uses the Mac's own Node
  Contents/Resources/AppIcon.icns    from assets/icon-1024.png (macOS only: sips + iconutil)
```

```sh
tools/package-macos.sh --download-node          # app + zip (+ dmg on macOS); downloads the newest Node 24 LTS for both CPUs and checks SHASUMS256
tools/package-macos.sh                          # smaller: no Node bundled, the launcher finds node on the Mac or shows a dialog
tools/package-macos.sh --out dist --no-zip      # only the .app
```

The workflow (`release.yml`) runs the unit tests on Linux, then on `macos-latest`: checks the tag against `package.json`, runs the script with `--download-node`, signs and notarizes when the secrets exist, zips with `ditto` (which keeps the executable bits and resource forks that `zip` loses), makes the `.dmg` with `hdiutil`, adds a source archive, and hands everything to `softprops/action-gh-release` as a draft release.

Try the bundle on a Mac without a release: `tools/package-macos.sh --out /tmp/pmb && open "/tmp/pmb/Portal Met Bridge.app"`.

### 2.3 Signing and notarizing (optional)

With an Apple Developer Program membership (US$99/year) the app opens without the Gatekeeper step. The workflow does it when these repository secrets exist (Settings → Secrets and variables → Actions):

| Secret | Contents |
| --- | --- |
| `MACOS_CERTIFICATE_P12` | Your **Developer ID Application** certificate and private key exported from Keychain Access as a `.p12`, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PASSWORD` | The password you gave the `.p12` on export |
| `APPLE_ID` | The Apple ID of the developer account |
| `APPLE_TEAM_ID` | The 10-character team id (developer.apple.com → Membership) |
| `APPLE_APP_PASSWORD` | An app-specific password for that Apple ID (appleid.apple.com → Sign-In and Security → App-Specific Passwords) |

The steps then: import the certificate into a temporary keychain, `codesign --options runtime --timestamp` the bundled `node` binaries and the bundle, submit a zip to `notarytool` and wait, `stapler staple` the ticket onto the app, and only then zip and build the dmg. Without the secrets those two steps are skipped and the app is unsigned, which is fine for your own Macs.

## 3. The Home Assistant app (Raspberry Pi 5)

### 3.1 What the user gets

A Home Assistant OS machine (a Pi 5 running the official image, a Home Assistant Green or Yellow, a VM) with this repository added to its app store can install **Portal Met Bridge** like any other app. Once started:

- the page is at `http://homeassistant.local:8787` (and the **Open Web UI** button opens it);
- the files the page writes go to `/share/portal-met-bridge` on the Pi, reachable from a Mac through the **Samba share** app (`smb://homeassistant.local/share`), so shot files, reports, reviews, the automatic database backups and the debug log are on the always-on machine, not in one browser;
- the server comes back after a reboot (*Start on boot*), and the store offers updates when a new version is tagged.

What stays on the user's computer: the Portal's Bluetooth link and the connection to the Meticulous are made **by the browser that opens the page**, and the page's database (shots, settings, API keys) lives in that browser. The Pi serves and stores files; it never talks to the hardware. The app's **Documentation** tab (`DOCS.md`) says this, and explains the one Chrome flag that is needed because the page comes from `http://homeassistant.local:8787` rather than `localhost`: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → `http://homeassistant.local:8787`. Without it Chrome refuses Web Bluetooth on the LAN address. (HTTPS would allow Bluetooth but block the plain-http Meticulous as mixed content, which is why the app does not use Home Assistant's ingress; the alternative is an SSH tunnel, `ssh -L 8787:localhost:8787 root@homeassistant.local`, and `http://localhost:8787`.)

Install steps for the user, also in `DOCS.md` and `homeassistant/portal_met_bridge/README.md` (with a *my.home-assistant.io* badge that opens the dialog pre-filled):

1. Settings → Apps → **Install app** → ⋮ → **Repositories** → paste `https://github.com/privaterra/portal-met-bridge` → **Add**.
2. **Portal Met Bridge** appears in a *portal-met-bridge* section of the store → **Install**. Without a prebuilt image the Pi builds the container itself: `apk add nodejs` plus the app's tarball, one to two minutes on a Pi 5.
3. **Start**; optionally *Start on boot* and *Watchdog*. Options (Configuration tab): `data_dir`, `log_level`.
4. Open `http://homeassistant.local:8787` in Chrome on the computer by the machine, set the flag above once, and use it as on a Mac. Settings → Files and folders shows *the data folder of the server — /share/portal-met-bridge on …* as the destination.

### 3.2 The files in the repository

The repository is itself a Home Assistant *app repository*: `repository.yaml` at the root names it, and the Supervisor finds every folder with a `config.yaml` (at any depth, so this layout is allowed):

```
repository.yaml                            name, url, maintainer — without it the Supervisor ignores the repository
homeassistant/portal_met_bridge/
  config.yaml                              name, version (= the release tag it installs), slug, arch (aarch64, amd64), port 8787,
                                           webui for the Open Web UI button, map share:rw, options + schema; `image:` commented out
  Dockerfile                               FROM ghcr.io/home-assistant/base:3.24 (Alpine, multi-arch) → apk add nodejs →
                                           download github.com/privaterra/portal-met-bridge/archive/v<version>.tar.gz into /opt/app
  run.sh                                   bashio: read options, mkdir data_dir, exec HOST=0.0.0.0 PORT=8787 DATA_DIR=… node serve.mjs
  DOCS.md                                  the Documentation tab
  README.md, CHANGELOG.md                  the store's description and the Changelog tab
  icon.png (128×128), logo.png (250×100)   from assets/icon-1024.png
```

Things worth knowing when you change them:

- **`version` in `config.yaml` is the tag.** The Dockerfile reads `BUILD_VERSION`, which the Supervisor (and the builder action) set from `config.yaml`, and downloads `archive/v${BUILD_VERSION}.tar.gz`. `tools/bump-version.mjs` keeps `config.yaml` in step with `package.json`, and `tools/tag-release.sh` refuses to tag if they differ. Installing on a Pi before the tag is pushed fails with a download error in the app's log.
- To test unreleased code on a Pi, point the Dockerfile at another ref: on a branch, change `ARG APP_REF=v${APP_VERSION}` to `ARG APP_REF=main` (or a commit id), and add the repository with that branch, `https://github.com/privaterra/portal-met-bridge#my-branch`. The Supervisor treats a different branch as a different repository, so it can sit next to the released one. (`build.yaml`, where build arguments used to go, is deprecated; everything lives in the Dockerfile now.)
- `init: false` because the Home Assistant base image runs S6 overlay as process 1; `run.sh` uses `#!/command/with-contenv bashio` for the same reason.
- `arch` lists `aarch64` (Pi 5, Pi 4, Green, Yellow) and `amd64` (NUC, VM). `armv7` is deprecated by Home Assistant and not offered.
- The server binds `0.0.0.0` *inside the container*; the Supervisor publishes only the port in `ports`, so the page is reachable on the LAN at the host port (8787 unless the user changes it in the app's Network settings). Anyone on the LAN who can reach the page can also write files into `data_dir` through its file API — the same trust as the rest of a home LAN, but do not expose the port to the internet.
- After editing anything under `homeassistant/`, the store picks the change up on its next refresh (Settings → Apps → ⋮ → *Check for updates*, or within a day). A changed Dockerfile with the same `version` is **not** rebuilt on devices that already have it; bump the version.

### 3.3 Building and testing the container yourself

On any machine with Docker (a Mac with Docker Desktop, or the Pi over SSH):

```sh
cd ~/Sites/portal-met-bridge/homeassistant/portal_met_bridge
docker buildx build --platform linux/arm64 --build-arg BUILD_VERSION=0.14.0 -t pmb-test .   # needs the tag v0.14.0 on GitHub
docker run --rm -p 8787:8787 -v "$PWD/share:/share" pmb-test                                # http://localhost:8787, files in ./share
```

`bashio` reads options from `/data/options.json`; outside Home Assistant that file is absent and `bashio::config` returns empty strings, so `run.sh` falls back to its defaults (`/share/portal-met-bridge`, `info`). To test the same thing without Docker, run the server as the app does: `HOST=0.0.0.0 PORT=8787 DATA_DIR=/tmp/pmb node serve.mjs`.

The Home Assistant developers also provide a devcontainer that runs a full Supervisor with your local app folder mounted as a local app; the [app development guide](https://contributors.home-assistant.io/apps/) describes it.

### 3.4 Prebuilt images on GHCR (optional)

Building on the device is the simplest route and the default here. A prebuilt image installs in seconds instead of minutes and does not need the device to reach github.com. `ha-app.yml` builds one on every published release (and on demand from the Actions tab) with the official Home Assistant builder actions — `prepare-multi-arch-matrix` → `build-image` per architecture (aarch64 on an Arm runner, amd64 on x86) → `publish-multi-arch-manifest` — and pushes `ghcr.io/privaterra/portal-met-bridge:<version>` and `:latest`, signed with Cosign.

To switch users to it:

1. Run the workflow once (publish a release, or Actions → *Home Assistant app image* → *Run workflow*). It pushes with the automatic `GITHUB_TOKEN` (`packages: write`).
2. The first push creates a **private** package. Make it public, or no Pi can pull it: github.com/privaterra?tab=packages → *portal-met-bridge* → *Package settings* → *Danger Zone* → *Change visibility* → Public. Also link it to the repository there (*Connect repository*) so it shows on the repository page.
3. Uncomment `image: ghcr.io/privaterra/portal-met-bridge` in `config.yaml` and push. From then on the Supervisor pulls `image:version` instead of building; every release must therefore run the workflow *before* users update, which the release trigger does.

Switching back is a matter of commenting the line out again.

## 4. Checklist per release

1. `node tools/bump-version.mjs X.Y.Z`; update `homeassistant/portal_met_bridge/CHANGELOG.md`; `node tests/run.mjs`; commit; `tools/publish.sh`.
2. `tools/tag-release.sh` → wait for **Release** to finish → publish the draft release (edit the notes: the README's prompt history has the changes).
3. On a Home Assistant machine: Settings → Apps → ⋮ → *Check for updates* → Portal Met Bridge shows the new version → Update → Open Web UI → Settings → About shows the version.
4. If prebuilt images are in use: confirm **Home Assistant app image** succeeded and the package has the new tag before announcing the update.

## 5. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `tools/tag-release.sh: node: command not found` (or the same from `package-macos.sh`) | Fixed after v0.14.0: both scripts read the version with `sed` and need only git, bash, curl and tar. `node tools/bump-version.mjs` and the tests do need Node: `brew install node`, or, if Homebrew's Node is installed but that shell cannot see it, `export PATH=/opt/homebrew/bin:$PATH` (Intel Macs: `/usr/local/bin`). |
| Release workflow: *tag v0.14.0 but package.json says 0.13.0* | Bump first, then tag. Delete the tag (`git tag -d v0.14.0 && git push origin :refs/tags/v0.14.0`), fix, retag. |
| Release workflow: 403 on the release step | Settings → Actions → General → Workflow permissions → *Read and write permissions*. |
| The .app opens Terminal-less and nothing happens | Look at `~/Library/Logs/portal-met-bridge.log`. Usually port 8787 is in use (another copy, or `node serve.mjs` in a Terminal): the launcher then only opens the browser. |
| The .app says Node is needed | The bundle was built without `--download-node` and the Mac has no Node; `brew install node` or use the full release zip. |
| Home Assistant: install fails, log says *404* or *tar: short read* while downloading | The tag matching `config.yaml`'s version is not on GitHub yet, or the device cannot reach github.com. Push the tag (`tools/tag-release.sh`). |
| Home Assistant: *Portal Met Bridge* missing from the store after adding the repository | `repository.yaml` must be at the repository root and valid YAML; Settings → System → Logs → Supervisor shows why a repository was skipped. ⋮ → *Check for updates* refreshes the store. |
| Home Assistant: the page loads, Bluetooth stays disabled | The Chrome flag for the exact origin in the address bar (`homeassistant.local` and the IP are different origins). |
| Home Assistant: the page loads, the machine does not connect | The address in Settings → Machine must be reachable from the *computer running the browser*, e.g. `meticulous.local:80`; the Pi is not involved. |
| GHCR image pull fails with *denied* | The package is private; make it public (3.4) or comment `image:` out again. |
