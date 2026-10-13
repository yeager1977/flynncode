# Flynncode self-based builds + naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every shipped Flynncode artifact is built from this repo and carries flynncode naming; the only upstream tie left is the git remote.

**Architecture:** Mechanical rename of build/packaging inputs (flynncode CLI binary feeds the desktop app instead of a pinned upstream download), user-visible identity swap for the desktop app and CLI artifacts, internals untouched so `git fetch upstream` merges keep working.

**Tech Stack:** Bun (build scripts, `Bun.build` compile), electron-builder 26, TypeScript, Effect (untouched), dpkg (verify/install).

## Global Constraints

- Commit messages use conventional style: `type(scope): summary` with types `feat`, `fix`, `docs`, `chore`, `refactor`, `test`; no slashes in branch names; this work lands on `dev`.
- Run `bun typecheck` from package directories (`packages/flynncode`, `packages/desktop`), never `tsc` directly.
- Run tests from package dirs (`packages/desktop`, `packages/flynncode`), never from repo root.
- `packages/desktop` renderer code must call only `window.api` from `src/preload`; user-visible English copy uses i18n keys (this plan adds no user-visible strings except packaging metadata).
- Use `const`, ternaries, early returns; no `else`; no `any`; no import aliases or star imports; follow the self-export pattern (`export * as X from "./x"`).
- Beta/prod channels keep their current behavior of NOT bundling a CLI — only the dev channel bundles `flynncode-cli`.

---

### Task 1: Rename CLI build artifacts to `flynncode-*`

**Files:**
- Modify: `packages/flynncode/script/build.ts` (lines 139-140, 180-181, 209, 214)

**Interfaces:**
- Consumes: nothing.
- Produces: `bun script/build.ts --single` emits `dist/flynncode-<os>-<arch>/bin/flynncode` (e.g. `dist/flynncode-linux-x64/bin/flynncode`). Later tasks rely on this exact path.

- [ ] **Step 1: Edit `artifactPrefix` and its comment**

```ts
// Old (packages/flynncode/script/build.ts:139-140):
// Platform packages and release consumers retain the external opencode-* contract during the rename.
const artifactPrefix = "opencode"

// New:
// Fork artifacts carry the flynncode-* contract; upstream release consumers are unsupported.
const artifactPrefix = "flynncode"
```

- [ ] **Step 2: Rename the compiled binary output and user-agent**

```ts
// Old (line 180-181):
      outfile: `dist/${name}/bin/opencode`,
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],

// New:
      outfile: `dist/${name}/bin/flynncode`,
      execArgv: [`--user-agent=flynncode/${Script.version}`, "--use-system-ca", "--"],
```

Note: line 179 `target: name.replace(artifactPrefix, "bun")` needs no edit — with the new
prefix `flynncode-linux-x64` still maps to `bun-linux-x64`.

- [ ] **Step 3: Rename the darwin re-sign path and the smoke-test path**

```ts
// Old (line 209):
    await $`codesign --force --sign - dist/${name}/bin/opencode`
// New:
    await $`codesign --force --sign - dist/${name}/bin/flynncode`
```

```ts
// Old (line 214):
    const binaryPath = `dist/${name}/bin/opencode`
// New:
    const binaryPath = `dist/${name}/bin/flynncode`
```

- [ ] **Step 4: Verify no other `opencode` binary-name references remain in the file**

Run: `grep -n "bin/opencode\|user-agent=opencode\|artifactPrefix = " packages/flynncode/script/build.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/flynncode/script/build.ts
git commit -m "refactor(flynncode): rename build artifacts to flynncode prefix"
```

### Task 2: Verify the renamed CLI builds and runs

**Files:**
- Test: `packages/flynncode/dist/flynncode-linux-x64/bin/flynncode` (build output, gitignored)

**Interfaces:**
- Consumes: Task 1's `artifactPrefix` change.
- Produces: a working `dist/flynncode-linux-x64/bin/flynncode` that Task 6 stages into the desktop app.

- [ ] **Step 1: Build the host-platform CLI**

Run: `bun script/build.ts --single`
Workdir: `packages/flynncode`
Expected: log line `building flynncode-linux-x64`, then `Smoke test passed: 1.18.34-dev-<stamp>`.

- [ ] **Step 2: Confirm binary identity and schema support**

```bash
./dist/flynncode-linux-x64/bin/flynncode --version
grep -c "full-access" ./dist/flynncode-linux-x64/bin/flynncode
```

Expected: version prints `1.18.34-dev-<stamp>`; grep count is greater than 0
(the `SandboxMode` schema that accepts `permission.sandbox: "full-access"`).

- [ ] **Step 3: Confirm the working tree has no stray changes**

Run: `git status --short -- packages/flynncode/dist`
Expected: no output (`dist/` is gitignored).

### Task 3: Re-point `publish.ts` at the fork

**Files:**
- Modify: `packages/flynncode/script/publish.ts` (lines 81, 90-93, 98-125, 127, 131, 147-194, 204-207)

**Interfaces:**
- Consumes: Task 1's `flynncode-*` artifact names.
- Produces: release scaffolding that can only ever publish fork-named artifacts to fork-owned destinations. No release is cut in this plan.

- [ ] **Step 1: Re-point the container image and tarball hashes**

```ts
// Old (line 81):
const image = "ghcr.io/anomalyco/opencode"
// New:
const image = "ghcr.io/yeager1977/flynncode"
```

```ts
// Old (lines 90-93):
  const arm64Sha = await $`sha256sum ./dist/opencode-linux-arm64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/opencode-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/opencode-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/opencode-darwin-arm64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
// New: same four lines with flynncode-linux-arm64.tar.gz, flynncode-linux-x64.tar.gz,
// flynncode-darwin-x64.zip, flynncode-darwin-arm64.zip.
```

- [ ] **Step 2: Rewrite the AUR PKGBUILD block (lines 98-125)**

New block (exact):

```ts
  const binaryPkgbuild = [
    "# Maintainer: yeager1977",
    "",
    "pkgname='flynncode-bin'",
    `pkgver=${pkgver}`,
    `_subver=${_subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='The AI coding agent built for the terminal.'",
    "url='https://github.com/yeager1977/flynncode'",
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    "provides=('flynncode')",
    "conflicts=('flynncode')",
    "depends=('ripgrep')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/yeager1977/flynncode/releases/download/v\${pkgver}\${_subver}/flynncode-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,

    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/yeager1977/flynncode/releases/download/v\${pkgver}\${_subver}/flynncode-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./flynncode "${pkgdir}/usr/bin/flynncode"',
    "}",
    "",
  ].join("\n")
```

And the loop header (line 127):

```ts
// Old:
  for (const [pkg, pkgbuild] of [["opencode-bin", binaryPkgbuild]]) {
// New:
  for (const [pkg, pkgbuild] of [["flynncode-bin", binaryPkgbuild]]) {
```

(No edit needed on line 131: `git clone ssh://aur@aur.archlinux.org/${pkg}.git` now clones
`flynncode-bin.git` via the renamed `pkg`.)

- [ ] **Step 3: Rewrite the Homebrew formula block (lines 147-194)**

New block (exact):

```ts
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "class Flynncode < Formula",
    `  desc "The AI coding agent built for the terminal."`,
    `  homepage "https://github.com/yeager1977/flynncode"`,
    `  version "${Script.version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/yeager1977/flynncode/releases/download/v${Script.version}/flynncode-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "flynncode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/yeager1977/flynncode/releases/download/v${Script.version}/flynncode-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "flynncode"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/yeager1977/flynncode/releases/download/v${Script.version}/flynncode-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "flynncode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/yeager1977/flynncode/releases/download/v${Script.version}/flynncode-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "flynncode"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")
```

(The upstream "This file was generated by GoReleaser. DO NOT EDIT." header is dropped — the
formula is now hand-maintained by the fork.)

- [ ] **Step 4: Re-point the tap clone and formula filename (lines 204-207)**

```ts
// Old:
  const tap = `https://x-access-token:${token}@github.com/anomalyco/homebrew-tap.git`
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone ${tap} ./dist/homebrew-tap`
  await Bun.file("./dist/homebrew-tap/opencode.rb").write(homebrewFormula)
  await $`cd ./dist/homebrew-tap && git add opencode.rb`
// New:
  const tap = `https://x-access-token:${token}@github.com/yeager1977/homebrew-tap.git`
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone ${tap} ./dist/homebrew-tap`
  await Bun.file("./dist/homebrew-tap/flynncode.rb").write(homebrewFormula)
  await $`cd ./dist/homebrew-tap && git add flynncode.rb`
```

- [ ] **Step 5: Typecheck and confirm no `anomalyco` references remain**

Run: `bun typecheck`
Workdir: `packages/flynncode`
Expected: clean.

Run: `grep -n "anomalyco\|opencode-linux\|opencode-darwin\|opencode-bin\|/opencode\"\|bin.install \"opencode\"\|\"opencode\"" packages/flynncode/script/publish.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add packages/flynncode/script/publish.ts
git commit -m "refactor(flynncode): point publish targets at the fork"
```

Note for the reviewer: the AUR package `flynncode-bin` and the `yeager1977/homebrew-tap`
repo may not exist yet — creating them is a first-release concern, explicitly out of scope.
No release is cut in this plan.

### Task 4: Point version resolution at the fork

**Files:**
- Modify: `packages/script/src/index.ts` (registry URL line, `console.log` line)

**Interfaces:**
- Consumes: nothing.
- Produces: `Script.version`/`Script.channel` with no upstream network dependency.

- [ ] **Step 1: Edit the registry fallback and the log prefix**

```ts
// Old:
  const version = await fetch("https://registry.npmjs.org/opencode-ai/latest")
// New:
  const version = await fetch("https://registry.npmjs.org/flynncode-ai/latest")
```

```ts
// Old:
console.log(`opencode script`, JSON.stringify(Script, null, 2))
// New:
console.log(`flynncode script`, JSON.stringify(Script, null, 2))
```

Leave `const bot = ["actions-user", "opencode", "opencode-agent[bot]"]` untouched — those are
release-CI actor names, not branding or binaries.

- [ ] **Step 2: Typecheck the script package**

Run: `bun typecheck`
Workdir: `packages/script`
Expected: clean. If `packages/script/package.json` has no `typecheck` script, run
`bunx tsgo --noEmit` in `packages/script` instead and expect clean output.

- [ ] **Step 3: Commit**

```bash
git add packages/script/src/index.ts
git commit -m "refactor(script): resolve versions from fork packages"
```

### Task 5: Stage the fork CLI into desktop resources (delete upstream vendoring)

**Files:**
- Modify: `packages/desktop/scripts/utils.ts` (full rewrite below)
- Modify: `packages/desktop/scripts/predev.ts`, `packages/desktop/scripts/prebuild.ts`
- Modify: `packages/desktop/.gitignore`

**Interfaces:**
- Consumes: Task 2's `dist/flynncode-<os>-<arch>/bin/flynncode`.
- Produces: `stageForkCliToResources(options)` used by Tasks 5 Steps 3-4; `resources/flynncode-cli`
  (gitignored) is the file electron-builder bundles and the unpackaged app executes.

- [ ] **Step 1: Rewrite `packages/desktop/scripts/utils.ts`**

New file content (exact):

```ts
import { $ } from "bun"
import { existsSync } from "node:fs"
import { chmod, copyFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const RUST_TARGET = Bun.env.RUST_TARGET

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(desktopDir)

function hostArtifactName() {
  const os = process.platform === "win32" ? "windows" : process.platform
  return `flynncode-${os}-${process.arch}`
}

function forkCliSource() {
  const binary = process.platform === "win32" ? "flynncode.exe" : "flynncode"
  return join(repoRoot, "packages", "flynncode", "dist", hostArtifactName(), "bin", binary)
}

export async function stageForkCliToResources(options: { buildIfMissing?: boolean } = {}) {
  let source = forkCliSource()
  if (!existsSync(source) && options.buildIfMissing) {
    await $`bun script/build.ts --single`.cwd(join(repoRoot, "packages", "flynncode"))
    source = forkCliSource()
  }
  if (!existsSync(source)) {
    throw new Error(
      `Fork CLI missing at ${source}. Build it with \`bun script/build.ts --single\` in packages/flynncode. Upstream CLI downloads are not supported.`,
    )
  }
  const dest = windowsify(join(desktopDir, "resources", "flynncode-cli"))
  await copyFile(source, dest)
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Staged fork CLI to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
```

Do NOT reintroduce `CLI_VERSION`, `CLI_BINARIES`, `getCurrentCli`, `nativeTarget`, or
`downloadCliToResources`. Keep the `RUST_TARGET` export — `scripts/copy-bundles.ts` imports it.

- [ ] **Step 2: Delete the stale upstream CLI binary and update `.gitignore`**

```bash
rm -f packages/desktop/resources/opencode-cli
```

In `packages/desktop/.gitignore`, replace the line `resources/opencode-cli*` with
`resources/flynncode-cli*`.

- [ ] **Step 3: Rewire `packages/desktop/scripts/predev.ts`**

New file content (exact):

```ts
import { $ } from "bun"
import { stageForkCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../flynncode && bun script/build-node.ts`
await stageForkCliToResources({ buildIfMissing: true })
```

`buildIfMissing: true` keeps everyday `bun run dev` iteration fast: an existing dist binary
is reused, and the multi-minute `--single` compile only runs when `dist/` is absent
(`build.ts` itself does `rm -rf dist`, so packaged builds are always fresh).

- [ ] **Step 4: Rewire `packages/desktop/scripts/prebuild.ts`**

New file content (exact):

```ts
#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel, stageForkCliToResources } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../flynncode && bun script/build-node.ts`
await $`cd ../flynncode && bun script/build.ts --single`
if (channel === "dev") await stageForkCliToResources()
```

Packaging always compiles a fresh fork CLI (`--single` for the host platform) and stages it;
the explicit `--single` build runs for every channel so a missing `dist/` can never silently
produce a CLI-less package.

- [ ] **Step 5: Typecheck the desktop package**

Run: `bun typecheck`
Workdir: `packages/desktop`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/scripts/utils.ts packages/desktop/scripts/predev.ts packages/desktop/scripts/prebuild.ts packages/desktop/.gitignore
git commit -m "refactor(desktop): stage the fork CLI instead of the upstream CLI"
```

Note: `git rm` is not needed for `resources/opencode-cli` — it is gitignored and untracked.

### Task 6: Rename the bundled CLI in the main process

**Files:**
- Modify: `packages/desktop/src/main/background-cli.ts` (lines 12, 123-125, plus a comment at lines 50/55)

**Interfaces:**
- Consumes: Task 5's `resources/flynncode-cli`.
- Produces: packaged and unpackaged apps execute `flynncode-cli`.

- [ ] **Step 1: Update state-dir names and the executable name**

```ts
// Old (line 12):
const desktopStateNames = ["ai.opencode.desktop.dev", "ai.opencode.desktop.beta", "ai.opencode.desktop"]
// New:
const desktopStateNames = ["ai.flynncode.desktop.dev", "ai.flynncode.desktop.beta", "ai.flynncode.desktop"]
```

```ts
// Old (lines 123-125):
function executableName() {
  return process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
}
// New:
function executableName() {
  return process.platform === "win32" ? "flynncode-cli.exe" : "flynncode-cli"
}
```

- [ ] **Step 2: Annotate the service username (no rename)**

Above the first `username: "opencode"` (line 50), add:

```ts
  // Service auth username: protocol constant matching packages/server/src/auth.ts.
  // Do not rebrand — the server rejects any other value.
```

Apply to both occurrences (the log meta at line 50 and the return value at line 55).
Verify the server side still expects it:

Run: `grep -rn '"opencode"' packages/server/src/routes.ts packages/server/src/auth.ts`
Expected: `routes.ts` shows `username: "opencode"` and `auth.ts` shows the `"opencode"` default —
confirming the client strings must stay.

- [ ] **Step 3: Typecheck**

Run: `bun typecheck`
Workdir: `packages/desktop`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/main/background-cli.ts
git commit -m "refactor(desktop): launch the fork CLI and flynncode state dirs"
```

### Task 7: Swap the desktop app identity

**Files:**
- Modify: `packages/desktop/electron-builder.config.ts` (APP_IDS, artifactName, files filter, extraResources filter, legacy entry removal, productNames, protocols names)
- Modify: `packages/desktop/scripts/copy-metainfo.ts` (full rewrite below)
- Modify: `packages/desktop/package.json` (description, author, homepage)
- Delete: `packages/desktop/resources/linux/opencode-desktop.desktop` (tracked file)

**Interfaces:**
- Consumes: Tasks 5-6 (bundled CLI identity).
- Produces: channel configs consumed by Task 8's tests; `copy-metainfo.ts` output consumed by packaging.

- [ ] **Step 1: Update `APP_IDS`, product names, and artifact names**

```ts
// Old:
const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const
// New:
const APP_IDS = {
  dev: "ai.flynncode.desktop.dev",
  beta: "ai.flynncode.desktop.beta",
  prod: "ai.flynncode.desktop",
} as const
```

```ts
// Old:
  artifactName: "opencode-desktop-${os}-${arch}.${ext}",
// New:
  artifactName: "flynncode-desktop-${os}-${arch}.${ext}",
```

```ts
// Old:
        productName: "OpenCode Dev",
// New:
        productName: "Flynncode Dev",
```

```ts
// Old (beta):
        productName: "OpenCode Beta",
// New:
        productName: "Flynncode Beta",
```

```ts
// Old (prod):
        productName: "OpenCode",
// New:
        productName: "Flynncode",
```

- [ ] **Step 2: Swap the CLI resource filters and drop the legacy launcher**

```ts
// Old:
  files: ["out/**/*", "resources/**/*", "!resources/opencode-cli*"],
// New:
  files: ["out/**/*", "resources/**/*", "!resources/flynncode-cli*"],
```

```ts
// Old:
            filter: ["opencode-cli*"],
// New:
            filter: ["flynncode-cli*"],
```

Delete the `legacyDesktopEntry` const and its comment (lines 12-16), delete the
`legacyDesktopEntryFpm` const (line 16), and delete its use in the prod `deb`/`rpm`
fpm arrays so prod ships only `metainfoFpm(appId)`.

```bash
git rm packages/desktop/resources/linux/opencode-desktop.desktop
```

- [ ] **Step 3: Keep the `opencode://` protocol scheme, rename only the protocol display name**

Update each channel's `protocols.name` ("OpenCode" → "Flynncode Dev", "OpenCode Beta" →
"Flynncode Beta", "OpenCode" → "Flynncode") but leave `schemes: ["opencode"]` untouched —
existing shared links and handler registrations keep working.

- [ ] **Step 4: Pin explicit Linux package names per channel**

Set `packageName` for deb and rpm outputs per channel: dev → `flynncode-dev`,
beta → `flynncode-beta`, prod → `flynncode` (replacing `opencode-dev` / `opencode-beta`).
With productName "Flynncode Dev" the builder-derived default already yields `flynncode-dev`;
set the keys explicitly anyway so the identity cannot drift. If `tsgo` rejects the key on
`deb`, keep the `rpm.packageName` form that already exists in this file and rely on the
productName-derived deb default — then prove the actual name in Task 11 with
`dpkg-deb -f Package`.

- [ ] **Step 5: Rewrite `packages/desktop/scripts/copy-metainfo.ts`**

New file content (exact):

```ts
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const chan
...[truncated 9117 chars]