import subprocess
from pathlib import Path

import modal

app = modal.App("agena-migration-export-20260811")
workspace = modal.Volume.from_name("agena-workspace")
home = modal.Volume.from_name("agena-home")
state = modal.Volume.from_name("agena-state")


@app.function(
    image=modal.Image.debian_slim(python_version="3.12").apt_install("zstd"),
    volumes={
        "/workspace": workspace,
        "/home-volume": home,
        "/state-volume": state,
    },
    cpu=2,
    memory=2048,
    timeout=60 * 60 * 24,
)
def export() -> None:
    destination = Path("/state-volume/digitalocean-migration")
    destination.mkdir(exist_ok=True)
    # Build products and dependency caches are reproducible and dominate Modal's
    # per-file volume traversal. Keep source, dotfiles, and Git history intact.
    excludes = (
        "node_modules",
        ".next",
        ".vercel",
        ".cache",
        ".turbo",
        "coverage",
        "dist",
        "build",
        "out",
        ".npm/_cacache",
        ".local/share/pnpm/store",
    )
    for source, name in (("/workspace", "workspace"), ("/home-volume", "home")):
        archive = destination / f"{name}.tar.zst"
        subprocess.run(
            [
                "tar",
                "--zstd",
                *(f"--exclude={pattern}" for pattern in excludes),
                "-cf",
                str(archive),
                "-C",
                source,
                ".",
            ],
            check=True,
        )
        print(f"{name}: {archive.stat().st_size} bytes")
    state.commit()
