# Changelog

All notable changes to the `pi-container-sandbox` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Upgraded `@earendil-works/pi-coding-agent` dependency to `^1.0.0` for pi v1 compatibility.
- Standardized config path resolution and project sandbox config resolution (`sandbox.json`) to use `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent` instead of hardcoded literal `".pi"`.
- Standardized skill discovery path resolution to use `getAgentDir()` instead of `${HOME}/.pi/agent`.

### Added
- Documented runtime consolidation architecture in `DESIGN.md` (unifying `pi-apple-container` into `pi-container-sandbox` with Colima and Podman support).

## [0.2.3] - 2026-11-03

### Changed
- Bumped patch version for pi v1 SDK compatibility and config directory standardization.

## [0.2.2] - 2026-10-20

### Fixed
- Improved container process teardown and lifecycle event handling.

## [0.2.0] - 2026-10-01

### Added
- Initial multi-runtime container sandbox support for Linux containers on Docker and Apple container.
