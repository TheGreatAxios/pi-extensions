# Container Sandbox Runtime Consolidation Design

This document outlines the architectural design for consolidating `pi-apple-container` into `pi-container-sandbox`, adding first-class support for Colima and Podman/Finch, and establishing a unified multi-runtime container sandbox extension for pi.

---

## 1. Overview & Motivation

### 1.1 Current State
Currently, the `pi-extensions` repository provides two separate sandbox extensions:
1. `pi-container-sandbox`: Targets Docker-based container sandboxing.
2. `pi-apple-container`: Targets macOS Apple container CLI sandboxing on Apple Silicon.

### 1.2 Problems with Current Architecture
- **Code Duplication**: `pi-container-sandbox` and `pi-apple-container` duplicate over 80% of their logic. Core modules like `src/paths.ts` (path mapping, `/workspace` translation, skill directory mounting) and `src/resolve.ts` (CLI flag evaluation, auto-start conditions, in-flight state tracking) are virtually identical copy-pastes.
- **Command & Flag Collisions**: If both extensions are installed or loaded into a single pi session, both attempt to register the `/sandbox` command and `--container` CLI flags. This results in registration errors, duplicate command outputs, or unpredictable handler behavior.
- **Fragmented User Configuration**: Users must configure different keys or switch extensions when moving between macOS (Apple Silicon native container) and Linux / Intel macOS (Docker).
- **Missing Common Engines**: Popular developer setups like **Colima** (macOS lightweight Docker daemon) and **Podman / Finch** (daemonless rootless OCI engines) are not explicitly detected or integrated.
- **Feature Disparity**: Docker image digest verification (`/sandbox pin` and automated Docker Hub daily digest checks) exists in `pi-container-sandbox`, but is absent from `pi-apple-container`.

### 1.3 Consolidation Goals
- Provide a **single, unified package** (`pi-container-sandbox`) that automatically selects and operates the best available container engine.
- Establish a clean `ContainerRuntime` abstraction layer under `src/runtimes/`.
- Provide zero-config auto-detection for Apple container, Docker, Colima, and Podman/Finch.
- Eliminate code duplication across `paths.ts`, `resolve.ts`, and CLI command handling.
- Deprecate `pi-apple-container` cleanly with a forward migration path.

---

## 2. Supported Container Runtimes

| Runtime Engine | Target Environment | CLI Binary / Socket | Execution Mechanism |
|---|---|---|---|
| **Apple Container** | macOS 26+ on Apple Silicon (`darwin-arm64`) | `container` binary | `container run`, `container exec`, `container stop` |
| **Docker** | macOS, Linux, Windows (WSL2) | `docker` CLI, `/var/run/docker.sock` | `docker run`, `docker exec`, `docker stop` |
| **Colima** | macOS (Docker replacement via Lima VM) | `docker` CLI with `~/.colima/default/docker.sock` | Auto-injects `DOCKER_HOST` environment variable |
| **Podman / Finch** | Linux, macOS rootless OCI engine | `podman` or `finch` CLI | Compatible Docker CLI / socket flag syntax |

---

## 3. Architecture & Runtime Abstraction

### 3.1 Interface Definition (`src/runtimes/interface.ts`)

```typescript
export type RuntimeName = "docker" | "apple" | "colima" | "podman";

export interface ContainerMount {
	hostPath: string;
	containerPath: string;
	readOnly: boolean;
}

export interface ContainerStartOptions {
	image: string;
	containerName: string;
	workspaceMount: ContainerMount;
	skillMounts: ContainerMount[];
	additionalMounts?: ContainerMount[];
	allowNetwork: boolean;
	environment?: Record<string, string>;
}

export interface ContainerInstance {
	id: string;
	name: string;
	runtime: RuntimeName;
	image: string;
	running: boolean;
}

export interface ContainerExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ContainerExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ImageInfo {
	image: string;
	digest?: string;
	created?: string;
	size?: number;
}

export interface ContainerRuntime {
	readonly name: RuntimeName;
	readonly displayName: string;

	/**
	 * Detect if this runtime is installed and operational on the host system.
	 */
	detect(): Promise<boolean>;

	/**
	 * Ensure the required sandbox container image is present (pull or verify).
	 */
	ensureImage(image: string): Promise<ImageInfo>;

	/**
	 * Start a long-running sandbox container instance with required mounts.
	 */
	start(options: ContainerStartOptions): Promise<ContainerInstance>;

	/**
	 * Execute a command inside the running sandbox container.
	 */
	exec(
		instanceId: string,
		command: string,
		options?: ContainerExecOptions
	): Promise<ContainerExecResult>;

	/**
	 * Stream execution output from inside the running sandbox container.
	 */
	execStream(
		instanceId: string,
		command: string,
		onStdout: (chunk: string) => void,
		onStderr: (chunk: string) => void,
		options?: ContainerExecOptions
	): Promise<number>;

	/**
	 * Stop and cleanup the container instance.
	 */
	stop(instanceId: string): Promise<void>;

	/**
	 * Query status of running containers managed by this extension.
	 */
	listRunning(): Promise<ContainerInstance[]>;

	/**
	 * Verify or pin image digest.
	 */
	pinImage?(image: string): Promise<string>;
}
```

### 3.2 Target Directory Structure

```
pi-container-sandbox/
├── src/
│   ├── runtimes/
│   │   ├── interface.ts      # ContainerRuntime, options, and result interfaces
│   │   ├── registry.ts       # Runtime registry & auto-detection engine
│   │   ├── docker.ts         # Docker CLI / socket runtime implementation
│   │   ├── apple.ts          # Apple container CLI implementation (ported)
│   │   ├── colima.ts         # Colima runtime adapter (auto-injects DOCKER_HOST)
│   │   └── podman.ts         # Podman / Finch OCI runtime implementation
│   ├── paths.ts              # Shared path translation (/workspace, /skills, mounts)
│   ├── paths.test.ts         # Unit tests for path resolution
│   ├── resolve.ts            # Shared CLI flag and configuration resolver
│   ├── resolve.test.ts       # Unit tests for flag and state resolution
│   └── image.ts              # Image digest inspection and Docker Hub verification
├── docker/
│   └── Dockerfile            # Default sandbox container image definition
├── index.ts                  # Extension entry point, tool interception, commands
├── DESIGN.md                 # This architectural specification
├── CHANGELOG.md              # Package changelog
└── package.json              # Package manifest
```

---

## 4. Runtime Selection & Detection Logic

### 4.1 Configuration & Flag Precedence

The runtime selection strategy supports both explicit configuration and zero-config automatic detection:

1. **Explicit CLI Flag**: `--runtime <auto|apple|docker|colima|podman>`
2. **Project / User Configuration**: In `.pi/config.json` (resolved via `CONFIG_DIR_NAME`):
   ```json
   {
     "sandbox": {
       "runtime": "auto"
     }
   }
   ```
3. **Environment Variable Override**: `PI_SANDBOX_RUNTIME=docker|apple|colima|podman`
4. **Automatic Detection (`auto`)**: Evaluated in strict order of capability and platform fit.

### 4.2 Auto-Detection Algorithm

When `runtime` is `"auto"` (the default), the detector iterates through the following sequence:

```mermaid
flowchart TD
    Start([Start Sandbox Initialization]) --> Explicit{Explicit Runtime\nConfigured?}
    Explicit -- Yes --> UseExplicit[Initialize Configured Runtime]
    Explicit -- No (auto) --> CheckDarwin{Platform is macOS\narm64?}
    
    CheckDarwin -- Yes --> CheckApple{`container` CLI\npresent & functional?}
    CheckApple -- Yes --> UseApple[Select Apple Container Runtime]
    CheckApple -- No --> CheckDocker
    
    CheckDarwin -- No --> CheckDocker{Docker daemon active\n(/var/run/docker.sock\nor standard DOCKER_HOST)?}
    
    CheckDocker -- Yes --> UseDocker[Select Docker Runtime]
    CheckDocker -- No --> CheckColima{Colima socket exists\n(~/.colima/default/docker.sock)\nor `colima status` == 0?}
    
    CheckColima -- Yes --> UseColima[Select Colima Runtime\nInject DOCKER_HOST]
    CheckColima -- No --> CheckPodman{`podman` or `finch`\nCLI available?}
    
    CheckPodman -- Yes --> UsePodman[Select Podman Runtime]
    CheckPodman -- No --> Error[Diagnostic Error:\nNo container engine detected]
```

#### Precedence Details:
1. **Apple Silicon Native (`apple`)**:
   - Check: `process.platform === "darwin" && process.arch === "arm64"`.
   - Command: `which container >/dev/null 2>&1` and `container list --status running` probe.
   - Rationale: On macOS 26+ on Apple Silicon, native containerization has zero VM overhead compared to Docker Desktop.
2. **Standard Docker (`docker`)**:
   - Check: `docker info >/dev/null 2>&1` (via `/var/run/docker.sock` or pre-existing `DOCKER_HOST`).
   - Rationale: Standard cross-platform container runtime for Linux and systems running Docker Desktop.
3. **Colima (`colima`)**:
   - Check: `existsSync(`${process.env.HOME}/.colima/default/docker.sock`)` or `colima status` exits with code 0.
   - Action: Automatically injects `DOCKER_HOST=unix://${process.env.HOME}/.colima/default/docker.sock` into spawned subprocesses.
   - Rationale: Extremely popular lightweight Docker alternative for macOS developers avoiding Docker Desktop licensing.
4. **Podman / Finch (`podman`)**:
   - Check: `which podman >/dev/null 2>&1` or `which finch >/dev/null 2>&1`.
   - Action: Executes commands using OCI-compliant CLI parameters.
5. **Detection Failure**:
   - Throws a descriptive error detailing:
     - Checked engines: `apple`, `docker`, `colima`, `podman`.
     - Actionable remediations: e.g. "Start Docker Desktop, run 'colima start', or install Apple container tools."

---

## 5. Unified CLI Flags & Command Interface

### 5.1 Command-Line Flags
- `--container`: Force enable container sandboxing for the session.
- `--no-container` / `--noc`: Disable container sandboxing for the session.
- `--runtime <auto|apple|docker|colima|podman>`: Select active container runtime engine.
- `--keep`: Do not terminate or remove container on session exit.
- `--network`: Allow outbound internet connectivity from inside container.

### 5.2 Slash Command: `/sandbox`
The `/sandbox` command provides interactive inspection and management:

- `/sandbox`: Display comprehensive status including:
  - Active runtime engine (e.g. `apple`, `docker (colima)`)
  - Running container ID and uptime
  - Mapped directories (Workspace host path -> `/workspace`)
  - Mounted skill directories
  - Image tag and SHA256 digest
  - Network mode (isolated or connected)
- `/sandbox runtime [engine]`: View or switch active runtime.
- `/sandbox pin`: Pin current container image digest in configuration.
- `/sandbox default [on|off]`: Persist default sandbox enablement in `.pi/config.json`.
- `/sandbox restart`: Stop current container and launch a fresh instance.

---

## 6. Feature Parity & Security Architecture

### 6.1 Porting Digest Verification to Apple Runtime
`pi-container-sandbox` includes digest verification to protect against supply chain tampering or unpinned upstream image mutation.
In the unified architecture:
- Docker and Colima query the local image digest via `docker inspect --format='{{index .RepoDigests 0}}' <image>`.
- Apple container queries the image manifest via `container inspect <image>`.
- The digest verification service (`src/image.ts`) is shared across all runtimes.

### 6.2 Network Isolation Consistency
- **Docker / Colima / Podman**: Executed with `--network none` when network is disabled, or bridge network when allowed.
- **Apple Container**: Executed with `--no-dns` and isolated network namespace when network is disabled.

### 6.3 File System Mounts & Tool Interception
All runtimes share the identical interception logic:
- Intercepts built-in tools: `read`, `write`, `edit`, and `bash`.
- Translates host file paths to `/workspace/...` via `toRemote()`.
- Replaces tool implementations with container execution calls:
  - `read` -> streams file contents from container filesystem.
  - `write` -> writes content via container stdin/tee.
  - `edit` -> applies surgical line edits inside `/workspace`.
  - `bash` -> executes commands inside container environment using `execStream()`.

---

## 7. Migration & Deprecation Roadmap

### Phase 1: Architecture & Design (Milestone M3 — Current)
- Complete comprehensive architectural design in `pi-container-sandbox/DESIGN.md`.
- Document runtime interface contracts and detection strategy.
- Maintain existing separate packages without code breakage.

### Phase 2: Runtime Engine Refactor in `pi-container-sandbox`
- Implement `src/runtimes/interface.ts` and `src/runtimes/registry.ts`.
- Move Docker logic into `src/runtimes/docker.ts`.
- Port Apple container implementation into `src/runtimes/apple.ts`.
- Add Colima auto-detection adapter in `src/runtimes/colima.ts`.
- Add Podman adapter in `src/runtimes/podman.ts`.
- Add `--runtime` CLI flag and update `/sandbox` status command.

### Phase 3: Parity Testing & Validation
- Validate test suites across all 4 runtimes.
- Run multi-runtime unit tests for path translation and command resolution.
- Verify that image digest pinning works consistently across engines.

### Phase 4: Deprecation of `pi-apple-container`
- Update `pi-apple-container/README.md` with deprecation notice:
  > **DEPRECATED**: `pi-apple-container` has been consolidated into `pi-container-sandbox`. Please uninstall `pi-apple-container` and install `pi-container-sandbox`, which natively supports Apple container CLI with automatic detection.
- Add runtime deprecation warning log if `pi-apple-container` is loaded.
- Bump `pi-apple-container` version and publish deprecation notice to npm.

### Phase 5: Package Archival
- Remove `pi-apple-container` from the monorepo root workspace.
- Retain only `pi-container-sandbox` as the sole container virtualization extension for pi.
