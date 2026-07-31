# Dependency audit policy

Image Sorter treats code shipped in the application separately from build and
test tooling:

- CI fails when `npm audit --omit=dev --audit-level=high` finds a high or
  critical runtime vulnerability.
- CI verifies npm registry signatures and provenance attestations with
  `npm audit signatures`.
- CodeQL and Dependabot run continuously on the public repository.
- Packaged-app smoke tests assert that `node_modules` is not copied into the
  ASAR; application dependencies are bundled by Vite.

## Temporary build-tool exception

Reviewed: 2026-07-31

Review again by: 2026-10-31

Advisory: `GHSA-mh99-v99m-4gvg` / `CVE-2026-14257`

As of this review, npm reports high-severity findings through legacy
`minimatch` dependency branches used only by Electron packaging and lint
tools. The lockfile overrides those branches to the maintained backport
releases `brace-expansion` 1.1.18, 2.1.4, 3.0.6, and 5.0.9. Each backport
contains the bounded `maxLength` expansion fix, but npm's advisory range does
not recognize every maintenance branch.

This exception does not suppress runtime findings. A release check verifies
the exact installed backport versions and the presence of the length bound.
Remove this exception as soon as the upstream advisory metadata or packaging
dependency graph no longer reports it.
