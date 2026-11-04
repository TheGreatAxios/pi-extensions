# pi-apple-container

Opt-in pi sandbox using Apple's [`container`](https://github.com/apple/container) CLI. Alternative to [pi-container-sandbox](../pi-container-sandbox/) (Docker).

**Do not load both in the same session** — they share `--container` / `/sandbox`.

## Requirements

- Apple silicon, macOS 26+
- `container` CLI from [apple/container](https://github.com/apple/container)
- `container system start` (this extension will not start the VM service for you)

## Quick start

```bash
container system start
cd pi-apple-container
pi -e ./index.ts              # off
pi -e ./index.ts --container  # on at start
```

Then `/sandbox on` / `/sandbox off`. Persist with `/sandbox default on`.

Default image: `thegreataxios/pi-sandbox:latest` (**linux/arm64 only**).

## Network caveat

Apple has no Docker `--network none`. `--no-container-net` only passes `--no-dns`. The VM still has a NIC.

## Commands

```text
/sandbox                 status
/sandbox on              enable this session
/sandbox off             disable this session
/sandbox default on|off  persist .pi/config.json sandbox.enabled
/sandbox allow <path>    session-allow external host read
/sandbox paths
/sandbox doctor
/sandbox install         container image pull
```

See [AGENTS.md](./AGENTS.md) for flags, architecture, and how this differs from Docker.
