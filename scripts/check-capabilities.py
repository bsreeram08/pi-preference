#!/usr/bin/env python3
"""Read-only validator for the committed Pi user-agent capability inventory."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "setup" / "capabilities.v1.json"
MAX_JSON_BYTES = 1024 * 1024
EXPECTED_PACKAGE_POLICIES = [
    ("@imsus/pi-extension-minimax-coding-plan-mcp", "^1.0.2", "1.0.2", "sha512-71T4A16Eiv9lp8o8Qfn1F63strEVRi9IGtMTwtDrje34yR+VtxYVUwRB+PmBg49rIWf22I5yWxk5LhIDuhF/zw=="),
    ("@capyup/pi-goal", "^0.6.0", "0.6.0", "sha512-Ohn5YjnYi2CcQuxyRAAXIZPQuKQMt+ED5GGBUX28W7YH9L6WXw+7rh35dFF+Z6CSL1fYnVSZ4S08ezZS7wSBRA=="),
    ("pi-lmstudio", "^1.5.0", "1.5.0", "sha512-Bnl9c4pmm1BrjUVI7DSPPH78H/md3XqLAx87hjMDzDnntTS5btryrXB3wLPPqgD93EsUzbfm7E9jlwmh8ChPIA=="),
    ("pi-subagents", "^0.52.1", "0.52.1", "sha512-9K9tICAbDBJ82op5wvFAIZFhg7K5Cv6du5hEsnf4o6/qhoslla1WcV11cOyB4tzKAHUIXA2GLA6kfxxLXzIpyg=="),
    ("@vigolium/piolium", "^0.0.13", "0.0.13", "sha512-FrrGJR/XnAwUVdNsnAXEPS6mpHoUBS3nt8s5SKHOKM8P/8DOynYw+EGgEfbXPcaLHNjMnXChUMAlKN8G6ma8SA=="),
    ("context-mode", "^1.0.169", "1.0.169", "sha512-94JIaFuLjF9SO2BsGTrbGtyT44K95+9OC8BdbaL/UT76xOkanJLfUR5CzmNw+GELXZQqH4nBrKg9wjBnSFkVnQ=="),
    ("pi-background-tasks", "^2.4.2", "2.4.2", "sha512-KDH2yv5yKnc2slUNMSsysVZleriuv8tbhe5L+AeplVAfijQsECN5YAWOz5TDbStCXLdJC15GaUQ1P87BXGk5Hg=="),
    ("@juicesharp/rpiv-ask-user-question", "^2.6.2", "2.6.2", "sha512-DS9yZHcaPr+/nf0x2CCfiXBod/1aWjGyakGM3lZAObuGDhYI0nFRE5gxTcCOfQug6JtJXjt1GlzyX8Pljefdzg=="),
    ("@juicesharp/rpiv-todo", "^2.6.2", "2.6.2", "sha512-Lt2HzNaKWgOl7/nEJrxtRsKoIQJTZd32BeckDxJ0JGvoUmwYvqOicSpXbgKVZwyGqGBw90WBKYWkEggo9U/Q4Q=="),
]
EXPECTED_PACKAGES = [f"npm:{name}" for name, _, _, _ in EXPECTED_PACKAGE_POLICIES]
EXPECTED_EXTENSIONS = ["cmux-session.ts", "cmux-workbench.ts", "pi-look", "pi-workbench", "startup-header.ts"]
EXPECTED_EXTENSION_LINKS = {
    "cmux-workbench.ts": "pi-workbench/setup/cmux-workbench.ts",
    "pi-look": "pi-workbench/setup/pi-look",
    "startup-header.ts": "pi-workbench/startup-header.ts",
}
EXPECTED_THEMES = ["ember.json"]
EXPECTED_THEME_LINKS = {"ember.json": "extensions/pi-workbench/setup/themes/ember.json"}
EXPECTED_EXCLUSIONS = ["npm:pi-autoresearch", "npm:@dietrichgebert/ponytail"]
PACKAGE_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
CANONICAL_VERSION = re.compile(r"^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


class UnsafeState(Exception):
    pass


def read_json(path: Path, *, required: bool, reject_symlink: bool = False) -> Any:
    try:
        info = path.lstat()
    except FileNotFoundError:
        if required:
            raise UnsafeState("required capability JSON is missing")
        return {}
    except OSError as exc:
        raise UnsafeState("cannot inspect required capability JSON") from exc
    if reject_symlink and stat.S_ISLNK(info.st_mode):
        raise UnsafeState("capability configuration must not be a symlink")
    if not stat.S_ISREG(info.st_mode):
        raise UnsafeState("capability JSON must be a regular file")
    if info.st_size > MAX_JSON_BYTES:
        raise UnsafeState("capability JSON is oversized")
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise UnsafeState("capability JSON is malformed or unreadable") from exc


def package_name_from_spec(source: Any) -> str | None:
    if not isinstance(source, str) or not source.startswith("npm:"):
        return None
    name = source[4:]
    return name if PACKAGE_NAME.fullmatch(name) else None


def source_name(item: Any) -> str | None:
    if isinstance(item, str):
        return package_name_from_spec(item)
    if isinstance(item, dict):
        return package_name_from_spec(item.get("source") or item.get("package"))
    return None


def filtered(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    if item.get("autoload") is False or item.get("enabled") is False:
        return True
    return any(key in item for key in ("extensions", "skills", "prompts", "themes", "include", "exclude"))


def resource_source(item: Any) -> str | None:
    value = item if isinstance(item, str) else item.get("source") if isinstance(item, dict) else None
    return value if isinstance(value, str) and value and "\x00" not in value else None


def approved_real_target(base: Path, relative: str, expected_kind: str) -> Path | None:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        return None
    cursor = base
    try:
        base_info = cursor.lstat()
        if stat.S_ISLNK(base_info.st_mode) or not stat.S_ISDIR(base_info.st_mode):
            return None
        for part in candidate.parts:
            cursor = cursor / part
            info = cursor.lstat()
            if stat.S_ISLNK(info.st_mode):
                return None
        final_info = cursor.lstat()
        if expected_kind == "file" and not stat.S_ISREG(final_info.st_mode):
            return None
        if expected_kind == "directory" and not stat.S_ISDIR(final_info.st_mode):
            return None
        return cursor.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError):
        return None


def finding(code: str, category: str, name: str) -> dict[str, str]:
    return {"code": code, "category": category, "name": name}


def redacted_identity(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8', errors='replace')).hexdigest()[:16]}"


def validate_manifest() -> dict[str, Any]:
    value = read_json(MANIFEST, required=True, reject_symlink=True)
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("inventoryVersion") != 1 or value.get("scope") != "user-agent":
        raise UnsafeState("unsupported capability manifest schema")
    inventory = value.get("inventory")
    exclusions = value.get("runtimeExclusions")
    if not isinstance(inventory, dict) or not isinstance(exclusions, dict):
        raise UnsafeState("malformed capability manifest inventory")
    expected_policies = [
        {"source": f"npm:{name}", "dependency": dependency, "version": version, "integrity": integrity}
        for name, dependency, version, integrity in EXPECTED_PACKAGE_POLICIES
    ]
    expected = {
        "packages": EXPECTED_PACKAGES,
        "packagePolicies": expected_policies,
        "extensions": EXPECTED_EXTENSIONS,
        "extensionLinks": EXPECTED_EXTENSION_LINKS,
        "themes": EXPECTED_THEMES,
        "themeLinks": EXPECTED_THEME_LINKS,
    }
    for key, approved in expected.items():
        if inventory.get(key) != approved:
            raise UnsafeState(f"capability manifest {key} does not match the approved inventory")
    if exclusions.get("packages") != EXPECTED_EXCLUSIONS:
        raise UnsafeState("capability manifest exclusions do not match the approved inventory")
    return value


def top_level_lock_packages(lock_packages: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for key, metadata in lock_packages.items():
        if not isinstance(key, str) or not key.startswith("node_modules/") or not isinstance(metadata, dict):
            continue
        parts = key[len("node_modules/"):].split("/")
        if (parts[0].startswith("@") and len(parts) == 2) or (not parts[0].startswith("@") and len(parts) == 1):
            result["/".join(parts)] = metadata
    return result


def physical_packages(node_modules: Path) -> dict[str, Path]:
    try:
        root_stat = node_modules.lstat()
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise UnsafeState("cannot inspect package installation root") from exc
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        raise UnsafeState("package installation root must be a real directory")
    result: dict[str, Path] = {}
    try:
        for entry in node_modules.iterdir():
            if entry.name.startswith("."):
                continue
            info = entry.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise UnsafeState("installed package paths must be real directories")
            if entry.name.startswith("@"):
                if not PACKAGE_NAME.fullmatch(f"{entry.name}/placeholder"):
                    raise UnsafeState("installed package scope is malformed")
                for child in entry.iterdir():
                    child_info = child.lstat()
                    if stat.S_ISLNK(child_info.st_mode) or not stat.S_ISDIR(child_info.st_mode):
                        raise UnsafeState("installed package paths must be real directories")
                    name = f"{entry.name}/{child.name}"
                    if not PACKAGE_NAME.fullmatch(name):
                        raise UnsafeState("installed package identity is malformed")
                    result[name] = child
            else:
                if not PACKAGE_NAME.fullmatch(entry.name):
                    raise UnsafeState("installed package identity is malformed")
                result[entry.name] = entry
    except OSError as exc:
        raise UnsafeState("cannot enumerate installed packages") from exc
    return result


def check(agent: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
    manifest = validate_manifest()
    settings_value = read_json(agent / "settings.json", required=True, reject_symlink=True)
    npm_value = read_json(agent / "npm" / "package.json", required=True, reject_symlink=True)
    lock_value = read_json(agent / "npm" / "package-lock.json", required=True, reject_symlink=True)
    if not isinstance(settings_value, dict) or not isinstance(npm_value, dict) or not isinstance(lock_value, dict):
        raise UnsafeState("capability configuration JSON must contain objects")
    findings: list[dict[str, str]] = []
    package_items = settings_value.get("packages", [])
    extension_items = settings_value.get("extensions", [])
    theme_items = settings_value.get("themes", [])
    if not all(isinstance(items, list) for items in (package_items, extension_items, theme_items)):
        raise UnsafeState("capability settings fields must be arrays")

    configured: dict[str, list[Any]] = {}
    for item in package_items:
        name = source_name(item)
        if not name:
            raise UnsafeState("configured package has a malformed or non-canonical source")
        configured.setdefault(name, []).append(item)

    for name, items in configured.items():
        if len(items) > 1:
            findings.append(finding("duplicate-package-config", "package", name))

    required_names = [item[0] for item in EXPECTED_PACKAGE_POLICIES]
    excluded_names = [item[4:] for item in EXPECTED_EXCLUSIONS]
    dependencies = npm_value.get("dependencies")
    lock_packages = lock_value.get("packages")
    if not isinstance(dependencies, dict) or not isinstance(lock_packages, dict):
        raise UnsafeState("package manifests must contain dependency inventories")
    if not all(isinstance(key, str) and PACKAGE_NAME.fullmatch(key) for key in dependencies):
        raise UnsafeState("dependency inventory contains a malformed identity")
    if not all(isinstance(value, str) and CANONICAL_VERSION.fullmatch(value) for value in dependencies.values()):
        raise UnsafeState("dependency inventory contains a non-canonical source")

    expected_dependencies = {name: dependency for name, dependency, _, _ in EXPECTED_PACKAGE_POLICIES}
    direct_lock = top_level_lock_packages(lock_packages)
    physical = physical_packages(agent / "npm" / "node_modules")
    for name, dependency, version, integrity in EXPECTED_PACKAGE_POLICIES:
        if name not in configured:
            findings.append(finding("missing-package-config", "package", name))
        elif any(filtered(item) for item in configured[name]):
            findings.append(finding("filtered-package", "package", name))
        if dependencies.get(name) != dependency:
            findings.append(finding("package-source-mismatch", "package", name))
        locked = direct_lock.get(name)
        if not locked or locked.get("version") != version or locked.get("integrity") != integrity:
            findings.append(finding("package-lock-mismatch", "package", name))
        installed = physical.get(name)
        if not installed:
            findings.append(finding("missing-package-install", "package", name))
        else:
            metadata = read_json(installed / "package.json", required=True, reject_symlink=True)
            if not isinstance(metadata, dict) or metadata.get("name") != name or metadata.get("version") != version:
                findings.append(finding("package-metadata-mismatch", "package", name))

    for name in sorted(set(configured) - set(required_names) - set(excluded_names)):
        findings.append(finding("unexpected-package-config", "package", redacted_identity(name)))
    for name in sorted(set(dependencies) - set(required_names) - set(excluded_names)):
        findings.append(finding("unexpected-package-install", "package", redacted_identity(name)))

    configured_exclusions = set(configured)
    for item in [*extension_items, *theme_items]:
        identity = source_name(item)
        if identity:
            configured_exclusions.add(identity)
    for name in excluded_names:
        if name in configured_exclusions:
            findings.append(finding("forbidden-package-configured", "excluded-package", name))
        if name in dependencies or name in physical:
            findings.append(finding("forbidden-package-installed", "excluded-package", name))

    locked_names = set(direct_lock)
    physical_names = set(physical)
    for name in sorted(locked_names - physical_names):
        findings.append(finding("missing-locked-package", "package", redacted_identity(name)))
    for name in sorted(physical_names - locked_names):
        findings.append(finding("unlisted-physical-package", "package", redacted_identity(name)))
    for name in sorted(physical_names & locked_names):
        metadata = read_json(physical[name] / "package.json", required=True, reject_symlink=True)
        locked = direct_lock[name]
        if not isinstance(metadata, dict) or metadata.get("name") != name or metadata.get("version") != locked.get("version"):
            findings.append(finding("physical-package-metadata-mismatch", "package", redacted_identity(name)))

    extensions_root = agent / "extensions"
    discovered_extensions: set[str] = set()
    if extensions_root.exists():
        try:
            root_info = extensions_root.lstat()
            if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
                raise UnsafeState("extensions root must be a real directory")
            for entry in extensions_root.iterdir():
                if entry.name.startswith("."):
                    continue
                info = entry.lstat()
                is_link = stat.S_ISLNK(info.st_mode)
                is_directory = stat.S_ISDIR(info.st_mode)
                is_regular = stat.S_ISREG(info.st_mode)
                is_code = entry.suffix in (".ts", ".js", ".mjs", ".cjs")
                if is_code and not (is_regular or is_link or is_directory):
                    raise UnsafeState("extension code paths must be files, directories, or approved links")
                if is_directory or (is_code and is_regular) or is_link:
                    discovered_extensions.add(entry.name)
                if is_link:
                    expected_relative = EXPECTED_EXTENSION_LINKS.get(entry.name)
                    if not expected_relative:
                        findings.append(finding("unsafe-extension-link", "extension", redacted_identity(entry.name)))
                    else:
                        expected_kind = "directory" if entry.name == "pi-look" else "file"
                        expected_target = approved_real_target(extensions_root, expected_relative, expected_kind)
                        if expected_target is None:
                            findings.append(finding("extension-approved-target-unsafe", "extension", entry.name))
                        elif entry.resolve(strict=True) != expected_target:
                            findings.append(finding("extension-link-target-mismatch", "extension", entry.name))
                elif entry.name in EXPECTED_EXTENSION_LINKS:
                    findings.append(finding("missing-extension-link", "extension", entry.name))
                elif entry.name == "cmux-session.ts" and not is_regular:
                    findings.append(finding("extension-kind-mismatch", "extension", entry.name))
                elif entry.name == "pi-workbench" and not is_directory:
                    findings.append(finding("extension-kind-mismatch", "extension", entry.name))
        except (OSError, RuntimeError) as exc:
            raise UnsafeState("cannot safely inspect extensions directory") from exc
    expected_extensions = set(EXPECTED_EXTENSIONS)
    for name in sorted(expected_extensions - discovered_extensions):
        findings.append(finding("missing-extension", "extension", name))
    for name in sorted(discovered_extensions - expected_extensions):
        findings.append(finding("unexpected-extension", "extension", redacted_identity(name)))
        if name in ("pi-autoresearch", "ponytail"):
            findings.append(finding("forbidden-package-configured", "excluded-extension", redacted_identity(name)))
    for item in extension_items:
        source = resource_source(item)
        if source is None:
            raise UnsafeState("configured extension has malformed identity")
        findings.append(finding("unexpected-extension-config", "extension-config", redacted_identity(source)))

    themes_root = agent / "themes"
    discovered_themes: set[str] = set()
    if themes_root.exists():
        try:
            root_info = themes_root.lstat()
            if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
                raise UnsafeState("themes root must be a real directory")
            for entry in themes_root.iterdir():
                if entry.name.startswith("."):
                    continue
                info = entry.lstat()
                if stat.S_ISLNK(info.st_mode):
                    expected_relative = EXPECTED_THEME_LINKS.get(entry.name)
                    if not expected_relative:
                        findings.append(finding("unsafe-theme-link", "theme", redacted_identity(entry.name)))
                    else:
                        expected_target = approved_real_target(agent, expected_relative, "file")
                        if expected_target is None:
                            findings.append(finding("theme-approved-target-unsafe", "theme", entry.name))
                        elif entry.resolve(strict=True) != expected_target:
                            findings.append(finding("theme-link-target-mismatch", "theme", entry.name))
                    discovered_themes.add(entry.name)
                elif entry.name in EXPECTED_THEME_LINKS:
                    discovered_themes.add(entry.name)
                    findings.append(finding("missing-theme-link", "theme", entry.name))
                elif stat.S_ISREG(info.st_mode) and entry.suffix == ".json":
                    discovered_themes.add(entry.name)
                elif entry.name in EXPECTED_THEMES:
                    findings.append(finding("theme-kind-mismatch", "theme", entry.name))
        except (OSError, RuntimeError) as exc:
            raise UnsafeState("cannot safely inspect themes directory") from exc
    expected_themes = set(EXPECTED_THEMES)
    for name in sorted(expected_themes - discovered_themes):
        findings.append(finding("missing-theme", "theme", name))
    for name in sorted(discovered_themes - expected_themes):
        findings.append(finding("unexpected-theme", "theme", redacted_identity(name)))
    for item in theme_items:
        source = resource_source(item)
        if source is None:
            raise UnsafeState("configured theme has malformed identity")
        findings.append(finding("unexpected-theme-config", "theme-config", redacted_identity(source)))

    findings.sort(key=lambda item: (item["code"], item["category"], item["name"]))
    return manifest, findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the read-only Pi capability inventory")
    parser.add_argument("--agent-dir", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    agent = args.agent_dir or Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent"))
    try:
        manifest, findings = check(agent)
        status = "drift" if findings else "exact"
        code = 1 if findings else 0
        result = {
            "schemaVersion": manifest["schemaVersion"],
            "inventoryVersion": manifest["inventoryVersion"],
            "status": status,
            "counts": {"findings": len(findings)},
            "findings": findings,
        }
    except UnsafeState:
        code = 2
        result = {
            "schemaVersion": 1,
            "inventoryVersion": 1,
            "status": "unsafe",
            "counts": {"findings": 1},
            "findings": [finding("unsafe-state", "validation", "redacted")],
        }
    if args.json:
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    else:
        print(f"Capability inventory: {result['status']} ({result['counts']['findings']} finding(s))")
        for item in result["findings"]:
            print(f"- {item['code']}: {item['category']}/{item['name']}")
        print("Read-only persistent-state validation; no running process was inspected.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
