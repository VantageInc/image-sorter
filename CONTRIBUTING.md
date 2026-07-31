# Contributing

Thanks for helping improve Image Sorter.

## Before opening a pull request

1. Create a focused branch from `master`.
2. Install with `npm ci`.
3. Keep filesystem and IPC inputs validated and bounded.
4. Add or update tests for behavior changes.
5. Run:

   ```bash
   npm run check
   npm run build:app
   ```

6. For visual changes, verify the empty, scanning, populated, filtered-empty, selected, copy-result, and error states at 1440×900 and 1024×768. Check keyboard navigation and 200% zoom.

Do not commit personal images, metadata, generated packages, `node_modules`, or investigation artifacts.

## Design principles

- The primary job is confident selection and safe export from a large archive.
- Preserve the quiet archival/contact-sheet identity.
- Every visible action must be keyboard accessible and have a clear focus state.
- Operational text should be direct: avoid internal terms such as “staged.”
- Show progress, failure, recovery, and conflict behavior before decorative polish.

## Commit style

Use concise imperative subjects, for example:

- `fix: preserve relative paths during export`
- `feat: add cancellable catalog scan`
- `docs: explain unsigned release verification`
