# pi-container-sandbox

A [pi coding-agent](https://pi.dev) extension that runs every `read`, `write`,
`edit`, and `bash` operation inside a per-session Linux container — Apple's
[`container`](https://github.com/apple/container) CLI or Docker, your pick.

The agent gets a clean Debian-slim VM with `/workspace` bind-mounted to your
project. Everything else on your Mac (home dir, SSH keys, AWS creds, Docker
socket, browser state, …) is invisible to it.

```
┌────────────────────────────────────────────────────────┐
│  pi (your Mac)                                         │
│   └─ tools: read / write / edit / bash / user_bash     │
│        │                                               │
│        │   intercepted via createXTool({ operations })│
│        ▼                                               │
│   docker exec  pi-sbx-<id>  sh -c "<op>"               │
│        │                                               │
│        ▼                                               │
│   ┌────────────────────────────────────┐               │
│   │ Linux VM (debian:stable-slim)      │               │
│   │  user: pi (uid 1000), no sudo      │               │
│   │  network: NONE (default)           │               │
│   │  caps: dropped ALL                 │               │
│   │  pids: 512  ram: 2g  cpus: 2       │               │
│   │  /workspace ←→ host project cwd    │  ← only mount │
│   └────────────────────────────────────┘               │
└────────────────────────────────────────────────────────┘
```

## Security model

| Property                           | How it's enforced                                         |
| ---------------------------------- | ---------------------------------------------------------- |
| Agent can't read host files        | Only `<cwd>` is bind-mounted. Path translator rejects any  |
| outside the project                | resolved path that escapes `<cwd>`.                        |
| Agent can't run as root            | `--user 1000:1000` (the `pi` user in the image).           |
| Agent can't escalate privileges    | `--security-opt no-new-privileges`, `--cap-drop ALL`.      |
| Agent can't fork-bomb you          | `--pids-limit 512`, `--memory 2g`, `--cpus 2`.             |
| Agent can't exfiltrate over network| `--network none` by default. Opt in with `--container-net`.|
| Agent can't see your SSH/AWS keys  | Nothing under `$HOME` is mounted. No SSH agent forwarding. |
| Agent can't talk to the daemon     | No Docker socket mounted, ever.                            |
| Container outlives session?        | `--rm` plus `session_shutdown` stops it. `--container-keep`|
|                                    | overrides for debugging.                                   |

The interception happens at pi's `ReadOperations`/`WriteOperations`/
`EditOperations`/`BashOperations` interfaces — the same plug-points the
upstream [`ssh.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/ssh.ts)
example uses. Built-in `read`/`write`/`edit`/`bash` tools are wrapped, and
`user_bash` (for `!` commands) is also routed into the sandbox.

## Setup

```bash
# 1. install pi if you haven't:  bun add -g @mariozechner/pi-coding-agent

# 2. clone or copy this repo, then:
npm install

# 3. build the sandbox image (one-time, ~3 min)
docker build -t pi-sandbox:latest -f docker/Dockerfile docker
# or, with Apple's container (after `container system start`):
container build -t pi-sandbox:latest -f docker/Dockerfile docker
```

## Use

Once the extension is installed (see Auto-discovery below), `pi` runs
sandboxed by default:

```bash
pi                  # sandboxed (container starts automatically)
pi --no-container   # bypass the sandbox, run on the host
pi --noc            # short alias for --no-container
```

For one-off testing without auto-discovery:

```bash
pi -e ./index.ts            # sandboxed
pi -e ./index.ts --noc      # not sandboxed
```

Then ask the agent to do things — its `bash`, `read`, `write`, `edit` calls
all run inside the sandbox container. Run `/sandbox` in the pi UI to see
status.

### Flags

| Flag                          | Default                   | Effect                                                  |
| ----------------------------- | ------------------------- | ------------------------------------------------------- |
| `--container`                 | **on**                    | Enable sandboxing (default).                            |
| `--no-container`              | off                       | Force-disable (overrides `--container`).                |
| `--noc`                       | off                       | Short alias for `--no-container`.                       |
| `--container-runtime <r>`     | auto (apple, then docker) | Pick `apple` or `docker`.                               |
| `--container-image <name>`    | `pi-sandbox:latest`       | Use a different image.                                  |
| `--container-net`             | off                       | Allow outbound network (for `npm install`, `pip`, etc.).|
| `--container-keep`            | off                       | Don't stop the container on exit (for post-mortem).     |

### Auto-discovery (recommended once you trust it)

Drop the extension into pi's auto-discovery path:

```bash
mkdir -p ~/.pi/agent/extensions/container-sandbox
cp -R index.ts package.json docker/ ~/.pi/agent/extensions/container-sandbox/
( cd ~/.pi/agent/extensions/container-sandbox && npm install )
```

Now `pi --container` works in any project without `-e`.

## Apple `container` notes

Apple's `container` (>= macOS 26, Apple silicon) gives you per-container
lightweight VMs — stronger isolation than Docker Desktop. To use it:

```bash
container system start --enable-kernel-install   # one-time, downloads kata kernel
container build -t pi-sandbox:latest -f docker/Dockerfile docker
pi -e ./index.ts --container --container-runtime apple
```

Caveats:
- `--no-dns` is used for "no network" instead of Docker's `--network none`,
  which is best-effort: outbound IP-literal connections are not blocked.
  For stricter isolation use Docker, or `container network create` an
  isolated network and pass it via the runtime in `index.ts`.
- The Linux capability/security flags `--cap-drop`, `--security-opt`, and
  `--pids-limit` are Docker-only; Apple's per-VM model gives you stronger
  baseline isolation in their place.

## What the agent actually sees

```
$ pi -e ./index.ts --container
[sandbox] Sandbox up: docker pi-sbx-a1b2c3d4
                    pi
                    /workspace
> ! id; ls; uname -a
uid=1000(pi) gid=1000(pi) groups=1000(pi)
README.md  docker/  index.ts  package.json  tsconfig.json
Linux pi-sbx-a1b2c3d4 6.10.x #1 SMP aarch64 GNU/Linux
```

Cwd in the system prompt is rewritten to `/workspace` so the model's path
reasoning matches what the tools actually see.

## Layout

```
.
├── README.md
├── package.json          # pi extension manifest + deps
├── tsconfig.json
├── index.ts              # the extension
└── docker/
    └── Dockerfile        # debian-slim + bash, git, curl, node, python3, ripgrep
```

## Troubleshooting

- **"Sandbox image not found"** — run the `docker build` / `container build`
  command from the Setup section.
- **"docker run failed"** — make sure Docker Desktop / OrbStack is running
  (`docker info`).
- **"apple container run failed: container with id pi-sbx-… already exists"** —
  a previous session crashed (or you used `--container-keep`) and left a
  stub behind. The extension now force-deletes by name before `run`, so
  this should self-heal on the next start. To clean up manually:
  ```bash
  container list -a --format '{{.Name}}' | grep '^pi-sbx-' \
    | xargs -r -n1 container delete -f
  ```
- **`npm install` hangs in the sandbox** — you need network: add
  `--container-net`.
- **Agent says it can't find `~/.aws/credentials`** — that's the point.
  If the task needs a credential, mount it explicitly by editing the `run()`
  args in `index.ts` (and only that one credential).
