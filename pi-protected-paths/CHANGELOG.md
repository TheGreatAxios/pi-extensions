# Changelog

All notable changes to the `pi-protected-paths` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Upgraded `@earendil-works/pi-coding-agent` dependency to `^1.0.0` for pi v1 compatibility.
- Synchronized `pi-ext.json` version metadata with `package.json` (`0.1.2`).

### Fixed
- Removed `.js` extension from `./features/protected-paths` import in `index.ts` to adhere to ESM module resolution conventions.
- Fixed file extension extraction logic in `isProtected()` to prevent non-dot arguments (e.g. `grep KEY .env`) from incorrectly matching protected extensions.

### Added
- Exported `isProtected`, `detectProtectedRead`, and `shouldBlockTool` helper functions from `features/protected-paths.ts`.

## [0.1.2] - 2026-11-03

### Changed
- Bumped patch version for pi v1 SDK compatibility, extension export alignment, and import fix.

## [0.1.1] - 2026-10-25

### Fixed
- Fixed case sensitivity in sensitive extension detection (.PEM, .KEY).

## [0.1.0] - 2026-10-12

### Added
- Initial release of `pi-protected-paths`: Blocks write/edit/read operations on sensitive files (.env, .git, node_modules, SSH keys, cloud credentials).
