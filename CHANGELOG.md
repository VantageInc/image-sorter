# Changelog

All notable changes to Image Sorter are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-07-31

### Added

- A responsive archival contact-sheet interface with keyboard-complete controls.
- Scan progress, cancellation, partial-result warnings, and recoverable error states.
- A single catalog pass that also builds the folder tree and aggregate statistics.
- Exact resolution groups, visible-result selection, and selected byte totals.
- A persistent export tray and in-app copied/renamed/failed summaries.
- Safe conflict renaming while preserving source-relative folders.
- Bounded thumbnail work with caching and operating-system fallbacks.
- Progressive contact-sheet, folder-tree, and dimension-index rendering for very large catalogs.
- Browser demo mode for repeatable visual and interaction testing.
- Automated type checking, linting, tests, Windows/macOS CI, and tagged release builds.

### Changed

- Upgraded the desktop runtime from Electron 28 to Electron 43.
- Replaced the brittle utility-class layout with a semantic, responsive design system.
- Hardened BrowserWindow, navigation, permissions, IPC validation, and path access.
- Reduced packaged dependencies and removed deprecated native PDF/GraphicsMagick tooling.

### Fixed

- Copy collisions and accidental destination overwrites.
- Stale scan results, duplicated directory traversal, and unreadable-folder aborts.
- Hidden items being included by “select all shown.”
- Inaccessible image cards, directory rows, group selectors, menus, and window controls.
- Minimum-window clipping, missing focus states, low contrast, and endless loading placeholders.
- Metadata serialization and dimension grouping inconsistencies.
- Folder filtering on case-sensitive macOS volumes.

## [1.0.0] - 2026-02-24

- Initial Windows preview release.

[1.1.0]: https://github.com/VantageInc/image-sorter/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/VantageInc/image-sorter/releases/tag/v1.0.0
