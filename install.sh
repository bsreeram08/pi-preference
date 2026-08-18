#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$AGENT_DIR/backups/pi-workbench/$STAMP"

realpath_portable() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

backup_and_link() {
  local source="$1"
  local target="$2"
  mkdir -p "$(dirname "$target")"

  if [[ -e "$target" || -L "$target" ]]; then
    if [[ "$(realpath_portable "$source")" == "$(realpath_portable "$target")" ]]; then
      printf 'already linked: %s\n' "$target"
      return
    fi
    local backup="$BACKUP_ROOT/$(basename "$target")"
    mkdir -p "$BACKUP_ROOT"
    mv "$target" "$backup"
    printf 'backed up: %s -> %s\n' "$target" "$backup"
  fi

  ln -s "$source" "$target"
  printf 'linked: %s -> %s\n' "$target" "$source"
}

for command in git node python3 pi; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'error: required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

if [[ -d "$ROOT/.git" ]]; then
  git -C "$ROOT" submodule update --init --recursive
fi

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/themes" "$AGENT_DIR/skill-evolution"

TARGET_EXTENSION="$AGENT_DIR/extensions/pi-workbench"
if [[ "$(realpath_portable "$ROOT")" != "$(realpath_portable "$TARGET_EXTENSION")" ]]; then
  backup_and_link "$ROOT" "$TARGET_EXTENSION"
fi
backup_and_link "$ROOT/setup/pi-look" "$AGENT_DIR/extensions/pi-look"
backup_and_link "$ROOT/setup/themes/ember.json" "$AGENT_DIR/themes/ember.json"

python3 - "$AGENT_DIR" "$ROOT" <<'PY'
import json
import os
import pathlib
import shutil
import sys
import tempfile

agent_dir = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
defaults = root / "setup" / "defaults"


def read_json(path, fallback):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_json(path, value, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


# Merge portable Pi defaults without deleting machine-specific settings.
settings_path = agent_dir / "settings.json"
settings = read_json(settings_path, {})
baseline_settings = read_json(defaults / "settings.json", {})
for key, value in baseline_settings.items():
    if key == "packages":
        settings[key] = list(dict.fromkeys([*(settings.get(key) or []), *value]))
    else:
        settings.setdefault(key, value)
settings["theme"] = "ember"
write_json(settings_path, settings)

# Merge explicit preference baselines by stable id; local edits win.
profile_path = agent_dir / "user-profile.json"
profile = read_json(profile_path, {"version": 1, "preferences": []})
baseline_profile = read_json(defaults / "user-profile.json", {"version": 1, "preferences": []})
existing_ids = {item.get("id") for item in profile.get("preferences", []) if isinstance(item, dict)}
for preference in baseline_profile.get("preferences", []):
    if isinstance(preference, dict) and preference.get("id") not in existing_ids:
        profile.setdefault("preferences", []).append(preference)
write_json(profile_path, profile, 0o600)

# Merge trusted skill sources while preserving local cadence and overrides.
evolution_path = agent_dir / "skill-evolution" / "config.json"
evolution = read_json(evolution_path, {})
baseline_evolution = read_json(defaults / "skill-evolution.json", {})
for key, value in baseline_evolution.items():
    if key == "trustedSources":
        current = evolution.get(key) if isinstance(evolution.get(key), list) else []
        known = {item.get("source") for item in current if isinstance(item, dict)}
        evolution[key] = [*current, *[item for item in value if item.get("source") not in known]]
    else:
        evolution.setdefault(key, value)
write_json(evolution_path, evolution, 0o600)

statusline_path = agent_dir / "statusline.json"
if not statusline_path.exists():
    shutil.copy2(defaults / "statusline.json", statusline_path)
PY

if command -v bun >/dev/null 2>&1; then
  (cd "$ROOT" && bun test tests)
else
  printf 'warning: bun is unavailable; skipped the Workbench test suite\n' >&2
fi

SMOKE_OUT="$(mktemp)"
SMOKE_ERR="$(mktemp)"
trap 'rm -f "$SMOKE_OUT" "$SMOKE_ERR"' EXIT
printf '%s\n' '{"type":"get_commands","id":"commands"}' '{"type":"shutdown","id":"done"}' \
  | PI_OFFLINE=1 pi --mode rpc --no-session --no-extensions --extension "$ROOT/index.ts" \
    >"$SMOKE_OUT" 2>"$SMOKE_ERR"
if grep -q 'extension_error' "$SMOKE_OUT" "$SMOKE_ERR"; then
  cat "$SMOKE_ERR" >&2
  printf 'error: Pi Workbench extension smoke test failed\n' >&2
  exit 1
fi

printf '\nPi Workbench installed in %s\n' "$AGENT_DIR"
printf 'Run /reload in an existing Pi session, then /skills-evolve to initialize trusted skills.\n'
