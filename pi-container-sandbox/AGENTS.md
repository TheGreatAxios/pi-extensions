# pi-container-sandbox

Container isolation extension for [pi](https://pi.dev). Intercepts every `read`, `write`, `edit`, and `bash` operation and runs it inside an isolated Linux container (Docker).

## Quick Start

```bash
cd pi-container-sandbox && bun install && bun run build
pi -e ./index.ts  # sandbox enabled by default
```

## Size Tiers

| Tier | Memory | Swap | CPU | Disk |
|------|--------|------|-----|------|
| `xs` | 512m | 512m | 0.5 | 2g |
| `sm` (default) | 2g | 1g | 1 | 5g |
| `md` | 4g | 2g | 2 | 10g |
| `lg` | 8g | 4g | 4 | 20g |
| `xlg` | 16g | 4g | 8 | 40g |
| `xxlg` | 32g | 4g | 16 | 80g |

Use `--container-size <tier>` or set in `.pi/config.json`.

## Container Naming & Lifecycle

By default, each project gets a **deterministic** container name:
```
pi-sbx-<dirname>-<hash6>
```
For example, an agent in `/Users/me/my-project` creates `pi-sbx-my-project-a1b2c3`.
This makes containers identifiable in `docker ps` without needing `--sandbox-name`.

### Lifecycle (Default Mode)
- **Start**: Container is created (or reused if it still exists from a crash).
- **Exit (CTRL+C)**: Container is **stopped and removed** — no accumulation.
- **Crash recovery**: If pi crashes, the container lingers. Next `pi` start in the same project **reattaches** automatically.

### Persist Mode (`--sandbox-persist` or `.pi/config.json` `"persist": true`)
- Container is **kept** after pi exits.
- Next `pi` start in the same project finds and **reattaches** to the existing container.
- Use this for large environments (e.g., Warp) where rebuild is expensive.

### Re-usable Named Sandboxes (`--sandbox-name <name>`)

For complex projects that need consistent state across sessions:

```bash
# Create or reattach to a named sandbox
pi -e ./index.ts --sandbox-name warp-dev --sandbox-persist --container-size lg

# The container persists after exit, reattach later:
pi -e ./index.ts --sandbox-name warp-dev
```

Add persistent cache volume for dependencies:
```bash
pi -e ./index.ts --sandbox-name warp-dev --sandbox-cache warp-cache --sandbox-persist
```

## Config File

Create `.pi/config.json` in your project:

```json
{
  "sandbox": {
    "size": "lg",
    "persist": true,
    "cacheVolume": "my-project-cache"
  }
}
```

## Flags

| Flag | Description |
|------|-------------|
| `--no-container` / `--noc` | Run without sandboxing |
| `--container-size <tier>` | Size tier: xs, sm (default), md, lg, xlg, xxlg |
| `--sandbox-name <name>` | Re-usable sandbox name (reattaches if exists) |
| `--sandbox-persist` | Keep container running after pi exits |
| `--sandbox-cache <volume>` | Docker volume for persistent /cache |
| `--no-container-net` | Disable network inside container |
| `--container-keep` | Keep container alive after exit (debug) |
| `--container-memory`, `--container-cpus`, `--container-swap` | Override individual resources |

## Architecture

Single-file extension (`index.ts`). Docker runtime with:
- `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`
- Size-based resource tiers (memory, swap, CPU, disk)
- **Deterministic per-project naming**: `pi-sbx-<dirname>-<hash6>`
- **Auto-cleanup** on exit: containers are removed unless persist/keep flags are set
- **Crash recovery**: stale containers are reattached on next start
- Named/re-usable containers with explicit reattach support
- Optional persistent cache volumes at `/cache`

Four tool adapters (`readOps`, `writeOps`, `editOps`, `bashOps`) translate operations to `sh -c` commands inside the container. Only project cwd is bind-mounted to `/workspace`; host secrets, SSH keys, and home directory are never exposed.

### External Path Access

When the agent tries to read a file outside the project cwd, the sandbox prompts with an interactive approval flow:

1. **Approve once** — session-only, not persisted
2. **Approve always** — persisted indefinitely (until revoked)
3. **Approve for 7 days** — persisted with 7-day expiry
4. **Approve for 30 days** — persisted with 30-day expiry
5. **Deny** — blocked

Approvals are stored in `~/.pi/agent/path-approvals.json` and support prefix matching (approving a directory grants access to all files under it).

Commands:
- `/sandbox status` — show sandbox container status (resources, uptime)
- `/sandbox allow <path>` — grant session-only read access to an external host path
- `/sandbox paths` — list persisted path approvals
- `/sandbox paths revoke <path>` — revoke a persisted approval
- `/sandbox doctor` — verify core tools inside the container (node, bun, python, uv, chromium, etc.)
- `/sandbox install` — pull the sandbox image (works without a running container)
- `/sandbox update` — pull the latest sandbox image (requires active container)
- `/sandbox config` — show current `.pi/agent/sandbox.json` config
- `/sandbox pin <tag>` — pin project to a specific image tag (e.g. `v1.0.0`)
- `/sandbox unpin` — unpin and follow `latest` again

Non-interactive mode (no UI): external reads are blocked unless pre-approved via `--container-allow-paths` or `/sandbox allow`.

### Per-Project Version Pinning

Create `.pi/agent/sandbox.json` in your project to pin a specific sandbox image version.
This lets different projects use different sandbox versions without conflicts:

```json
{
  "image": "thegreataxios/pi-sandbox",
  "tag": "v1.0.0",
  "pinned": true
}
```

Or via commands:
```
/sandbox pin v1.0.0    # pin this project to v1.0.0
/sandbox unpin          # unpin, follow latest again
/sandbox update         # pull the currently configured tag
```

### Automatic Version Checking

On session start, pi-container-sandbox checks Docker Hub once per day for a new image digest.
If a newer version of the configured tag is found, it notifies you:

> 📦 New sandbox image available: thegreataxios/pi-sandbox:latest
> Run `/sandbox update` to pull the update.

Version checking is skipped when:
- You use `--container-image` flag (manual override)
- The tag is pinned (`pinned: true` in sandbox.json)
- Less than 24 hours since last check
- Network is unavailable

> **⚠️ Dockerfile changes require rebuild.** Run `bun run build` after modifying `docker/Dockerfile`. Changes to `index.ts` take effect immediately.

## Combining with pi-sandbox-proxy

Use pi-container-sandbox alongside [pi-sandbox-proxy](../pi-sandbox-proxy/) for defense-in-depth:
- **Sandbox** isolates filesystem operations (containers, no host access)
- **Proxy** gates all network operations (vuln scanning, approval flows, typosquatting)

```bash
pi -e ./index.ts -e ../pi-sandbox-proxy/index.ts
```

The proxy auto-detects whether the sandbox is active and what its network mode is.
If the sandbox has network disabled (`--no-container-net`), the proxy short-circuits
without prompting for approvals — a container with no network stack can't reach the internet.
