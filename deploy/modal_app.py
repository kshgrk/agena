# Agena daemon on Modal. Deploy into YOUR workspace: modal deploy deploy/modal_app.py
#
# Shape (per final_plan INV-14 + oracle review):
#   - ONE container ever (max_containers=1): the daemon is the single writer.
#   - SQLite on container-local disk, Litestream-replicated to Cloudflare R2
#     (bucket "agena"); restored + integrity-checked at boot (modal-entry.sh).
#   - /var/lib/agena (Pi session JSONL, config, imports) and /workspace on
#     Modal Volumes — durable across restarts; db/ is symlinked off the volume.
#   - Secrets: agena-daemon (AGENA_AUTH_TOKEN, ANTHROPIC_API_KEY),
#     agena-r2 (LITESTREAM_* keys, R2_ENDPOINT, R2_BUCKET).
import subprocess

import modal

LITESTREAM = "v0.3.13"
LITESTREAM_DEB = (
    "https://github.com/benbjohnson/litestream/releases/download/"
    f"{LITESTREAM}/litestream-{LITESTREAM}-linux-amd64.deb"
)

app = modal.App("agena")

image = (
    modal.Image.from_dockerfile("docker/Dockerfile", context_dir=".", add_python="3.12")
    .dockerfile_commands(
        [
            "USER root",
            "RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates"
            " && rm -rf /var/lib/apt/lists/*",
            f"RUN wget -qO /tmp/litestream.deb {LITESTREAM_DEB}"
            " && dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb",
        ]
    )
    .add_local_file("deploy/modal-entry.sh", "/app/modal-entry.sh")
)

state = modal.Volume.from_name("agena-state", create_if_missing=True)
workspace = modal.Volume.from_name("agena-workspace", create_if_missing=True)


@app.function(
    image=image,
    volumes={"/var/lib/agena": state, "/workspace": workspace},
    secrets=[
        modal.Secret.from_name("agena-daemon"),
        modal.Secret.from_name("agena-r2"),
    ],
    max_containers=1,  # single writer — NEVER raise this (INV-14)
    scaledown_window=1200,
    timeout=60 * 60 * 24,
    cpu=2,
    # 2048 schedules reliably on Modal; 4096 (=4.8GiB with overhead) got stuck
    # "waiting to be scheduled". Light headless chromium for the opt-in agent
    # browser tool fits here; bump to 3072 only if chromium OOMs under real use
    # (see docs/agent-browser.md). Enable via AGENA_BROWSER_TOOL=1 in the
    # agena-daemon secret; inert (no chromium spawned) when unset.
    memory=2048,
)
@modal.concurrent(max_inputs=1000)
@modal.web_server(7777, startup_timeout=300, label="agena")
def daemon() -> None:
    subprocess.Popen(["bash", "/app/modal-entry.sh"])
