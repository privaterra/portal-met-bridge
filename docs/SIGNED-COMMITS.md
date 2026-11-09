# Getting the green "Verified" badge on your commits

GitHub marks a commit **Verified** when it carries a cryptographic signature it can check against a key on your account, *and* the commit's committer e-mail is one of the verified e-mails on that account. Nothing about the commit's content matters — only the signature and the e-mail.

Two ways exist: **SSH signing** (recommended — you probably already have the key) and **GPG**. Both are below, written for macOS and this repository. Budget five minutes for SSH, fifteen for GPG.

The steps assume Git 2.34 or newer (`git --version`; the Xcode command-line tools ship something far newer) and macOS 12 or newer (OpenSSH 8.8+, which added `ssh-keygen -Y sign`).

---

## A. SSH signing (recommended)

### A1. Have an SSH key

```bash
ls -l ~/.ssh/*.pub
```

If a key is listed (for example `id_ed25519.pub`) you can reuse it — the same key can both authenticate and sign. If not, make one:

```bash
ssh-keygen -t ed25519 -C "rguerra@privaterra.org"
# accept the default path (~/.ssh/id_ed25519); a passphrase is optional but a good idea
ssh-add --apple-use-keychain ~/.ssh/id_ed25519   # keeps the passphrase in Keychain
```

### A2. Add the public key to GitHub **as a signing key**

This is the step people miss. A key added as an *authentication* key lets you push; it does **not** verify signatures. The same key has to be added a second time, with the other type.

1. Copy the public half: `pbcopy < ~/.ssh/id_ed25519.pub`
2. GitHub → your avatar → **Settings** → **SSH and GPG keys** → **New SSH key**.
3. **Title**: anything (`MacBook signing`).
4. **Key type**: choose **Signing Key** (not *Authentication Key*).
5. **Key**: paste. **Add SSH key**. Confirm with your password / passkey if asked.

You may now see the same key listed twice on that page, once under *Authentication keys* and once under *Signing keys*. That is correct.

### A3. Make sure the commit e-mail is verified on GitHub

GitHub → **Settings** → **Emails**. The address Git puts in your commits must be there with a green *Verified* tag. Check what Git uses:

```bash
git config --global user.email
```

This repository's history uses `rguerra@privaterra.org`, so that address is the one to have verified. Two things to know:

- If **Keep my email addresses private** *and* **Block command line pushes that expose my email** are both ticked on the Emails page, GitHub will reject pushes that contain your real address. Either untick the *Block* option, or commit with the noreply address GitHub shows on that page (`<id>+privaterra@users.noreply.github.com`) — it counts as verified too.
- Only the **committer** e-mail decides verification. `Co-Authored-By:` trailers (this repository has one on every AI-assisted commit) do not affect it.

### A4. Tell Git to sign with that key

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub   # the .pub file, not the private key
git config --global commit.gpgsign true                      # sign every commit from now on
git config --global tag.gpgsign true                         # and tags
```

Use `--local` instead of `--global` from inside `~/Sites/portal-met-bridge` if you only want this for one repository.

Optional, so that `git log --show-signature` can verify *locally* (GitHub does not need this):

```bash
mkdir -p ~/.config/git
echo "rguerra@privaterra.org $(cat ~/.ssh/id_ed25519.pub)" >> ~/.config/git/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

### A5. Try it

```bash
cd ~/Sites/portal-met-bridge
git commit --allow-empty -m "test: signed commit"
git log --show-signature -1        # "Good \"git\" signature for rguerra@privaterra.org with ED25519 key …"
git push
```

Open the commit on github.com — it should carry a green **Verified** badge; clicking it names the key. Then drop the test commit if you like (`git reset --hard HEAD~1` before pushing, or leave it; it is harmless).

---

## B. GPG signing (alternative)

Use this if you already have a GPG key or your organisation requires GPG.

```bash
brew install gnupg pinentry-mac
echo "pinentry-program $(brew --prefix)/bin/pinentry-mac" >> ~/.gnupg/gpg-agent.conf
gpgconf --kill gpg-agent

gpg --full-generate-key
#   kind: (9) ECC (sign and encrypt) → Curve 25519   (or RSA 4096)
#   expiry: your call; name: Robert Guerra; e-mail: rguerra@privaterra.org  ← must match a verified GitHub e-mail

gpg --list-secret-keys --keyid-format=long
#   sec   ed25519/ABCDEF1234567890 …   ← the part after the slash is the key id
gpg --armor --export ABCDEF1234567890 | pbcopy
```

GitHub → **Settings** → **SSH and GPG keys** → **New GPG key** → paste → **Add GPG key**.

```bash
git config --global gpg.format openpgp          # the default; only needed if you set ssh earlier
git config --global user.signingkey ABCDEF1234567890
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

Commit and push as in A5. macOS will show a pinentry dialog for the passphrase; tick *Save in Keychain*.

---

## C. Signing the commits this project's AI session produces

The commits made in the Claude session arrive on your Mac unsigned, as a zip that is unpacked into `~/Sites/portal-met-bridge` (the session never holds your keys, and should not). Signing happens on your side, before `git push`. Once A4 or B is in place:

**One new commit** (the usual case — each delivery is one commit ahead of `origin/main`):

```bash
cd ~/Sites/portal-met-bridge
git log --oneline origin/main..main          # confirm it is the one you expect
git commit --amend --no-edit                 # re-creates the commit, now signed (commit.gpgsign=true)
git log --show-signature -1
git push
```

Author, message, `Co-Authored-By:` and `Claude-Session:` trailers all survive `--amend --no-edit`; only the signature (and the committer timestamp) changes.

**Several unpushed commits:**

```bash
git rebase --exec 'git commit --amend --no-edit -n -S' origin/main
git push
```

(`-n` skips hooks, `-S` forces a signature even in a repository where `commit.gpgsign` is off.)

**Commits that are already on GitHub** (v0.1 – v0.6 here) can only be made *Verified* by rewriting them, which changes every commit id after the first one and needs a force push:

```bash
git rebase --exec 'git commit --amend --no-edit -n -S' --root
git push --force-with-lease
```

Nobody else has a clone of this repository that matters yet, so this is safe today; it stops being polite the moment someone forks or opens a pull request. Your call — the project loses nothing by leaving old history unsigned and signing from here on.

**Shortcut for every future delivery:** `tools/publish.sh` in this repository does the fetch-rebase-sign-push sequence with checks (section C2), or as a bare alias:

```bash
git config --global alias.signpush '!git pull --rebase && git rebase --exec "git commit --amend --no-edit -n -S" origin/main && git push'
# then, after unpacking a delivery:  git signpush
```

---

## C2. Every delivery, step by step (the routine)

This is the whole routine for getting a change from the AI session onto GitHub as **Verified**, assuming A1–A4 (or B) are done once. It is also what `tools/publish.sh` automates.

1. **Unpack** the delivery. The session copies the new files into `~/Sites/portal-met-bridge` itself (or you unzip the delivered zip over it). Confirm the state:
   ```bash
   cd ~/Sites/portal-met-bridge
   git status --short                      # should print nothing: the delivery arrives committed
   git log --oneline origin/main..main     # the commit(s) about to be published
   ```
2. **Sync with GitHub first.** Edits made on github.com (the web editor, merging a pull request, deleting a workflow file) live only on GitHub until you fetch them. Skipping this is what produces `! [rejected] main -> main (fetch first)`.
   ```bash
   git fetch origin
   git log --oneline main..origin/main     # anything here is on GitHub but not on your Mac
   git rebase origin/main                  # put your unpublished commit(s) on top of it
   ```
   `git pull --rebase` does the same two steps in one. Do not use plain `git pull` here: it creates a merge commit, which is harmless but clutters the history with "Merge branch 'main' of …" entries.
3. **Sign the unpublished commit(s).** The session's commits are unsigned (it never has your key). With `commit.gpgsign true` the rebase in step 2 already re-signed them; to be sure, or when nothing needed rebasing:
   ```bash
   git rebase --exec 'git commit --amend --no-edit -n -S' origin/main
   git log --show-signature origin/main..main     # "Good \"git\" signature …" on each
   ```
4. **Push and check.**
   ```bash
   git push
   ```
   Open `https://github.com/privaterra/portal-met-bridge/commits/main` — each new commit should carry the green **Verified** badge; clicking the badge names your key and e-mail.

Or, all of the above in one go, with the same checks:
```bash
tools/publish.sh
```
It refuses to run on a dirty tree, tells you when no signing key is configured, rebases onto GitHub when needed, signs what is not yet on GitHub, pushes and prints the commit URL.

If the push is still rejected after this, someone pushed between your fetch and your push; run the script (or steps 2–4) once more.

## D. Vigilant mode (optional, stricter)

GitHub → **Settings** → **SSH and GPG keys** → **Vigilant mode** → tick **Flag unsigned commits as unverified**. With it on, *every* commit attributed to you shows a badge: **Verified**, **Partially verified** or **Unverified**. It is honest about history — your earlier unsigned commits will be labelled *Unverified* — so turn it on only once new commits are being signed, and keep in mind that commits made through GitHub's web editor are signed by GitHub automatically.

---

## E. If the badge does not appear

| Symptom | Cause / fix |
|---|---|
| Commit shows **Unverified** with "No user is associated with the committer email" | The commit e-mail is not a verified address on your account (A3). |
| **Unverified**, "The key used to sign this commit isn't associated with any GitHub account" | The key was added as an *Authentication Key* only, or not at all (A2). |
| No badge at all | The commit is unsigned — `commit.gpgsign` not set, or the commit was created before you set it (amend it, section C). |
| `error: Load key "…id_ed25519.pub": invalid format` | `user.signingkey` must point at the **.pub** file for SSH signing, or at the key id for GPG. |
| `gpg failed to sign the data` on an SSH setup | `gpg.format` is still `openpgp`; run `git config --global gpg.format ssh`. |
| `ssh-keygen: unknown option -- Y` | OpenSSH older than 8.8; update macOS or `brew install openssh`. |
| Signing asks for the passphrase on every commit | `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` (SSH) or tick *Save in Keychain* in the pinentry dialog (GPG). |
| `git log --show-signature` says "No principal matched" | Local verification only; add the `allowed_signers` file (end of A4). GitHub's badge does not depend on it. |
| `git push` → `! [rejected] main -> main (fetch first)` | GitHub has commits your Mac does not (web edits, a merged PR). `git pull --rebase`, re-sign (section C2 step 3), push again. |
| A rebase or amend made a signed commit **Unverified** | Rewriting a commit drops its signature unless Git re-signs it: set `commit.gpgsign true`, or pass `-S` in the `--exec` as in C2. |

References: GitHub Docs → *About commit signature verification*, *Telling Git about your signing key*, *Signing commits*.
