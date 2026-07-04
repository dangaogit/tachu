#!/usr/bin/env bash
#
# Tachu monorepo one-shot release script.
#
# Workflow:
# 0. interactive version bump (unless --no-bump / --dry-run): pick a semver
#    release type (major/minor/patch/pre*/prerelease/release — rc.N -> rc.N+1),
#    write every workspace package.json, prepend a CHANGELOG entry, bun install
#    to sync the lockfile, and commit the bump.
# 1. git working tree clean check (unless --skip-git-check)
# 2. bun install --frozen-lockfile
# 3. bun run typecheck (all workspaces)
# 4. bun test (full suite must pass; hard blocker per release policy)
# 5. bun run build (emit dist/ for all workspaces) + artifact validation
# 6. bun publish in dependency order: core -> extensions -> host-defaults -> cli
# (always with --access public so first publish of scoped packages
# does not fail with "This package has been marked as private")
#
# Usage:
# scripts/publish.sh # interactive bump, then publish (tag inferred from version)
# scripts/publish.sh --release-as=prerelease # non-interactive rc.N -> rc.N+1
# scripts/publish.sh --release-as=minor # non-interactive minor bump
# scripts/publish.sh --release-as=1.2.3 # non-interactive explicit version
# scripts/publish.sh --no-bump # publish the current version as-is (no bump/commit)
# scripts/publish.sh --yes # skip the bump confirmation prompt
# scripts/publish.sh --dry-run # inspect tarball contents only (no bump/commit)
# scripts/publish.sh --tag=latest # force dist-tag (default: rc for pre-release, latest for stable)
# scripts/publish.sh --tag=next # publish to a preview channel
# scripts/publish.sh --access=restricted # override (scoped private releases)
# scripts/publish.sh --skip-git-check # skip dirty workspace gate
#
# Tag inference: when --tag is omitted, a pre-release version (contains "-")
# publishes under "rc" and a stable version under "latest".
#
# Requirements:
# - bun >= 1.3.14
# - valid npm credentials (bun login, NPM_TOKEN env, or ~/.npmrc)
# - write access to @tachu scope on the configured registry
#
set -euo pipefail

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

DRY_RUN=""
TAG=""
TAG_EXPLICIT=0
ACCESS="public"
SKIP_GIT_CHECK=0
NO_BUMP=0
RELEASE_AS=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="--dry-run"
      shift
      ;;
    --tag)
      TAG="$2"
      TAG_EXPLICIT=1
      shift 2
      ;;
    --tag=*)
      TAG="${1#*=}"
      TAG_EXPLICIT=1
      shift
      ;;
    --access)
      ACCESS="$2"
      shift 2
      ;;
    --access=*)
      ACCESS="${1#*=}"
      shift
      ;;
    --release-as)
      RELEASE_AS="$2"
      shift 2
      ;;
    --release-as=*)
      RELEASE_AS="${1#*=}"
      shift
      ;;
    --no-bump)
      NO_BUMP=1
      shift
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --skip-git-check)
      SKIP_GIT_CHECK=1
      shift
      ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //; s/^#$//'
      exit 0
      ;;
 *)
      printf "%sUnknown argument: %s%s\n" "$RED" "$1" "$RESET" >&2
      exit 1
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Mirror root README/LICENSE/CHANGELOG into each package just before publish, then clean up.
PACKAGES=("core" "extensions" "host-defaults" "cli")
MIRRORED_FILES=("README.md" "README_ZH.md" "LICENSE" "CHANGELOG.md")

cleanup_mirrored_files() {
  for pkg in "${PACKAGES[@]}"; do
    for f in "${MIRRORED_FILES[@]}"; do
      rm -f "packages/$pkg/$f"
    done
  done
}
trap cleanup_mirrored_files EXIT

log_step() {
  printf "\n%s▶ %s%s\n" "$CYAN" "$1" "$RESET"
}

log_ok() {
  printf "%s✓ %s%s\n" "$GREEN" "$1" "$RESET"
}

log_warn() {
  printf "%s⚠ %s%s\n" "$YELLOW" "$1" "$RESET"
}

log_fail() {
  printf "%s✗ %s%s\n" "$RED" "$1" "$RESET" >&2
}

# ---- 1/6 git clean -----------------------------------------------------------
log_step "1/6 git working tree"
if [[ $SKIP_GIT_CHECK -eq 0 ]]; then
  if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
    log_fail "Git working tree is dirty. Commit/stash or pass --skip-git-check."
    git status --short >&2 || true
    exit 1
  fi
  log_ok "clean"
else
  log_warn "skipped per --skip-git-check"
fi

# ---- version bump (interactive semver + CHANGELOG + lockfile + commit) --------
if [[ $NO_BUMP -eq 0 && -z "$DRY_RUN" ]]; then
  log_step "version bump (semver + CHANGELOG + lockfile + commit)"
  BUMP_ARGS=()
  [[ -n "$RELEASE_AS" ]] && BUMP_ARGS+=("$RELEASE_AS")
  [[ $ASSUME_YES -eq 1 ]] && BUMP_ARGS+=("--yes")
  bun scripts/bump-version.ts ${BUMP_ARGS[@]+"${BUMP_ARGS[@]}"}

  NEW_VERSION="$(bun --print 'JSON.parse(await Bun.file("packages/core/package.json").text()).version')"

  log_step "bun install (sync lockfile to ${NEW_VERSION})"
  bun install
  log_ok "lockfile synced"

  log_step "git commit — chore(release): bump workspace to ${NEW_VERSION}"
  git add packages/*/package.json CHANGELOG.md bun.lock
  git commit -m "chore(release): bump workspace to ${NEW_VERSION}"
  log_ok "committed bump ${NEW_VERSION}"
elif [[ -n "$DRY_RUN" ]]; then
  log_warn "version bump skipped (dry-run — publishing current version)"
else
  log_warn "version bump skipped (--no-bump — publishing current version)"
fi

# ---- 2/6 bun install ---------------------------------------------------------
log_step "2/6 bun install --frozen-lockfile"
bun install --frozen-lockfile
log_ok "install OK"

# ---- 3/6 typecheck -----------------------------------------------------------
log_step "3/6 bun run typecheck"
bun run typecheck
log_ok "typecheck OK (all workspaces, 0 error)"

# ---- 4/6 tests (hard gate) ---------------------------------------------------
log_step "4/6 bun test (hard gate — must pass)"
bun test
log_ok "tests PASS"

# ---- 5/6 build (emit dist/ for every package) --------------------------------
log_step "5/6 bun run build (clean + tsc + copy md assets)"
bun run --filter '*' build
log_ok "build OK"

# ---- version sanity ----------------------------------------------------------
VERSION="$(bun --print 'JSON.parse(await Bun.file("packages/core/package.json").text()).version')"
EXT_VERSION="$(bun --print 'JSON.parse(await Bun.file("packages/extensions/package.json").text()).version')"
HOST_DEFAULTS_VERSION="$(bun --print 'JSON.parse(await Bun.file("packages/host-defaults/package.json").text()).version')"
CLI_VERSION="$(bun --print 'JSON.parse(await Bun.file("packages/cli/package.json").text()).version')"

if [[ "$VERSION" != "$EXT_VERSION" || "$VERSION" != "$HOST_DEFAULTS_VERSION" || "$VERSION" != "$CLI_VERSION" ]]; then
  log_fail "Version mismatch: core=$VERSION extensions=$EXT_VERSION host-defaults=$HOST_DEFAULTS_VERSION cli=$CLI_VERSION"
  log_fail "All public packages must share the same version. Aborting."
  exit 1
fi

# Infer the dist-tag from the version when the caller did not force one:
# a pre-release (contains "-") goes to "rc", a stable version to "latest".
if [[ $TAG_EXPLICIT -eq 0 ]]; then
  if [[ "$VERSION" == *"-"* ]]; then
    TAG="rc"
  else
    TAG="latest"
  fi
  log_ok "dist-tag inferred: ${TAG} (from version ${VERSION})"
fi

if [[ "$TAG" == "latest" && "$VERSION" == *"-"* ]]; then
  log_fail "Refusing to publish a pre-release version (${VERSION}) under --tag=latest."
  log_fail "Use --tag=rc | --tag=next, or bump to a stable version first."
  exit 1
fi

# ---- mirror root docs into each package --------------------------------------
log_step "mirroring README / LICENSE / CHANGELOG into packages"
for pkg in "${PACKAGES[@]}"; do
  for f in "${MIRRORED_FILES[@]}"; do
    if [[ -f "$f" ]]; then
      cp "$f" "packages/$pkg/$f"
    fi
  done
done
log_ok "mirrored into ${#PACKAGES[@]} packages"

log_step "validating release artifacts"
bun scripts/validate-release-artifacts.ts --require-built-artifacts --require-mirrored-docs
log_ok "release artifact validation OK"

# ---- 6/6 publish -------------------------------------------------------------
log_step "6/6 publishing — version ${BOLD}${VERSION}${RESET}${CYAN}, tag=${BOLD}${TAG}${RESET}${CYAN}, access=${BOLD}${ACCESS}${RESET}${CYAN}${DRY_RUN:+, dry-run}${RESET}"

for pkg in "${PACKAGES[@]}"; do
  PKG_DIR="packages/$pkg"
  PKG_NAME="@tachu/$pkg"
  printf "\n  %s•%s publishing %s%s%s\n" "$CYAN" "$RESET" "$BOLD" "$PKG_NAME" "$RESET"
  (
    cd "$PKG_DIR"
 # shellcheck disable=SC2086
    bun publish --access "$ACCESS" --tag "$TAG" $DRY_RUN
  )
  log_ok "$PKG_NAME@$VERSION"
done

echo ""
if [[ -n "$DRY_RUN" ]]; then
  log_ok "Dry run complete. No changes published."
  log_warn "Re-run without --dry-run to perform the real publish."
else
  log_ok "Published @tachu/core@${VERSION}, @tachu/extensions@${VERSION}, @tachu/host-defaults@${VERSION}, @tachu/cli@${VERSION} with tag '${TAG}'"
  printf "%s💡 Install:%s bun add @tachu/cli@%s\n" "$YELLOW" "$RESET" "$TAG"
  printf "%s💡 Tag on git:%s git tag v%s && git push --tags\n" "$YELLOW" "$RESET" "$VERSION"
fi
