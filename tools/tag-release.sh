#!/usr/bin/env bash
# tag-release.sh — tag the current commit with the version in package.json and
# push the tag, which starts .github/workflows/release.yml (the macOS app on a
# draft GitHub Release) and makes the Home Assistant app installable at that
# version (its Dockerfile downloads the tag). Run it after tools/publish.sh:
#
#     node tools/bump-version.mjs 0.14.0   # once per release, then commit
#     tools/publish.sh                     # sign and push main
#     tools/tag-release.sh                 # tag v0.14.0 (signed) and push it
#
# Refuses to tag a commit that is not on GitHub yet, or a version already tagged.
# Needs only git and sed; with Node on the PATH it also checks the shipped libraries for
# security advisories first (see below).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
remote=${REMOTE:-origin}
# The version from package.json, without needing Node on the PATH (a plain sed on the "version" line).
version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
[ -n "$version" ] || { echo "could not read the version from package.json" >&2; exit 1; }
tag="v$version"
if [ -n "$(git status --porcelain)" ]; then echo "Working tree has uncommitted changes — commit them first." >&2; exit 1; fi
git fetch -q "$remote" --tags
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "$tag already exists (git tag -d $tag && git push $remote :refs/tags/$tag to redo it)." >&2; exit 1; fi
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$(git rev-list --count "$remote/$branch..HEAD")" -gt 0 ]; then echo "HEAD is ahead of $remote/$branch — run tools/publish.sh first." >&2; exit 1; fi
ha="$(sed -n 's/^version: "\(.*\)"$/\1/p' homeassistant/portal_met_bridge/config.yaml)"
if [ "$ha" != "$version" ]; then echo "homeassistant/portal_met_bridge/config.yaml says $ha, package.json $version — run node tools/bump-version.mjs $version" >&2; exit 1; fi
# Libraries: a release is not tagged while a shipped library has a known high or critical
# advisory, and newer versions are pointed out (tools/vendor.mjs; SECURITY.md).
# Needs Node; without it the Release workflow still runs the same check before building.
if [ "${SKIP_DEP_CHECK:-0}" = "1" ]; then
  echo "(SKIP_DEP_CHECK=1: not checking the libraries)"
elif command -v node >/dev/null 2>&1 && [ -f tools/vendor.mjs ]; then
  set +e
  node tools/vendor.mjs check --level high
  code=$?
  set -e
  case "$code" in
    0) echo ;;
    2) echo "(npm could not be reached: advisories not checked here — the Release workflow checks again)"; echo ;;
    *) echo >&2; echo "Not tagging $tag: see above. Fix with  node tools/vendor.mjs update  (then test, commit, tools/publish.sh), or record an advisory that does not apply in vendor/advisories-accepted.json. To tag anyway: SKIP_DEP_CHECK=1 tools/tag-release.sh" >&2; exit 1 ;;
  esac
else
  echo "(node is not on the PATH: skipping the library check; the Release workflow runs it before building)"
fi
if [ -n "$(git config --get user.signingkey || true)" ]; then git tag -s "$tag" -m "portal-met-bridge $tag"; else git tag -a "$tag" -m "portal-met-bridge $tag"; fi
git push "$remote" "$tag"
url=$(git remote get-url "$remote" | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##')
echo
echo "Tagged $tag. The release workflow is at $url/actions — when it finishes, publish the draft at $url/releases."
