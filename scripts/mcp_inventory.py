#!/usr/bin/env python3
"""Generate a secret-safe HTML inventory of Claude Code and Codex MCPs."""

from __future__ import annotations

import argparse
import html
import json
import re
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class Mcp:
    harness: str
    scope: str
    name: str
    transport: str
    target: str
    auth: str
    source: str


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read {path}: {error}") from error
    return value if isinstance(value, dict) else {}


def read_toml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        with path.open("rb") as file:
            value = tomllib.load(file)
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ValueError(f"Cannot read {path}: {error}") from error
    return value if isinstance(value, dict) else {}


SECRET_WORD = re.compile(r"token|secret|password|credential|api[-_]?key|auth|dsn", re.I)
SECRET_VALUE = re.compile(r"(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}", re.I)


def safe_value(value: str) -> str:
    if SECRET_VALUE.search(value):
        return "[redacted]"
    if "://" in value:
        try:
            parsed = urlsplit(value)
            host = parsed.hostname or ""
            if parsed.port:
                host += f":{parsed.port}"
            return urlunsplit((parsed.scheme, host, parsed.path, "", ""))
        except ValueError:
            return "[redacted URL]"
    return value


def safe_command(command: str, args: Any) -> str:
    values = [str(arg) for arg in args] if isinstance(args, list) else []
    safe_args: list[str] = []
    redact_next = False
    for value in values:
        if redact_next or ("=" in value and SECRET_WORD.search(value.split("=", 1)[0])):
            safe_args.append("[redacted]")
            redact_next = False
            continue
        safe_args.append(safe_value(value))
        redact_next = value.startswith("-") and bool(SECRET_WORD.search(value))
    return " ".join([command, *safe_args])


def transport_and_target(config: dict[str, Any]) -> tuple[str, str]:
    url = config.get("url")
    if isinstance(url, str):
        return str(config.get("type") or "http"), safe_value(url)
    command = config.get("command")
    if isinstance(command, str):
        return "stdio", safe_command(command, config.get("args"))
    return str(config.get("type") or "unknown"), "—"


def auth_kind(config: dict[str, Any]) -> str:
    if config.get("oauth") or config.get("auth") == "oauth":
        return "OAuth"
    if config.get("bearer_token_env_var"):
        return f"Bearer env: {config['bearer_token_env_var']}"

    headers = config.get("headers") or config.get("http_headers")
    env_headers = config.get("env_http_headers")
    if isinstance(env_headers, dict) and env_headers:
        return "Environment-backed headers"
    if isinstance(headers, dict) and headers:
        authorization = headers.get("Authorization") or headers.get("authorization")
        if isinstance(authorization, str):
            match = re.fullmatch(r"Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}", authorization)
            if match:
                return f"Bearer env: {match.group(1)}"
        values = " ".join(str(value) for value in headers.values())
        return "Environment-backed headers" if "${" in values else "Static headers (redacted)"

    env = config.get("env")
    env_vars = config.get("env_vars")
    if (isinstance(env, dict) and env) or (isinstance(env_vars, list) and env_vars):
        return "Environment variables"
    return "None detected"


def entries(
    harness: str,
    scope: str,
    source: Path,
    servers: Any,
) -> list[Mcp]:
    if not isinstance(servers, dict):
        return []
    result: list[Mcp] = []
    for name, config in servers.items():
        if not isinstance(config, dict):
            continue
        transport, target = transport_and_target(config)
        result.append(
            Mcp(
                harness=harness,
                scope=scope,
                name=str(name),
                transport=transport,
                target=target,
                auth=auth_kind(config),
                source=str(source),
            )
        )
    return result


def collect(home: Path, project: Path) -> tuple[list[Mcp], list[str]]:
    mcps: list[Mcp] = []
    warnings: list[str] = []

    def attempt(loader: Any, path: Path) -> dict[str, Any]:
        try:
            return loader(path)
        except ValueError as error:
            warnings.append(str(error))
            return {}

    claude_path = home / ".claude.json"
    claude = attempt(read_json, claude_path)
    mcps += entries("Claude", "user", claude_path, claude.get("mcpServers"))
    projects = claude.get("projects")
    if isinstance(projects, dict):
        for path, config in projects.items():
            if isinstance(config, dict):
                mcps += entries(
                    "Claude",
                    f"local: {path}",
                    claude_path,
                    config.get("mcpServers"),
                )

    project_claude_path = project / ".mcp.json"
    project_claude = attempt(read_json, project_claude_path)
    mcps += entries(
        "Claude", "project", project_claude_path, project_claude.get("mcpServers")
    )

    codex_path = home / ".codex" / "config.toml"
    codex = attempt(read_toml, codex_path)
    mcps += entries("Codex", "user", codex_path, codex.get("mcp_servers"))

    project_codex_path = project / ".codex" / "config.toml"
    project_codex = attempt(read_toml, project_codex_path)
    mcps += entries(
        "Codex", "project", project_codex_path, project_codex.get("mcp_servers")
    )

    return sorted(mcps, key=lambda item: (item.harness, item.name, item.scope)), warnings


def render(mcps: list[Mcp], warnings: list[str]) -> str:
    duplicate_names = {
        (mcp.harness, mcp.name)
        for mcp in mcps
        if sum(item.harness == mcp.harness and item.name == mcp.name for item in mcps) > 1
    }

    rows = []
    for mcp in mcps:
        duplicate = " <span class=\"badge\">duplicate</span>" if (mcp.harness, mcp.name) in duplicate_names else ""
        cells = [
            mcp.harness,
            mcp.scope,
            mcp.name,
            mcp.transport,
            mcp.target,
            mcp.auth,
            mcp.source,
        ]
        row = "".join(f"<td>{html.escape(value)}</td>" for value in cells)
        rows.append(f"<tr>{row[:-5]}{duplicate}</td></tr>")

    warning_html = "".join(f"<li>{html.escape(warning)}</li>" for warning in warnings)
    empty = '<tr><td colspan="7" class="empty">No MCP servers found.</td></tr>'
    body = "".join(rows) or empty
    claude_count = sum(mcp.harness == "Claude" for mcp in mcps)
    codex_count = sum(mcp.harness == "Codex" for mcp in mcps)

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Inventory</title>
<style>
:root {{ color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }}
body {{ margin: 0; padding: 2rem; background: #0b1020; color: #e8ecf4; }}
main {{ max-width: 1400px; margin: auto; }}
h1 {{ margin-bottom: .25rem; }}
.summary {{ color: #aeb8cb; margin: 0 0 1.5rem; }}
.cards {{ display: flex; gap: 1rem; margin-bottom: 1.5rem; }}
.card {{ background: #151c31; border: 1px solid #2b3655; border-radius: 12px; padding: 1rem 1.25rem; min-width: 9rem; }}
.card strong {{ display: block; font-size: 1.75rem; }}
.table {{ overflow-x: auto; border: 1px solid #2b3655; border-radius: 12px; }}
table {{ width: 100%; border-collapse: collapse; background: #11182a; }}
th, td {{ padding: .8rem; text-align: left; border-bottom: 1px solid #26314d; vertical-align: top; }}
th {{ background: #19223a; position: sticky; top: 0; }}
tr:last-child td {{ border-bottom: 0; }}
.badge {{ color: #ffd98a; background: #4a3613; border-radius: 999px; padding: .15rem .45rem; font-size: .75rem; white-space: nowrap; }}
.empty, .note {{ color: #aeb8cb; }}
.warning {{ color: #ffd98a; }}
code {{ word-break: break-all; }}
</style>
</head>
<body><main>
<h1>MCP Inventory</h1>
<p class="summary">Configuration only. Secret values and Keychain contents are never included.</p>
<section class="cards">
<div class="card"><strong>{len(mcps)}</strong>Total entries</div>
<div class="card"><strong>{claude_count}</strong>Claude</div>
<div class="card"><strong>{codex_count}</strong>Codex</div>
</section>
{f'<section class="warning"><h2>Warnings</h2><ul>{warning_html}</ul></section>' if warnings else ''}
<div class="table"><table>
<thead><tr><th>Harness</th><th>Scope</th><th>Name</th><th>Transport</th><th>Command / URL</th><th>Auth</th><th>Source</th></tr></thead>
<tbody>{body}</tbody>
</table></div>
<p class="note">Duplicate means the same harness defines that MCP name in more than one scope; normal precedence rules still apply.</p>
</main></body></html>
"""


def self_test() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / ".codex").mkdir()
        (root / "project").mkdir()
        (root / ".claude.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "claude-http": {
                            "type": "http",
                            "url": "https://user:password@example.com/mcp?token=hidden",
                            "headers": {"Authorization": "Bearer ${TOKEN}"},
                        }
                    }
                }
            )
        )
        (root / ".codex" / "config.toml").write_text(
            '[mcp_servers.codex-stdio]\ncommand = "npx"\nargs = ["-y", "server"]\n'
        )
        mcps, warnings = collect(root, root / "project")
        page = render(mcps, warnings)
        assert len(mcps) == 2
        assert "Bearer env: TOKEN" in page
        assert "npx -y server" in page
        assert "Bearer ${TOKEN}" not in page
        assert "password" not in page
        assert "hidden" not in page


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, default=Path("mcp-inventory.html"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        print("self-test passed")
        return

    mcps, warnings = collect(Path.home(), args.project.resolve())
    args.output.write_text(render(mcps, warnings))
    print(f"Wrote {args.output.resolve()} with {len(mcps)} MCP entries")


if __name__ == "__main__":
    main()
