# Releasing: how to publish a new version and put the macOS package up for download

This is the maintainer's walkthrough, start to finish, for one release of portal-met-bridge — bumping the version, pushing the tag, letting GitHub build **Portal Met Bridge.app**, publishing the release, and attaching or replacing the macOS package by hand when you want to. [docs/PACKAGING.md](PACKAGING.md) explains *what* the packages are and how they are built; this page is the *how-to* you follow each time.

Every version is a Git tag (`v0.19.1`). Pushing the tag starts the **Release** workflow, which builds the app on a macOS runner and attaches it to a **draft** GitHub Release; you read the draft and press *Publish*. The Home Assistant app installs the source of the tag that matches its `config.yaml`, so the same tag serves both packages.

## 0. One-time setup

| What | How | Why |
| --- | --- | --- |
| Node on the PATH of the shell you release from | `brew install node`; if Homebrew's Node is installed but `node` is not found, `export PATH=/opt/homebrew/bin:$PATH` (Intel: `/usr/local/bin`) | `tools/bump-version.mjs` and the tests need it (the two shell tools do not) |
| Commit and tag signing | [docs/SIGNED-COMMITS.md](SIGNED-COMMITS.md) | `tools/publish.sh` and `tools/tag-release.sh` sign what they push; GitHub shows *Verified* |
| Actions allowed to create releases | github.com → the repository → Settings → Actions → General → *Workflow permissions* → **Read and write permissions** | the workflow creates the draft release with the automatic `GITHUB_TOKEN` |
| Actions allowed to open pull requests | the same page → *Workflow permissions* → tick **Allow GitHub Actions to create and approve pull requests** | the weekly **Dependency updates** workflow proposes library updates as a pull request (without it, it still pushes the branch `deps/update` and links to it) |
| Dependabot | Settings → Advanced Security (Code security) → *Dependabot alerts* on (it is), *Dependabot security updates* as you like | alerts for the shipped libraries (through `vendor/package.json`) and weekly pull requests for Actions and dev tools (`.github/dependabot.yml`) |
| *(optional)* the GitHub CLI | `brew install gh` then `gh auth login` (GitHub.com, HTTPS, browser) | uploading or replacing release assets from the Terminal (section 4); everything in this guide also works in the web UI |
| *(optional)* Apple signing | PACKAGING.md section 2.3 — the five secrets | the app opens without the right-click → Open step; not needed for an alpha |

## 1. A new version, step by step

Everything happens in your clone, on `main`, with a clean working tree. Replace `0.19.1` with the version you are releasing.

```sh
cd ~/Sites/portal-met-bridge
git status                               # nothing pending; `git log origin/main..main` shows what is not pushed yet

# 0. the libraries: fetch the latest, see that nothing has an open advisory
node tools/vendor.mjs update             # newest uPlot, socket.io-client, qrcode-generator, jsPDF, fflate → vendor/ (skip if the weekly pull request was just merged)
node tools/vendor.mjs check              # newer versions? security advisories for what is in vendor/? (tag-release.sh asks again and refuses on high/critical)

# 1. the version number, in every place that carries it
node tools/bump-version.mjs 0.19.1       # package.json, the ?v= cache stamps, the About line, the Home Assistant config.yaml

# 2. the two texts a release needs
$EDITOR homeassistant/portal_met_bridge/CHANGELOG.md   # a "## 0.19.1" entry (the unit tests insist on it)
$EDITOR docs/releases/v0.19.1.md                        # the release notes — copy the previous file and edit (section 2)

# 3. check
node tests/run.mjs                       # all groups pass; the "release:" group fails if a version stamp disagrees
npm run test:e2e                         # optional, ~4 minutes: the whole app in Chrome against the simulated Portal and machine

# 4. commit, push, tag
git add -A && git commit -m "v0.19.1: what changed, in one line"
tools/publish.sh                         # rebases on GitHub if needed, signs, pushes main
tools/tag-release.sh                     # creates the signed tag v0.19.1 and pushes it → the Release workflow starts
```

`tools/tag-release.sh` refuses to tag when the tree is dirty, when `main` is not pushed, when the tag exists, when `config.yaml`'s version differs from `package.json`, or when a library in `vendor/` has a high or critical security advisory (or a vendored file is not the one the manifest names) — each message says what to do. The library check needs Node and the network; without either it says so and leaves the check to the Release workflow, which runs it before building. `SKIP_DEP_CHECK=1 tools/tag-release.sh` tags regardless.

If you updated a library in step 0, exercise what it does before committing: the charts (uPlot), the live machine stream (socket.io-client), the Beanconqueror QR code (qrcode-generator), a PDF report and a review PDF (jsPDF), a zip export and a `.docx` review (fflate). `npm run test:e2e` covers all five.

**Then, on GitHub:**

5. **Watch the build.** github.com/privaterra/portal-met-bridge/actions → the run named after the tag (*v0.19.1 Release*). Four jobs: *Unit tests* and *Libraries and security advisories* (Ubuntu, under a minute each; the second lists the shipped versions and any advisory in its summary), *macOS app* (an Apple-silicon runner; 3–10 minutes) and *macOS app (other runner pool, when the first found no runner)*, which is normally **skipped** (grey, with a slash). The first three must be green. When GitHub has no Apple-silicon runner free, *macOS app* sits queued for about 15 minutes and is cancelled; the fourth job then builds the same app on an Intel runner and makes the draft. The run still ends red in that case, and GitHub still sends its *Run failed* mail, because one job was cancelled — look at the fourth job: green there means the draft is waiting under Releases. Anything else red: section 5; do not publish a release without its files.
6. **Open the draft.** github.com/privaterra/portal-met-bridge/releases → the draft at the top, titled *portal-met-bridge 0.19.1 (alpha)* (0.x versions and tags with a suffix are pre-releases, titled *(alpha)*; from 1.0.0 the title is the plain version and the release is a full one). Check its **Assets**:
   - `portal-met-bridge-0.19.1-macos.zip` — the app with Node for Apple silicon *and* Intel (~110 MB);
   - `portal-met-bridge-0.19.1-macos.dmg` — the same app on a disk image with an Applications shortcut;
   - `portal-met-bridge-0.19.1-source.zip` — the repository at the tag;
   - plus GitHub's own *Source code (zip / tar.gz)*.
   Read the notes (they are `docs/releases/v0.19.1.md`; edit in place if something is off — the file in the repository is the record, so fix it there too, next commit). Leave *Set as a pre-release* ticked for 0.x. *Set as the latest release* is what the Releases page and the `/releases/latest` link point at — tick it for a normal release, leave it off for a hotfix of an older line.
7. **Publish release.** The release becomes public; the badge on the README and `https://github.com/privaterra/portal-met-bridge/releases/latest` now point at it, and the **Home Assistant app image** workflow runs (a build check unless prebuilt images are enabled — PACKAGING.md 3.4).
8. **Try the download.** On the Mac: download the zip from the release page, unzip, move *Portal Met Bridge.app* to Applications, right-click → Open (first launch of an unsigned build), confirm Chrome opens the page and Settings → About shows 0.17.1. On Home Assistant: Settings → Apps → ⋮ → *Check for updates* → Portal Met Bridge offers 0.17.1 → Update → the page's About shows it.

## 2. The release notes file

`docs/releases/v<version>.md` is the body of the release, verbatim (Markdown; GitHub renders it). The workflow uses it when it exists and writes a short stub otherwise, so write it *before* tagging and commit it with the version. (If the notes need correcting after the tag exists: fix the file on `main`, publish, and start the workflow by hand with the tag — a run started by hand reads the file from `main`, and refreshes the title and notes of a release that is still a draft. A published release is edited on its page.) The previous file is the template: a one-paragraph description of the app, "what changed since", install for macOS / Home Assistant / source, the asset table, known limits, what would help, credits. Images referenced by raw URL (`https://raw.githubusercontent.com/privaterra/portal-met-bridge/v0.19.1/docs/screenshot-….png`) resolve once the tag is pushed.

## 3. The macOS package: what goes up and what to tell people

The workflow's `…-macos.zip` and `…-macos.dmg` are **one universal app**: `Contents/Helpers/node/arm64/` and `…/x64/` both ship, and the launcher picks the one for the CPU it runs on. So "the Apple-silicon download" is that same zip — there is no separate file to make for M-series Macs, and the Intel runtime inside costs ~55 MB of download, nothing at run time. The notes and the README point people at the zip (unzip → Applications → open) and offer the dmg as the drag-and-drop alternative.

What the first launch looks like until the app is signed and notarized: macOS says it "cannot verify the developer"; right-click (control-click) → **Open** → **Open**, or System Settings → Privacy & Security → *Open Anyway*. Once. With the five Apple secrets in place (PACKAGING.md 2.3) the workflow signs and notarizes, and that step disappears.

## 4. Building the package yourself and attaching it to a release

You need this when the workflow failed and you want the release out anyway, when you want an Apple-silicon-only build, or when you want to sign with your own identity from your Mac.

**Build** (on the Mac, in the clone, at the commit of the tag — `git checkout v0.19.1` if you have moved on):

```sh
tools/package-macos.sh --download-node                 # both runtimes → dist/portal-met-bridge-0.19.1-macos.zip and .dmg
tools/package-macos.sh --download-node --arch arm64    # Apple silicon only → dist/portal-met-bridge-0.19.1-macos-arm64.zip and .dmg (~55 MB)
tools/package-macos.sh                                 # no bundled Node (uses the Mac's own) — for trying the bundle, not for a release
```

On a Mac the script also compiles the launcher (`tools/launcher.c`, needs `xcode-select --install` once), makes the `.icns` icon and the `.dmg`; on Linux it makes only the zip. The script needs no Node on the PATH. Open `dist/Portal Met Bridge.app` once to see that it starts — `~/Library/Logs/portal-met-bridge.log` says what it did.

**Attach — in the browser:** github.com/privaterra/portal-met-bridge/releases → the release (or draft) → **Edit** (pencil) → drop the files on *Attach binaries by dropping them here or selecting them* → wait for the upload bars → **Update release** (or *Publish release* for a draft). To replace a file, delete the old one first (the × beside it) — two assets cannot share a name.

**Attach — from the Terminal** (with `gh` signed in):

```sh
gh release upload v0.19.1 dist/portal-met-bridge-0.19.1-macos.zip dist/portal-met-bridge-0.19.1-macos.dmg --clobber   # --clobber replaces same-named assets
gh release view v0.19.1 --web                                                                                          # check it
```

**Create the whole release by hand** (when the workflow is not available at all — the tag must exist on GitHub):

```sh
gh release create v0.19.1 --draft --prerelease --title "portal-met-bridge 0.19.1 (alpha)" --notes-file docs/releases/v0.19.1.md \
  dist/portal-met-bridge-0.19.1-macos.zip dist/portal-met-bridge-0.19.1-macos.dmg
```

Then open the draft on the web and publish it as in step 7. Name files exactly as the workflow would (`portal-met-bridge-<version>-macos.zip` / `.dmg`, `…-macos-arm64.zip` for an Apple-silicon-only build) so the README's wording and anyone's bookmarks stay right.

**Try a build without releasing:** Actions → Release → *Run workflow* with the tag field **empty** builds the current `main` and leaves the zip and dmg as a workflow *artifact* (a zip of them, on the run's page, kept 90 days) without touching Releases. With a tag in the field it rebuilds that tag and creates or updates its draft release.

## 5. When the Release workflow fails

1. Read the log: Actions → the red run → *macOS app* → the red step. From the Terminal: `gh run list --workflow Release` then `gh run view <run id> --log-failed`.
2. Decide which kind of failure it is:
   - **Transient** (a download from nodejs.org timed out, GitHub had an incident): *Re-run failed jobs* on the run's page, nothing else.
   - **No macOS runner** — *macOS app* is grey (*cancelled*) after about 15 minutes with no steps and no log, and the run's annotations say *The job was not acquired by Runner of type hosted even after multiple attempts* (often beside *Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times*). Nothing is wrong with the tag: GitHub had no Apple-silicon machine free. It happened to v0.19.0 and again, an hour later, to v0.19.1. Since then the workflow answers it itself: the job *macOS app (other runner pool, …)* starts when the first never got a runner and builds on an Intel one (step 5 above). For a tag made before that (or if the second pool is short too): Actions → Release → *Run workflow* → branch `main`, **tag** `vX.Y.Z`, **runner** `macos-26-intel`. That is how the 0.19.1 release was built; the Intel runner started within seconds.
   - **A mistake in the workflow file itself** (`.github/workflows/release.yml` — a step's shell does not parse, a wrong expression): fix it on `main`, publish, then Actions → Release → *Run workflow* → branch `main`, **tag** `vX.Y.Z`. A run started by hand takes the workflow from the branch and the app from the tag, so the tag gets its release without a new version. (*Re-run failed jobs* would not help: it re-runs the workflow as the tag has it.) The v0.19.0 tag carries such a mistake — one stray quote in its tag check — and has no release; 0.19.1 is the same app with the workflow fixed.
   - **The tag does not match** (*tag v0.19.1 but package.json says 0.19.0*): the version was not bumped before tagging. Fix on `main` (bump, commit, `tools/publish.sh`), then move the tag: `git tag -d v0.19.1 && git push origin :refs/tags/v0.19.1 && tools/tag-release.sh`. Fine while nobody has installed that version; the Home Assistant store caches the tag's source, so do not move a tag the store has already offered.
   - **A bug in the build itself** (a script error such as `tools/package-macos.sh: line 80: arch: unbound variable`, which is what stopped v0.17.0): fix it on `main` and **release the next patch version** (0.17.1). A tag points at a commit for good, and the scripts under `tools/` are run from the tag, so re-running the workflow for the broken tag — by hand or not — rebuilds the broken script; the right fix is a new tag with the fixed one. The old tag simply has no release — delete it or leave it; the notes of the next release say what happened.
   - **Libraries and security advisories is red**: a shipped library has a high or critical advisory, or a file in `vendor/` does not match the manifest. The job summary names it and the fixed version. `node tools/vendor.mjs update`, test, commit, publish, and release the next patch version; if the advisory does not apply to how the app uses the library (SECURITY.md lists what is called), record it in `vendor/advisories-accepted.json` with a reason and an end date instead.
   - **403 on the release step**: Settings → Actions → General → *Workflow permissions* → *Read and write permissions*, then *Re-run failed jobs*.
   - **Notarization failed** (only with the Apple secrets): the step prints Apple's log; PACKAGING.md 2.3 lists the usual causes (an expired certificate, a missing entitlement, the wrong Team ID).
3. While the macOS job is broken, people can still install from source (the `…-source.zip` is not made either, but GitHub's own *Source code (zip)* on the tag always is, and `git clone` works) and Home Assistant users are unaffected: the app installs from the tag, not from the release.

The unit test *packaging: tools/package-macos.sh builds the bundle with two Node runtimes* now runs the script with two small stand-in runtimes on every `node tests/run.mjs`, so a regression in that path fails before it is tagged. Since 0.19.0 the tests also parse every shell step of every workflow (`bash -n`), so a quoting mistake in a workflow fails `npm test` and CI instead of a release.

## 5a. Between releases: what GitHub does on its own

- **Every push and pull request** → *CI*: the unit tests and the library report. A red *Libraries and security advisories* on `main` means an advisory was published for something in `vendor/` since the last push — open the run's summary.
- **Every Monday** → *Dependency updates*: fetches the latest libraries, runs the unit and end-to-end tests, and opens a pull request *Update libraries (date)* when something changed. Read the changelog of anything marked *new major version*, check out the branch (`git fetch && git checkout deps/update`), pull a demo shot, download a PDF and a zip, then **Squash and merge** on GitHub (the squashed commit is signed by GitHub) and `git pull` before your next release. It also opens an issue when an advisory remains that no update fixes, and one when the projects the Portal and machine protocols come from have new commits (`vendor/sources.json`; after reading them: `node tools/vendor.mjs sources --record`).
- **Dependabot** → weekly pull requests for the GitHub Actions the workflows use, the development tools (Playwright, socket.io) and the Home Assistant base image, and alerts in the Security tab for the shipped libraries. A Dependabot pull request that only edits `vendor/package.json` cannot be merged as it is (the files would not match): run `node tools/vendor.mjs update` instead and close it.
- Run either workflow by hand from the Actions tab (*Run workflow*) — before a release, say.

## 6. Undoing a release

- **A draft**: delete it on the Releases page (Edit → *Delete*); the tag stays.
- **A published release**: *Delete* on its page removes the release and its assets; the tag remains until you delete it too (`git push origin :refs/tags/v0.19.1`). Anyone who downloaded keeps their copy; Home Assistant installs that already happened keep working, new ones fail if the tag is gone. Prefer publishing a fixed patch version over deleting.
- **A tag** that was never released and that no Home Assistant has installed: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`.

## 7. Checklist (copy into the commit message or an issue)

- [ ] `node tools/vendor.mjs update` and `check` (or the weekly *Update libraries* pull request merged); no open advisory
- [ ] `main` clean and pushed; `node tools/bump-version.mjs X.Y.Z`
- [ ] `homeassistant/portal_met_bridge/CHANGELOG.md` entry; `docs/releases/vX.Y.Z.md` written
- [ ] `node tests/run.mjs` green (`npm run test:e2e` when the change touched the page)
- [ ] commit → `tools/publish.sh` → `tools/tag-release.sh`
- [ ] Actions → Release: *Unit tests*, *Libraries and security advisories* and one of the two *macOS app* jobs green
- [ ] Releases → draft: three assets present, notes read, pre-release ticked for 0.x → **Publish release**
- [ ] downloaded zip opens on the Mac and About shows X.Y.Z; Home Assistant offers the update
