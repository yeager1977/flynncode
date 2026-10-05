# Development Release-Base Version Implementation Plan

**Goal:** Base development build versions on the intended backend release.

**Architecture:** Update the existing preview branch in the shared build version
generator. Its desktop and backend consumers continue using `Script.version`.

**Tech Stack:** Bun, TypeScript, package metadata.

## Constraints

- Keep explicit version overrides and release bump behavior unchanged.
- Preserve channel and timestamp suffixes.
- Do not commit or rebuild the user's installed desktop package.

## Implementation

- [ ] Execute the generator with `OPENCODE_CHANNEL=dev` to record the old base.
- [ ] In `packages/script/src/index.ts`, read
  `../../opencode/package.json` relative to `import.meta.dir` inside the preview
  branch and return `${pkg.version}-${CHANNEL}-${timestamp}` using the existing
  timestamp expression.
- [ ] Execute the actual generator for default, dev, beta, and an explicit
  `OPENCODE_VERSION=1.18.99`; assert the version strings and override priority.
- [ ] Run `bun typecheck` from `packages/script` if available; otherwise use
  `bun typecheck` from the consuming `packages/opencode` package.
- [ ] Review the diff and report results and rebuild instructions.
