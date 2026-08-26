#!/usr/bin/env python3
"""Validate and transactionally apply the optional opinionated Pi profile."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import stat
import tempfile
from typing import Any

MAX_CONFIG_BYTES = 5 * 1024 * 1024


class ConfigError(RuntimeError):
    pass


def read_object(path: pathlib.Path, *, missing: dict[str, Any] | None = None) -> dict[str, Any]:
    if path.is_symlink():
        raise ConfigError(f"configuration path must not be a symbolic link: {path}")
    if not path.exists():
        if missing is None:
            raise ConfigError(f"required JSON file is missing: {path}")
        return dict(missing)
    if not path.is_file():
        raise ConfigError(f"configuration path must be a regular file: {path}")
    if path.stat().st_size > MAX_CONFIG_BYTES:
        raise ConfigError(f"configuration file is too large: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConfigError(f"invalid JSON in {path}: {error}") from error
    if not isinstance(value, dict):
        raise ConfigError(f"configuration root must be an object: {path}")
    return value


def validate_settings(value: dict[str, Any], path: pathlib.Path) -> None:
    packages = value.get("packages")
    if packages is not None and not isinstance(packages, list):
        raise ConfigError(f"packages must be an array in {path}")


def validate_profile(value: dict[str, Any], path: pathlib.Path) -> None:
    preferences = value.get("preferences", [])
    if not isinstance(preferences, list) or any(not isinstance(item, dict) for item in preferences):
        raise ConfigError(f"preferences must be an array of objects in {path}")
    ids = [item.get("id") for item in preferences]
    if any(not isinstance(item_id, str) or not item_id.strip() for item_id in ids):
        raise ConfigError(f"every preference requires a non-empty id in {path}")
    if len(ids) != len(set(ids)):
        raise ConfigError(f"preference ids must be unique in {path}")


def validate_evolution(value: dict[str, Any], path: pathlib.Path) -> None:
    trusted = value.get("trustedSources", [])
    if not isinstance(trusted, list) or any(not isinstance(item, dict) for item in trusted):
        raise ConfigError(f"trustedSources must be an array of objects in {path}")
    for item in trusted:
        if not isinstance(item.get("source"), str) or not isinstance(item.get("repository"), str):
            raise ConfigError(f"every trusted source requires source and repository strings in {path}")


def merge_settings(current: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    merged = dict(current)
    authoritative_keys = {"defaultProvider", "defaultModel", "defaultThinkingLevel", "theme"}
    for key, value in baseline.items():
        if key == "packages":
            existing = merged.get(key) if isinstance(merged.get(key), list) else []
            merged[key] = list(dict.fromkeys([*existing, *value]))
        elif key in authoritative_keys:
            merged[key] = value
        else:
            merged.setdefault(key, value)
    return merged


def merge_profile(current: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    merged = dict(current)
    preferences = list(merged.get("preferences", []))
    existing_ids = {item.get("id") for item in preferences}
    for preference in baseline.get("preferences", []):
        if preference.get("id") not in existing_ids:
            preferences.append(preference)
            existing_ids.add(preference.get("id"))
    merged["version"] = merged.get("version", baseline.get("version", 1))
    merged["preferences"] = preferences
    return merged


def merge_evolution(current: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    merged = dict(current)
    for key, value in baseline.items():
        if key == "trustedSources":
            existing = merged.get(key) if isinstance(merged.get(key), list) else []
            known = {item.get("source") for item in existing if isinstance(item, dict)}
            merged[key] = [*existing, *[item for item in value if item.get("source") not in known]]
        else:
            merged.setdefault(key, value)
    return merged


def linked_worktree_uses_primary_gitdir(root: pathlib.Path, target_extension: pathlib.Path) -> bool:
    git_file = root / ".git"
    target_git_dir = target_extension / ".git"
    if not git_file.is_file() or git_file.is_symlink() or not target_git_dir.is_dir():
        return False
    try:
        marker = git_file.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as error:
        raise ConfigError(f"cannot inspect worktree metadata: {git_file}") from error
    if not marker.startswith("gitdir:"):
        raise ConfigError(f"invalid worktree metadata: {git_file}")
    raw_git_dir = pathlib.Path(marker.removeprefix("gitdir:").strip())
    git_dir = (raw_git_dir if raw_git_dir.is_absolute() else root / raw_git_dir).resolve()
    worktrees_dir = (target_git_dir.resolve() / "worktrees")
    try:
        git_dir.relative_to(worktrees_dir)
        return True
    except ValueError:
        return False


def encoded_json(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def atomic_write(path: pathlib.Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def mode_for(path: pathlib.Path, fallback: int) -> int:
    return stat.S_IMODE(path.stat().st_mode) if path.exists() else fallback


def validate_parent_chain(base: pathlib.Path, path: pathlib.Path) -> None:
    current = base
    if current.is_symlink() or (current.exists() and not current.is_dir()):
        raise ConfigError(f"configuration parent must be a real directory: {current}")
    for part in path.parent.relative_to(base).parts:
        current /= part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise ConfigError(f"configuration parent must be a real directory: {current}")
        if not current.exists():
            return


def load_plan(agent_dir: pathlib.Path, root: pathlib.Path, *, full: bool) -> list[tuple[pathlib.Path, bytes, int, str]]:
    marker_path = agent_dir / "update" / "pi-workbench" / "profile.json"
    validate_parent_chain(agent_dir, marker_path)
    if marker_path.is_symlink():
        raise ConfigError(f"configuration path must not be a symbolic link: {marker_path}")
    if marker_path.exists() and not marker_path.is_file():
        raise ConfigError(f"configuration path must be a regular file: {marker_path}")
    selected_profile = "full" if full else "default"
    plan = [
        (marker_path, encoded_json({"version": 1, "profile": selected_profile}), 0o600, "profile.json"),
    ]
    if not full:
        return plan

    defaults = root / "setup" / "defaults"
    settings_path = agent_dir / "settings.json"
    profile_path = agent_dir / "user-profile.json"
    evolution_path = agent_dir / "skill-evolution" / "config.json"
    statusline_path = agent_dir / "statusline.json"

    baseline_settings = read_object(defaults / "settings.json")
    baseline_profile = read_object(defaults / "user-profile.json")
    baseline_evolution = read_object(defaults / "skill-evolution.json")
    baseline_statusline = read_object(defaults / "statusline.json")
    settings = read_object(settings_path, missing={})
    profile = read_object(profile_path, missing={"version": 1, "preferences": []})
    evolution = read_object(evolution_path, missing={})

    validate_settings(baseline_settings, defaults / "settings.json")
    validate_settings(settings, settings_path)
    validate_profile(baseline_profile, defaults / "user-profile.json")
    validate_profile(profile, profile_path)
    validate_evolution(baseline_evolution, defaults / "skill-evolution.json")
    validate_evolution(evolution, evolution_path)

    plan.extend([
        (settings_path, encoded_json(merge_settings(settings, baseline_settings)), mode_for(settings_path, 0o600), "settings.json"),
        (profile_path, encoded_json(merge_profile(profile, baseline_profile)), 0o600, "user-profile.json"),
        (evolution_path, encoded_json(merge_evolution(evolution, baseline_evolution)), 0o600, "skill-evolution-config.json"),
    ])
    if statusline_path.is_symlink():
        raise ConfigError(f"configuration path must not be a symbolic link: {statusline_path}")
    if not statusline_path.exists():
        plan.append((statusline_path, encoded_json(baseline_statusline), 0o644, "statusline.json"))
    elif not statusline_path.is_file():
        raise ConfigError(f"configuration path must be a regular file: {statusline_path}")
    return plan


def apply_plan(plan: list[tuple[pathlib.Path, bytes, int, str]], backup_root: pathlib.Path) -> list[pathlib.Path]:
    changed = [item for item in plan if not item[0].exists() or item[0].read_bytes() != item[1]]
    if not changed:
        return []

    originals: dict[pathlib.Path, tuple[bytes, int] | None] = {}
    try:
        for path, data, mode, backup_name in changed:
            if path.exists():
                originals[path] = (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
                backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.chmod(backup_root, 0o700)
                backup = backup_root / "config" / backup_name
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, backup)
            else:
                originals[path] = None
            atomic_write(path, data, mode)
        return [item[0] for item in changed]
    except Exception:
        for path, original in reversed(list(originals.items())):
            if original is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, original[0], original[1])
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "apply", "relationship"))
    parser.add_argument("--agent-dir", required=True, type=pathlib.Path)
    parser.add_argument("--root", required=True, type=pathlib.Path)
    parser.add_argument("--backup-root", type=pathlib.Path)
    parser.add_argument("--target-extension", type=pathlib.Path)
    parser.add_argument("--full", action="store_true")
    arguments = parser.parse_args()

    if arguments.action == "relationship":
        if arguments.target_extension is None:
            parser.error("--target-extension is required for relationship")
        if linked_worktree_uses_primary_gitdir(arguments.root, arguments.target_extension):
            print("linked worktree depends on the target extension's Git metadata")
            return 3
        print("worktree relationship: safe")
        return 0

    plan = load_plan(arguments.agent_dir, arguments.root, full=arguments.full)
    if arguments.action == "preflight":
        print(f"installation profile preflight: {'full' if arguments.full else 'default'}")
        return 0
    if arguments.backup_root is None:
        parser.error("--backup-root is required for apply")

    changed = apply_plan(plan, arguments.backup_root)
    if changed:
        for path in changed:
            print(f"configured: {path}")
    else:
        print("installation profile: already current")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigError as error:
        raise SystemExit(f"error: {error}") from error
