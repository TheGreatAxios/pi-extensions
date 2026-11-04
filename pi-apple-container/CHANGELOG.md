# Changelog

All notable changes to the `pi-apple-container` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Upgraded `@earendil-works/pi-coding-agent` dependency to `^1.0.0` for pi v1 compatibility.
- Standardized configuration directory resolution by replacing hardcoded literal `".pi"` paths with `CONFIG_DIR_NAME` exported from `@earendil-works/pi-coding-agent`.
- Standardized skill directory discovery to use `getAgentDir()` instead of `${HOME}/.pi/agent`.

### Fixed
- Fixed `/sandbox` command registration subcommand return types to correctly return `Promise<void>`.

## [0.1.1] - 2026-11-03

### Changed
- Bumped patch version for pi v1 SDK compatibility and config directory standardization.

## [0.1.0] - 2026-10-18

### Added
- Initial release of `pi-apple-container`: lightweight opt-in sandbox leveraging macOS Apple container CLI on Apple Silicon.
