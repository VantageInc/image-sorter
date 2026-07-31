# Security policy

## Supported version

Security fixes are applied to the latest release.

| Version | Supported |
| --- | --- |
| 1.1.x | Yes |
| 1.0.x | No |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the repository’s **Security → Advisories → Report a vulnerability** flow so the maintainers can investigate privately.

Include the affected version, operating system, reproduction steps, expected impact, and any proof-of-concept files that are safe to share. Do not include private images or metadata.

## Security model

Image Sorter processes untrusted local files. The project therefore:

- keeps the Electron renderer sandboxed with context isolation;
- validates IPC payloads and limits filesystem operations to user-approved roots;
- performs bounded scanning and thumbnail work;
- never executes bundled Ghostscript, Poppler, or GraphicsMagick binaries;
- never overwrites an existing export;
- blocks unexpected navigation, popups, downloads, and permissions.

The application does not upload catalog contents, file paths, images, or metadata.

Dependency audit policy and reviewed build-tool exceptions are documented in
[`docs/DEPENDENCY_AUDIT.md`](docs/DEPENDENCY_AUDIT.md).
