# pi-container-sandbox

Personal pi extension that runs `read`, `write`, `edit`, `bash`, and `user_bash` inside a container sandbox (Apple `container` or Docker).

- Host project cwd is mounted read-write at `/workspace`
- Agent runs as non-root `pi` user
- No host `$HOME`, SSH keys, cloud creds, browser state, or Docker socket
- Resource limits via size tiers
- Optional reusable named containers
- One command namespace: `/sandbox ...`

## Quick start

```bash
cd pi-container-sandbox
bun install
bun run build
pi -e ./index.ts
```

## Commands

All UI commands live under `/sandbox`:

```text
/sandbox                 Show status
/sandbox status          Show status, image, digest/update info
/sandbox doctor          Verify core tools in the running container
/sandbox update          Pull configured sandbox image; restart pi to use it
/sandbox config          Show .pi/agent/sandbox.json
/sandbox pin <tag>       Pin this project to an image tag
/sandbox unpin           Follow latest again
/sandbox allow <path>    Session-allow external host read path
/sandbox paths           List persisted external path approvals
/sandbox paths revoke <path>
```

No `/sandbox-*` aliases are registered.

## Apple `container` runtime

Runs each sandbox as its own lightweight VM (Apple `container`, macOS 26, Apple silicon). Auto-detected first; force with `--container-runtime apple|docker`.

```bash
container system start
pi -e ./index.ts --container-runtime apple
```

What the Apple runtime applies:

- `--user 1000:1000 --cap-drop ALL`, `-m/-c` from the size tier, `--container-pids-limit` as `--ulimit nproc`. Swap and disk limits are not applied.
- **Fail-closed:** if the sandbox cannot start, `read`/`write`/`edit`/`bash` refuse instead of running on the host. `--container-optional` opts back into host fallback.
- **Read-only paths** inside `/workspace`: `.git`, `.envrc`, `.vscode`, `.pi` (only those that exist). Nested read-only paths can be bypassed by renaming their parent, so `.git` is protected as a whole; the agent cannot commit inside the sandbox. `--container-protect a,b` overrides the list, `--container-git-writable` drops `.git` (re-enables hook/config planting).
- **Networking:** `--container-offline` (or `--container-net=false`) attaches the sandbox to an auto-created `--internal` network with no DNS: no internet route, but the host gateway is still reachable, so anything on the Mac listening on `0.0.0.0` is exposed (block it with `pf`). `--container-network <name>` + `--container-proxy <url>` route egress through an allowlist proxy on the network gateway. `--container-dns <ip>` sets the resolver on the default network.

Note: pi has no `--no-<flag>` negation, so `--no-container-net` is rejected as an unknown option; use `--container-offline`.

## Image version/update flow

Default image: `thegreataxios/pi-sandbox:latest`.

Per-project config lives at `.pi/agent/sandbox.json`:

```json
{
  "image": "thegreataxios/pi-sandbox",
  "tag": "latest",
  "pinned": false,
  "lastDigest": null,
  "lastCheckedAt": null
}
```

Use:

```text
/sandbox status   # current container + local/last-seen digest info
/sandbox update   # docker pull configured image
/sandbox pin v1.2.3
/sandbox unpin
```

After `/sandbox update`, restart pi. Existing containers keep using the old image.

## Flags

| Flag | Purpose |
|---|---|
| `--no-container`, `--noc` | Disable sandbox |
| `--container-runtime apple\|docker` | Choose runtime (default: auto, Apple first) |
| `--container-optional` | Run on the host if the sandbox can't start (default: refuse) |
| `--container-offline` | No network (Apple: `--internal` network, no DNS) |
| `--container-protect <paths>` | Apple: read-only paths under `/workspace` (default `.git,.envrc,.vscode,.pi`) |
| `--container-git-writable` | Apple: don't protect `.git` |
| `--container-network <name>`, `--container-proxy <url>`, `--container-dns <ip>` | Apple: network attachment, egress proxy, resolver |
| `--container-size xs\|sm\|md\|lg\|xlg\|xxlg` | Resource tier (`sm` default) |
| `--sandbox-name <name>` | Reattach/reuse named container |
| `--sandbox-persist` | Keep reusable container running after pi exits |
| `--sandbox-cache <volume>` | Mount Docker volume at `/cache` |
| `--container-image <ref>` | Override image ref |
| `--no-container-net` | Disable container networking |
| `--container-keep` | Keep one-off container after exit |
| `--container-allow-paths <paths>` | Comma-separated session read allowlist |
| `--container-memory`, `--container-cpus`, `--container-swap`, `--container-pids-limit` | Override tier resources |

## Image contents

Debian 13.4 slim with common agent tools:

- shell/core: `bash`, coreutils, `git`, `curl`, `jq`, `ripgrep`, `fd`, `bat`, `eza`, `yq`, `ast-grep`
- runtimes: `bun`, `node`, `npm`, `uv`, Python 3.13
- browser: `chromium`, `prawl`

Run `/sandbox doctor` after image changes. It checks that the important binaries execute and prints `ldd` for `node`.

## Build/publish

```bash
bun run build-image:docker
bun run docker:build
bun run docker:publish
```

`docker/Dockerfile` verifies downloaded release binaries by SHA256. Node requires `libatomic1`; the Dockerfile smoke-tests `node --version` and `npm --version` during build so missing shared libs fail the build, not your session.
