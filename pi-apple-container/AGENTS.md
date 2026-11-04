# pi-apple-container

Drop-in **alternative** to [pi-container-sandbox](../pi-container-sandbox/) that isolates `read` / `write` / `edit` / `bash` inside Apple's [`container`](https://github.com/apple/container) CLI.

Do **not** load this and `pi-container-sandbox` in the same session. They share `--container` and `/sandbox`.

## Requirements

- Apple silicon
- macOS 26+
- [`container` CLI](https://github.com/apple/container) installed
- `container system start` already run (this extension **never** auto-starts the VM service)

## Quick Start

```bash
container system start
cd pi-apple-container
pi -e ./index.ts              # off
pi -e ./index.ts --container  # on at start
```

Mid-session: `/sandbox on`, `/sandbox off`. Persist with `/sandbox default on`.

## Enable / disable

Same resolution as pi-container-sandbox, highest wins:

1. `--no-container` / `--noc` → never auto-boot
2. `--container` → boot at session start
3. `.pi/config.json` `sandbox.enabled: true` → boot
4. else off

`/sandbox on` works even if the session started with `--no-container`. CWD rewrite applies on the **next** agent turn. `/sandbox off` refuses if an exec is in flight.

## Apple vs Docker

| Concern | This package | pi-container-sandbox |
|---------|--------------|----------------------|
| Runtime | `container` CLI (lightweight Linux VM) | Docker |
| Network off | `--no-dns` only — the VM still has a NIC | `--network none` |
| Resources | `--cpus`, `--memory` | + swap, pids, disk |
| Image | same `thegreataxios/pi-sandbox:latest` (**aarch64 only**) | same |
| Pin / digest check | not in v0.1.0 | `/sandbox pin`, daily Hub check |

## Commands

| Command | Effect |
|---------|--------|
| `/sandbox` | status |
| `/sandbox on` | boot or reattach now |
| `/sandbox off` | unroute now; stop+delete unless persist/keep |
| `/sandbox default on\|off` | write `sandbox.enabled` |
| `/sandbox allow <path>` | session-allow an external host read |
| `/sandbox paths [revoke <path>]` | list / revoke persisted approvals |
| `/sandbox doctor` | check core tools inside the VM |
| `/sandbox install` | `container image pull` |
| `/sandbox config` | help |

## Architecture

```
index.ts            flags, tool wrap, /sandbox, enable/disable
src/runtime.ts      appleRuntime, buildRunArgs, parseListRunning
src/paths.ts        /workspace translation (copy of sandbox helpers)
src/resolve.ts      auto-start + in-flight (copy of sandbox helpers)
```

`container exec NAME sh -c ...` backs every tool. Host cwd bind-mounted RW at `/workspace`. Skills mounted RO at `/skills/<name>`.

## Combining

```bash
# Apple isolation + proxy + protected-paths
pi -e ./index.ts \
   -e ../pi-sandbox-proxy/index.ts \
   -e ../pi-protected-paths/index.ts
```

Do not also pass `../pi-container-sandbox/index.ts`.

## Testing

```bash
bun test
```

Unit tests cover argv construction and `container list --format json` parsing. They do **not** require the `container` binary.
