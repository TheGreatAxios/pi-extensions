# Changelog

All notable changes to the `pi-sandbox-proxy` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Upgraded `@earendil-works/pi-coding-agent` dependency to `^1.0.0` for pi v1 compatibility.
- Standardized project configuration resolution in `src/config/loader.ts` to use `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent` instead of hardcoded literal `".pi"`.
- Verified compatibility of `@earendil-works/pi-coding-agent@^1.0.0` exports (`isBashToolResult`, `BashToolCallEvent`, `ToolResultEvent`).

### Fixed
- Fixed indentation on `pi.registerCommand("proxy", ...)` in `index.ts`.

## [0.1.6] - 2026-11-03

### Changed
- Bumped patch version for pi v1 SDK compatibility and config directory standardization.

## [0.1.5] - 2026-10-28

### Added
- Pipeline rules for detecting dangerous pipe-to-shell patterns and unpinned npm installations.

## [0.1.0] - 2026-10-15

### Added
- Initial release of `pi-sandbox-proxy`: Security proxy with approval flows, vulnerability scanning, and supply chain security enforcement.
