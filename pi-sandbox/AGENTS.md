# pi-sandbox

Container isolation extension for [pi](https://pi.dev). Intercepts every `read`, `write`, `edit`, and `bash` operation and runs it inside an isolated Linux container.

## Quick Start

```bash
cd pi-sandbox && bun install && bun run build
pi -e ./index.ts  # sandbox enabled by default
```

## Flags

| Flag | Description |
|------|-------------|
| `--no-container` / `--noc` | Run without sandboxing |
| `--no-container-net` | Disable network inside container |
| `--container-keep` | Keep container alive after exit (debug) |

## Architecture

Single-file extension (`index.ts`, ~575 lines). Dual runtime support:
- **Apple Runtime**: macOS 26+ `container` CLI with `--no-dns`
- **Docker Runtime**: `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`

Four tool adapters (`readOps`, `writeOps`, `editOps`, `bashOps`) translate operations to `sh -c` commands inside the container. Only project cwd is bind-mounted to `/workspace`; host secrets, SSH keys, and home directory are never exposed.

> **⚠️ Dockerfile changes require rebuild.** Run `bun run build` after modifying `docker/Dockerfile`. Changes to `index.ts` take effect immediately.
