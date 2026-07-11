#!/usr/bin/env python3
"""Strict reader/writer for Agena's deliberately tiny environment manifest."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

PACKAGE = re.compile(r"^[a-z0-9][a-z0-9+.-]*$")


def system_packages(raw: bytes | str) -> tuple[str, ...]:
    data = tomllib.loads(raw.decode() if isinstance(raw, bytes) else raw)
    if set(data) - {"packages"}:
        raise ValueError("environment.toml only supports [packages]")
    packages = data.get("packages", {})
    if not isinstance(packages, dict) or set(packages) - {"system"}:
        raise ValueError("[packages] only supports system")
    values = packages.get("system", [])
    if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
        raise ValueError("packages.system must be an array of package names")
    invalid = [value for value in values if not PACKAGE.fullmatch(value)]
    if invalid:
        raise ValueError(f"invalid Debian package name: {invalid[0]}")
    return tuple(sorted(set(values)))


def read_system_packages(path: Path) -> tuple[str, ...]:
    try:
        return system_packages(path.read_bytes())
    except FileNotFoundError:
        return ()


def write_system_packages(path: Path, packages: set[str]) -> None:
    normalized = system_packages(
        "[packages]\nsystem = " + json.dumps(sorted(packages)) + "\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_text(
        "[packages]\nsystem = " + json.dumps(list(normalized)) + "\n"
    )
    os.replace(temp, path)


def record_manual_packages(
    manifest: Path, baseline: set[str], current: set[str]
) -> None:
    write_system_packages(manifest, current - baseline)


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    packages_parser = subparsers.add_parser("packages")
    packages_parser.add_argument("manifest", type=Path)
    record_parser = subparsers.add_parser("record")
    record_parser.add_argument("baseline", type=Path)
    record_parser.add_argument("manifest", type=Path)
    args = parser.parse_args()

    if args.command == "packages":
        print(json.dumps(read_system_packages(args.manifest)))
        return 0

    baseline = set(args.baseline.read_text().splitlines())
    current = set(
        subprocess.run(
            ["apt-mark", "showmanual"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
    )
    record_manual_packages(args.manifest, baseline, current)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
