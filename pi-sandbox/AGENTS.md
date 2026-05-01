# pi-sandbox

Container isolation extension for [pi](https://pi.dev). Intercepts every `read`, `write`, `edit`, and `bash` operation and runs it inside an isolated Linux container (Docker).

## Quick Start

```bash
cd pi-sandbox && bun install && bun run build
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

## Re-usable Sandboxes

For large projects with complex setup (e.g., Warp), use named sandboxes to avoid repeated initialization:

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
- Named/re-usable containers with reattach support
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
- `/sandbox-allow <path>` — grant session-only access without prompting
- `/sandbox-paths` — list persisted path approvals
- `/sandbox-paths revoke <path>` — revoke a persisted approval

Non-interactive mode (no UI): external reads are blocked unless pre-approved via `--container-allow-paths` or `/sandbox-allow`.

> **⚠️ Dockerfile changes require rebuild.** Run `bun run build` after modifying `docker/Dockerfile`. Changes to `index.ts` take effect immediately.
