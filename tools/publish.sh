#!/usr/bin/env bash
# publish.sh — sign what is not signed yet, sync with GitHub and push, so every
# commit lands with the green "Verified" badge. Run it from inside the clone:
#
#     tools/publish.sh            # after unpacking a delivery, or after your own commits
#
# What it does, in order:
#   1. refuses to run with uncommitted changes (commit or stash them first);
#   2. fetches origin and, if GitHub has commits you do not have, rebases yours on top;
#   3. re-creates every commit that is not yet on GitHub with your signature
#      (needs commit signing configured — see docs/SIGNED-COMMITS.md, section A4 or B);
#   4. shows the signatures, pushes, and prints the commit URL to check the badge.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
branch=$(git rev-parse --abbrev-ref HEAD)
remote=${REMOTE:-origin}

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes — commit or stash them first:" >&2
  git status --short >&2
  exit 1
fi

fmt=$(git config --get gpg.format || true)
key=$(git config --get user.signingkey || true)
if [ -z "$key" ]; then
  echo "No signing key configured (user.signingkey is empty)." >&2
  echo "Follow docs/SIGNED-COMMITS.md section A (SSH) or B (GPG), then run this again." >&2
  exit 1
fi
echo "Signing with ${fmt:-openpgp} key: $key"
if [ "$(git config --get commit.gpgsign || true)" != "true" ]; then
  echo "Note: commit.gpgsign is not 'true'; this script signs explicitly, but your own future commits will not be signed."
  echo "      git config --global commit.gpgsign true"
fi

git fetch -q "$remote"
behind=$(git rev-list --count "HEAD..$remote/$branch" 2>/dev/null || echo 0)
if [ "$behind" -gt 0 ]; then
  echo "GitHub has $behind commit(s) you do not have (web edits, another clone). Rebasing yours on top…"
  git rebase "$remote/$branch"
fi

ahead=$(git rev-list --count "$remote/$branch..HEAD")
if [ "$ahead" -eq 0 ]; then
  echo "Nothing to push: $branch is level with $remote/$branch."
  exit 0
fi

echo "Signing $ahead commit(s) not yet on GitHub…"
# --amend recreates each commit in place; author, message and trailers survive.
git rebase --exec 'git commit --amend --no-edit -n -S' "$remote/$branch"

echo
git log --show-signature --oneline "$remote/$branch..HEAD" 2>&1 | grep -E 'Good|No signature|^[0-9a-f]{7,}' || true
echo
git push "$remote" "$branch"

url=$(git remote get-url "$remote" | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##')
echo
echo "Pushed. Check the badge at: $url/commit/$(git rev-parse HEAD)"
