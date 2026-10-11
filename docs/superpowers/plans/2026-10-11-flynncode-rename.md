# Flynncode Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the fork's identity from opencode to flynncode (npm scope, CLI, data dirs, desktop branding), with a one-time import of legacy opencode data and parameterized upstream service URLs.

**Architecture:** Spec is `docs/superpowers/specs/2026-10-11-flynncode-rename-design.md`. Work is a chain of mechanical codemod passes plus three real-code additions: a one-time import module (`packages/core/src/global-import.ts`), an env-flag prefix alias in the `Flag` module, and a `ServiceEndpoints` constants module in core. Runtime dirs flow through `Global.Path` (`packages/core/src/global.ts`), which is the pivot for pass "runtime identity".

**Tech Stack:** Bun, TypeScript, Effect v4, Electron (desktop), GitHub Actions.

## Global Constraints

- Never run tests or typecheck from the repo root guard `do-not-run-tests-from-root`; run from package dirs (e.g. `cd packages/core && bun typecheck`).
- Never hand-edit `bun.lock`; regenerate with `bun install` after package.json changes.
- Never hand-edit `packages/*/src/generated/**` where regeneration is available: after touching `packages/client/src/generated*`, run `bun run generate` from `packages/client`.
- The default branch is `dev`; this work happens on branch `rename-flynncode`.
- Commits: conventional `type(scope): summary`; scope may be `core`, `opencode`→use `core`/`app`/`desktop`/`plugin`, etc.
- Do NOT rename: `@opencode-ai/client` vendored tarball dep and its imports (upstream artifact, follow-up pass), `@gitlab/opencode-gitlab-auth`, `opencode-poe-auth`, `opencode-gitlab-auth` (third-party packages), the `opencode` provider id and `opencode/*` model ids, `OPENCODE_TEST_HOME` (test infra), strings inside upstream help/docs prose unless they describe this binary's own behavior.
- Every `sed -i` codemod in this plan runs with this exclusion set (all shell snippets assume `REPO` = repo root and `CDRY` below): `--exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=.turbo --exclude-dir=.git --exclude=bun.lock`.
- Do not mutate git state beyond commit; never force-push.

---

### Task 1: Baseline audit script

**Files:**
- Create: `script/rename-audit.sh`

**Interfaces:**
- Consumes: nothing
- Produces: `bash script/rename-audit.sh [passname]` — prints counts per rename category; exit code is always 0 (reporting tool, not a gate).

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Residue audit for the flynncode rename. Run with an optional pass label.
set -u
cd "$(dirname "$0")/.."

EXCL=(--exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=.turbo --exclude-dir=.git --exclude=bun.lock --exclude=rename-audit.sh)

label=${1:-baseline}
echo "=== rename audit: $label ==="
for pat in '@opencode-ai/' '^const app = "opencode"' 'packages/opencode' '\.opencode' 'opencode\.json' '~/.config/opencode' '~/.local/share/opencode' 'opencode\.ai' '"OpenCode"' 'ai\.opencode' 'OPENCODE_[A-Z]+' 'productName: "opencode"' 'schemes: \["opencode"\]'; do
  n=$(grep -rE --color=never "${pat}" . "${EXCL[@]}" -l 2>/dev/null | wc -l)
  printf '%-40s %s files\n' "$pat" "$n"
done
echo "done"
```

- [ ] **Step 2: Make executable and run baseline**

```bash
chmod +x script/rename-audit.sh && bash script/rename-audit.sh baseline
```

Expected: prints counts; note the numbers in the commit body for later comparison.

- [ ] **Step 3: Commit**

```bash
git add script/rename-audit.sh
git commit -m "chore: add rename residue audit script"
```

---

### Task 2: npm scope codemod

**Files:**
- Modify: every workspace `package.json`, `.github/workflows/*`, `turbo.json`, `tsconfig.json` files, `*/tsconfig.json`, `script/**`, `sdks/**`, `github/**`, and all `.ts`/`.tsx` sources that mention `@opencode-ai/`
- Do-not-touch: the `@opencode-ai/client` dep in `packages/app/package.json:59`, all imports of `@opencode-ai/client` / `@opencode-ai/client/promise` (45 files in `packages/app`), `bun.lock`

**Interfaces:**
- Consumes: nothing
- Produces: workspace package names `@flynncode/<short>` (e.g. `@flynncode/core`, `@flynncode/opencode`→handled in Task 3, `@flynncode/schema`, `@flynncode/server`); `@opencode-ai/client` still resolves via the vendored tarball.

- [ ] **Step 1: Protect the vendored client from the codemod**

```bash
cd /home/yeager1977/GitHub/flynncode
# Temporarily disguise the dep name + its imports, then restore after the sweep
grep -rl '@opencode-ai/client' packages app 2>/dev/null \
  | grep -v node_modules \
  | xargs sed -i 's|@opencode-ai/client|@@PROTECTED-CLIENT@@|g'
```

Note the `packages app` glob: pass explicit top dirs (`packages`, `sdks`, `github`, `script`) so `.`-wide globs don't wander. Only `packages/app` should match; verify with:

```bash
grep -rl '@@PROTECTED-CLIENT@@' . --exclude-dir=node_modules
# Expected: files under packages/app plus packages/app/package.json only
```

- [ ] **Step 2: Codemod the scope**

```bash
grep -rl '@opencode-ai/' packages sdks github script .github \
  --exclude-dir=node_modules --exclude-dir=.turbo \
  --include='*.ts' --include='*.tsx' --include='*.json' --include='*.yml' --include='*.md' \
  | grep -v 'packages/app/package.json' \
  | xargs sed -i 's|@opencode-ai/|@flynncode/|g'
# Also root-level config files edited directly:
sed -i 's|@opencode-ai/|@flynncode/|g' package.json turbo.json tsconfig.json sst.config.ts 2>/dev/null
```

- [ ] **Step 3: Restore the protected client name**

```bash
grep -rl '@@PROTECTED-CLIENT@@' packages --exclude-dir=node_modules \
  | xargs sed -i 's|@@PROTECTED-CLIENT@@|@opencode-ai/client|g'
```

- [ ] **Step 4: Regenerate lockfile**

```bash
bun install
git diff --stat bun.lock | head
```

Expected: `bun install` succeeds; `bun.lock` now references `@flynncode/*` workspace names. If bun errors resolving the vendored tarball name, stop and report — do not hand-edit the lockfile.

- [ ] **Step 5: Verify**

```bash
grep -rl '@opencode-ai/' packages sdks github script .github package.json turbo.json tsconfig.json sst.config.ts \
  --exclude-dir=node_modules --exclude-dir=.turbo 2>/dev/null
```

Expected: only files matching `@opencode-ai/client` (vendored dep + its imports) remain, plus `packages/app/package.json:59`. Also regenerate client generated code since its imports changed:

```bash
cd packages/client && bun run generate
```

- [ ] **Step 6: Typecheck and test the core packages**

```bash
cd packages/core && bun typecheck
cd ../opencode && bun typecheck && bun test src/config src/auth --timeout 30000 --only-failures 2>/dev/null || bun test --timeout 30000 --only-failures
```

Run tests from `packages/opencode` (dir still named opencode until Task 3), never the repo root.

- [ ] **Step 7: Commit**

```bash
git add -A ':!bun.lock' && git add bun.lock
git commit -m "chore(core): rename npm scope @opencode-ai to @flynncode"
```

---

### Task 3: Core package dir, name, and bin

**Files:**
- Rename: `packages/opencode/` → `packages/flynncode/` (via `git mv`, keeps AGENTS.md at `packages/flynncode/AGENTS.md`)
- Modify: `packages/flynncode/package.json` (name + bin), every reference to `packages/opencode/...` in scripts, workflows, configs, and TS code; `packages/opencode/bin/opencode` → `bin/flynncode`

**Interfaces:**
- Consumes: Task 2's `@flynncode/*` names
- Produces: workspace package `flynncode` at `packages/flynncode`; bin `flynncode` (`packages/flynncode/package.json` bin key `{"flynncode": "./bin/flynncode"}`)

- [ ] **Step 1: Move the directory and the bin file**

```bash
git mv packages/opencode packages/flynncode
git mv packages/flynncode/bin/opencode packages/flynncode/bin/flynncode
```

- [ ] **Step 2: Update package name and bin key**

`packages/flynncode/package.json`: `"name": "opencode"` → `"name": "flynncode"`; `"bin": { "opencode": "./bin/opencode" }` → `"bin": { "flynncode": "./bin/flynncode" }`.

- [ ] **Step 3: Codemod path references**

```bash
grep -rl 'packages/opencode' packages sdks github script .github install docs specs \
  --exclude-dir=node_modules --exclude-dir=.turbo 2>/dev/null \
  | xargs sed -i 's|packages/opencode|packages/flynncode|g'
grep -rl 'packages/opencode' packages/flynncode --exclude-dir=node_modules 2>/dev/null \
  | xargs sed -i 's|packages/opencode|packages/flynncode|g'
```

Also `bun.lock` gains the new path through `bun install` later in this task.

- [ ] **Step 4: Regenerate lockfile and verify build**

```bash
bun install
cd packages/flynncode && bun typecheck
```

Note `packages/flynncode/package.json` may have a self-reference or scripts that assumed the old path — fix with the same `sed` if `bun typecheck` or `bun install` complains.

- [ ] **Step 5: Run the core test suite**

```bash
cd packages/flynncode && bun test --timeout 30000 --only-failures
```

Expected: PASS (pre-existing failures unrelated to rename should be noted, not fixed here).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(core): rename the core package dir and bin to flynncode"
```

---

### Task 4: CLI-facing strings

**Files:**
- Modify: `packages/flynncode/src/cli/cmd/run.ts:1052` (`$0`), `packages/flynncode/src/cli/cmd/pr.ts:83,104` (spawning `opencode`), `packages/flynncode/src/cli/cmd/uninstall.ts` (brew/choco/scoop package names, intro/success strings → handled with Task 8's branding for "OpenCode" prose), `packages/flynncode/src/cli/cmd/models.ts:57-58` (`.startsWith("opencode")` stays — that is the provider id, do NOT change), `install` script (`APP=opencode`, `INSTALL_DIR=$HOME/.opencode/bin`, GitHub release URLs → ServiceEndpoints in Task 9 changes those URLs), `packages/flynncode/src/installation/index.ts:126-129` (brew tap)

**Interfaces:**
- Consumes: nothing new
- Produces: the installed command responds to `flynncode`; update checks and process spawning use the new name.

- [ ] **Step 1: Flip binary invocations**

In `packages/flynncode/src/cli/cmd/pr.ts`, change both `"opencode"` array entries to `"flynncode"`. In `run.ts`, change `$0: "opencode"` → `$0: "flynncode"`. Search for other spawn/string invocations of the CLI within runtime code:

```bash
grep -rn '\["opencode"' packages/flynncode/src --include='*.ts'
grep -rn 'spawn.*"opencode"\|text(\["opencode"' packages/flynncode/src --include='*.ts'
```

Fix each runtime invocation found (leave provider-id checks in `cmd/models.ts` untouched).

- [ ] **Step 2: Update the install script identity**

`install`: `APP=opencode` → `APP=flynncode`; `INSTALL_DIR=$HOME/.opencode/bin` → `$HOME/.flynncode/bin`; usage text `./install --binary /path/to/opencode` → `/path/to/flynncode`. Leave the `https://github.com/anomalyco/opencode/releases/...` URLs for Task 9 (they become `ServiceEndpoints` references).

- [ ] **Step 3: Smoke check the CLI loads**

```bash
cd packages/flynncode && bun run src/index.ts --help | head -20
```

Expected: usage banner shows `flynncode` (or dev banner); no crash.

- [ ] **Step 4: Test cli package**

```bash
cd packages/flynncode && bun test src/cli --timeout 30000 --only-failures
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(opencode): flynncode CLI command name and install identity"
```

(Use `chore(flynncode):` going forward once the scope rename is complete; keep the body precise.)

---

### Task 5: Runtime dirs and project config

**Files:**
- Modify: `packages/core/src/global.ts:10` (`const app = "opencode"` → `"flynncode"`), `packages/core/src/database/database.ts:46-54` (db filenames `opencode.db` → `flynncode.db`, `opencode-${channel}.db` → `flynncode-${channel}.db`; `Flag.OPENCODE_DB` key handled in Task 7), `packages/flynncode/src/config/paths.ts` (project dirs `.opencode` → `.flynncode`, plus legacy discovery), `packages/flynncode/src/config/config.ts` (config file name `opencode.json/jsonc` → `flynncode.json/jsonc` with legacy fallback), plus any other runtime code constructing `.opencode` or `opencode.json` paths (grep list below)

**Interfaces:**
- Consumes: `Global.Path` (core), `ConfigPaths.files/directories` (config)
- Produces: runtime data in `~/.config/flynncode`, `~/.local/share/flynncode`, `~/.cache/flynncode`, `~/.state/flynncode` (xdg-basedir), project config `.flynncode/` + `flynncode.json(c)`; legacy `.opencode` and `opencode.json(c)` still discovered read-only.

- [ ] **Step 1: Flip the app dir name**

`packages/core/src/global.ts`: change line 10 `const app = "opencode"` → `const app = "flynncode"`. This single change re-points data/config/cache/state/tmp.

- [ ] **Step 2: Flip DB filenames**

`packages/core/src/database/database.ts` lines 53-54: `opencode.db` → `flynncode.db`, `opencode-${...}.db` → `flynncode-${...}.db`. (Legacy DBs arrive via Task 6 import renaming `opencode*.db` → `flynncode*.db`.)

- [ ] **Step 3: Project-local config discovery**

All runtime code discovering `.opencode` dirs or `opencode.json(c)` files:

```bash
grep -rln '"\.opencode"\|'"'"'\.opencode'"'"'\|opencode\.json\|opencode\.jsonc' packages/flynncode/src packages/core/src --include='*.ts'
```

For each hit in config/project/tooling discovery code: primary target becomes `.flynncode` / `flynncode.json` / `flynncode.jsonc`, with the legacy `.opencode` entry appended to the discovery list so existing project dirs keep working. Implementation pattern (mirroring `ConfigPaths.directories` in `packages/flynncode/src/config/paths.ts`):

```ts
// prefer the flynncode dir; legacy .opencode stays discoverable during the transition
...(yield* afs.up({ targets: [".flynncode"], start: directory, stop: worktree })),
...(yield* afs.up({ targets: [".opencode"], start: directory, stop: worktree })),
```

For config filenames use the same two-entry pattern as `ConfigPaths.fileInDirectory`:

```ts
export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
```

with `name` = `"flynncode"` at call sites, and legacy `"opencode"` files appended only where a single-file lookup reads project config (e.g. `projectFiles`).

Note the built-in skill prose in `packages/flynncode/src/skill/index.ts` mentions `.opencode/` — leave prose strings alone here; docs task touches them.

- [ ] **Step 4: Typecheck and tests**

```bash
cd packages/core && bun typecheck
cd ../flynncode && bun typecheck && bun test src/config --timeout 30000 --only-failures
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): flynncode runtime dirs with legacy opencode discovery"
```

---

### Task 6: One-time legacy import

**Files:**
- Create: `packages/core/src/global-import.ts`
- Modify: `packages/core/src/global.ts` (call the import after directory creation and before consumers read state)
- Test: `packages/core/test/global-import.test.ts`

**Interfaces:**
- Consumes: `Global.Path` values (`config`, `data`, `state`), `Flag` module
- Produces: `await importLegacyOpencode()` — resolved promise; copies legacy user data once, guarded by marker file `<data>/imported`. Called once from `packages/core/src/global.ts` top-level, before `await Promise.all([...mkdir])` consumers. Signature:

```ts
export type ImportResult = { imported: string[]; skipped: boolean }
export async function importLegacyOpencode(home: string, data: string, config: string): Promise<ImportResult>
```

- [ ] **Step 1: Write the failing test**

`packages/core/test/global-import.test.ts`:

```ts
import { test, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

test("copies legacy opencode data once and renames db files", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "flynncode-import-"))
  const legacyData = path.join(home, ".local/share/opencode")
  const legacyConfig = path.join(home, ".config/opencode")
  await fs.mkdir(legacyData, { recursive: true })
  await fs.mkdir(legacyConfig, { recursive: true })
  await fs.writeFile(path.join(legacyData, "auth.json"), '{"provider":{"x":{"key":"k"}}}')
  await fs.writeFile(path.join(legacyData, "opencode.db"), "db")
  await fs.writeFile(path.join(legacyData, "opencode-test.db"), "channeldb")
  await fs.writeFile(path.join(legacyConfig, "opencode.json"), '{"theme":"dark"}')

  const data = path.join(home, ".local/share/flynncode")
  const config = path.join(home, ".config/flynncode")
  const result = await importLegacyOpencode(home, data, config)

  expect(result.imported.length).toBeGreaterThan(0)
  expect(result.skipped).toBe(false)
  expect(await fs.readFile(path.join(data, "auth.json"), "utf8")).toContain("provider")
  expect(await fs.readFile(path.join(data, "flynncode.db"), "utf8")).toBe("db")
  expect(await fs.readFile(path.join(data, "flynncode-test.db"), "utf8")).toBe("channeldb")
  expect(await fs.readFile(path.join(config, "flynncode.json"), "utf8")).toBe('{"theme":"dark"}')
  expect(await fs.realpath(path.join(data, "imported"))).toBeTruthy()

  // second run is a no-op
  const again = await importLegacyOpencode(home, data, config)
  expect(again.skipped).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && bun test test/global-import.test.ts
```

Expected: FAIL (module `global-import` does not exist).

- [ ] **Step 3: Implement the module**

`packages/core/src/global-import.ts`:

```ts
export type ImportResult = { imported: string[]; skipped: boolean }

const LEGACY_DB_RE = /^opencode(-[a-zA-Z0-9._-]+)?\.db(.flock)?$/

export async function importLegacyOpencode(home: string, data: string, config: string): Promise<ImportResult> {
  const legacyConfig = path.join(home, ".config", "opencode")
  const legacyData = path.join(home, ".local", "share", "opencode")
  const marker = path.join(data, "imported")
  if (await exists(marker)) return { imported: [], skipped: true }

  const legacyPaths = [legacyConfig, legacyData].filter((p) => existsSync(p))
  if (legacyPaths.length === 0) {
    return { imported: [], skipped: true }
  }

  const imported: string[] = []
  await copyDir(legacyConfig, config, imported)
  await copyDir(legacyData, data, imported, { rename: renameDb })
  // import is best-effort: write the marker only when nothing failed
  await fs.writeFile(marker, new Date().toISOString())
  return { imported, skipped: false }
}
```

With helpers below the export (per repo module-shape rules; self-reexport at bottom):

```ts
function renameDb(name: string): string {
  return name.replace(LEGACY_DB_RE, (m) => m.replace(/^opencode/, "flynncode"))
}

async function copyDir(source: string, target: string, into: string[], opts?: { rename?: (n: string) => string }) {
  const entries = await fs.readdir(source, { withFileTypes: true })
  await fs.mkdir(target, { recursive: true })
  for (const entry of entries) {
    if (entry.name === "log" || entry.name === "tmp") continue
    const next = path.join(source, entry.name)
    const to = path.join(target, opts?.rename?.(entry.name) ?? entry.name)
    if (entry.isDirectory()) {
      await copyDir(next, to, into)
      into.push(to)
      continue
    }
    await fs.copyFile(next, to)
    into.push(to)
  }
}
```

Top of file imports: `import fs from "fs/promises"`, `import { existsSync } from "fs"`, `import path from "path"`. Bottom: `export * as GlobalImport from "./global-import"`.

Skip rules: never descend into `log/` or `tmp/`. If a copy throws, rethrow — `global.ts` catches and warns (Step 5), marker unwritten so the next run retries.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/core && bun test test/global-import.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire into global.ts**

In `packages/core/src/global.ts`, after the `await Promise.all([...mkdir])` block:

```ts
try {
  await importLegacyOpencode(Global.home, Path.data, Path.config)
} catch (error) {
  console.warn(`[flynncode] failed to import legacy opencode data: ${error}`)
}
```

Note: the import must run BEFORE anything reads `config`/`auth.json`/the db — this is the earliest consumer-visible point in `global.ts` since module top-level await is serialized before importers proceed.

- [ ] **Step 6: Typecheck and run related tests**

```bash
cd packages/core && bun typecheck && bun test test/global-import.test.ts test/database --timeout 30000 --only-failures 2>/dev/null || bun test --timeout 30000 --only-failures test
```

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): one-time import of legacy opencode data"
```

---

### Task 7: Env flag prefix alias

**Files:**
- Modify: `packages/core/src/flag/flag.ts`
- Test: `packages/core/test/flag-alias.test.ts` (if a flag test file already exists, extend it)

**Interfaces:**
- Consumes: nothing
- Produces: `Flag` lookup resolves `FLYNNCODE_<REST>` first, then `OPENCODE_<REST>`. Raw `process.env["OPENCODE_*"]` reads elsewhere in the codebase remain OPENCODE_-only (upstream compat, documented in the spec).

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"

test("flags prefer FLYNNCODE_ prefix with OPENCODE_ fallback", () => {
  process.env.FLYNNCODE_DISABLE_AUTOUPDATE = "1"
  expect(Flag.OPENCODE_DISABLE_AUTOUPDATE).toBe(true) // legacy key, now checked second
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  process.env.FLYNNCODE_DISABLE_AUTOUPDATE = ""
  expect(Flag.OPENCODE_DISABLE_AUTOUPDATE).toBe(true)
})
```

(Match the exact exported flag shape in `packages/core/src/flag/flag.ts`; the test above is written against the current `Flag` object keys, which keep their `OPENCODE_*` names — only resolution gains the alias. If the flags object is a static snapshot evaluated at import time, the implementation must read env at access time to make this test pass.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && bun test test/flag-alias.test.ts
```

Expected: FAIL (no alias resolution yet).

- [ ] **Step 3: Implement**

In `flag.ts` add a resolution helper and route every env read through it:

```ts
function env(rest: string): string | undefined {
  return process.env[`FLYNNCODE_${rest}`] ?? process.env[`OPENCODE_${rest}`]
}
```

Replace `process.env["OPENCODE_X"]` lookups within this file with `env("X")`. Keys keep their exported `OPENCODE_X` names (call sites unchanged). For `Config.boolean(...)`-style Effect Config reads inside the file, keep the `OPENCODE_` primary and add an `or` fallback chain to the `FLYNNCODE_` equivalent if the API supports it; if not, wrap the result: `env` for plain strings, else the Effect Config lookup.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/core && bun test test/flag-alias.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): FLYNNCODE_ env flag prefix with OPENCODE_ fallback"
```

---

### Task 8: Desktop branding

**Files:**
- Modify: `packages/desktop/electron-builder.config.ts` (productName entries lines ~89, ~130, ~139-140, ~150-154; `schemes: ["opencode"]` → `["flynncode"]`; appId `ai.opencode.desktop` → `ai.flynncode.desktop` wherever defined; `publish` owner/repo → env-overridable defaults `flynncode`/`flynncode`; rpm packageName → `flynncode`)
- Modify: `packages/desktop/electron-builder.config.test.ts:54` (expected `Exec=/opt/Flynncode/ai.flynncode.desktop %U` — verify the appId is derived; update test to the new expected string)
- Modify: window title strings and `productName` consumers under `packages/desktop/`, `packages/app/` (titles only)

**Interfaces:**
- Consumes: Task 4's install identity
- Produces: desktop app installs as "Flynncode", launches with appId `ai.flynncode.desktop`, handles `flynncode://` deep links.

- [ ] **Step 1: Update the electron-builder config**

```bash
grep -rn 'OpenCode\|opencode' packages/desktop/electron-builder.config.ts
```

Replacements: `productNames` and `productName` strings `"OpenCode*"` → `"Flynncode"*`; `schemes: ["opencode"]` → `["flynncode"]` (both protocol blocks, and their `name:` entries); appId and metainfo ids `ai.opencode.desktop` / `ai.opencode.desktop.*` → `ai.flynncode.desktop`; rpm/deb `packageName` → `flynncode`. For publish:

```ts
publish: { provider: "github", owner: process.env.FLYNNCODE_GH_OWNER ?? "flynncode", repo: process.env.FLYNNCODE_GH_REPO ?? "flynncode", channel: "latest" },
```

- [ ] **Step 2: Update the test and run it**

`packages/desktop/electron-builder.config.test.ts:54`: update expected `Exec=` line to match the new appId path. Then:

```bash
cd packages/desktop && bun test electron-builder --timeout 30000 --only-failures && bun typecheck
```

- [ ] **Step 3: Grep audit desktop + app UI**

```bash
grep -rn 'OpenCode\b' packages/desktop packages/app --include='*.ts' --include='*.tsx' --include='*.html' \
  --exclude-dir=node_modules | grep -v '@opencode-ai/client' | grep -vi 'OpenCodeProvider' | head -40
```

Swap user-facing strings (window titles, dock names, deep-link schemes) to "Flynncode"/`flynncode://`. Leave `@opencode-ai/client` imports and API-visible `OpenCode` class names alone.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop packages/app
git commit -m "feat(desktop): flynncode app identity"
```

---

### Task 9: ServiceEndpoints parameterization

**Files:**
- Create: `packages/core/src/service-endpoints.ts`
- Modify: call sites holding actionable URLs (grep below): `packages/flynncode/src/cli/cmd/account.ts:18`, `packages/flynncode/src/cli/cmd/github.handler.ts` (205, 325, 431, 698), `packages/flynncode/src/cli/cmd/providers.ts` (466-476), `packages/flynncode/src/installation/index.ts` (126-129 brew tap), the share-base selection in session sharing code (`grep -rn 'dev.opencode.ai' packages`), `models.opencode.ai` registry fetch (grep), `install` script URLs (leave literal — it's a shell script fetched from upstream installs; update later with Flynncode's own release infra), enterprise/console packages (`grep -rn 'opencode.ai' packages/enterprise packages/console`)
- Test: `packages/core/test/service-endpoints.test.ts`

**Interfaces:**
- Consumes: `Flag` module (for env overrides)
- Produces: `ServiceEndpoints` module — constants with env override via Flag alias:

```ts
// values are the current upstream endpoints
export const ServiceEndpoints = {
  web: "https://opencode.ai",
  api: "https://api.opencode.ai",
  console: process.env.FLYNNCODE_CONSOLE_URL ?? "https://opencode.ai/console",
  auth: "https://opencode.ai/auth",
  share: process.env.FLYNNCODE_SHARE_URL ?? "https://opencode.ai",
  shareDev: "https://dev.opencode.ai",
  models: "https://models.opencode.ai",
  trust: "https://trust.opencode.ai",
  enterprise: "https://enterprise.opencode.ai",
  brewTap: "anomalyco/tap/opencode",
  github: { owner: process.env.FLYNNCODE_GH_OWNER ?? "anomalyco", repo: process.env.FLYNNCODE_GH_REPO ?? "opencode" },
}
export * as ServiceEndpoints from "./service-endpoints"
```

Defaults preserve upstream values (spec: nothing breaks until Flynncode services exist). Prose/help text may stay literal or use templates; only *fetch/execute* call sites must import constants.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { ServiceEndpoints } from "@/service-endpoints"

test("endpoints default to upstream and honor env overrides", () => {
  expect(ServiceEndpoints.web).toBe("https://opencode.ai")
  expect(ServiceEndpoints.github.owner).toBe("anomalyco")
  process.env.FLYNNCODE_SHARE_URL = "https://share.flynncode.dev"
  expect(ServiceEndpoints.share).toBe("https://share.flynncode.dev")
})
```

(If the module reads env at import time, restructure the share access as a getter so the override test reflects it; getters over static strings are acceptable.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && bun test test/service-endpoints.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement the module** (code as in Interfaces block, using getters for env-overridable fields).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/core && bun test test/service-endpoints.test.ts
```

- [ ] **Step 5: Migrate call sites**

For each file in the Modify list, replace the URL literal with the constant (template strings for composed URLs). Example for `account.ts`:

```ts
import { ServiceEndpoints } from "@flynncode/core/service-endpoints"
export const defaultConsoleUrl = ServiceEndpoints.console
```

For `installation/index.ts` brew tap: replace `"anomalyco/tap/opencode"` with `ServiceEndpoints.brewTap`. For `github.handler.ts` api/app-installation URLs: `ServiceEndpoints.api` templates. Do NOT touch string literals inside comments, docs prose, or sdks' published docs.

- [ ] **Step 6: Typecheck + tests**

```bash
cd packages/core && bun typecheck && bun test test/service-endpoints.test.ts
cd ../flynncode && bun typecheck && bun test src/cli src/installation --timeout 30000 --only-failures 2>/dev/null || bun test --timeout 30000 --only-failures src
```

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/flynncode
git commit -m "feat(core): parameterize upstream service endpoints"
```

---

### Task 10: UI strings and docs

**Files:**
- Modify: user-facing "OpenCode" prose in `packages/app`, `packages/session-ui`, `packages/tui`, `packages/web`, `packages/docs` (brand-level only); root `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`; `packages/flynncode/AGENTS.md` (dev server section); repo-local `.opencode/` → `.flynncode/`; `packages/flynncode/src/skill/index.ts:34` and other help/skill prose that names this binary's own config ("opencode.json" → "flynncode.json" etc.)
- Deliberately NOT: the 21 translated `README.*.md` files, the `sdks/` docs prose, the `docs/` and `packages/docs/` long-form upstream prose.

**Interfaces:**
- Consumes: everything above
- Produces: documentation consistent with the binary.

- [ ] **Step 1: Rename the repo-local config dir**

```bash
git mv .opencode .flynncode
```

(The legacy `.opencode` discovery from Task 5 keeps this working for upstream tooling that may still read the old dir; flynncode prefers `.flynncode`.)

- [ ] **Step 2: Brand-swap user-facing prose**

```bash
grep -rln '\bOpenCode\b' packages/app packages/session-ui packages/tui packages/web docs specs \
  --exclude-dir=node_modules \
  | xargs sed -i 's/\bOpenCode\b/Flynncode/g'
```

Careful: skip `packages/app` files importing `@opencode-ai/client` where the text `OpenCode` is the class name from the vendored SDK — after the sed, `git diff` and revert any line that changed an SDK-identifier (`OpenCode` class) rather than prose:

```bash
git diff | grep -E '^\+.*(from "@opencode-ai/client|new OpenCode\b)' 
# inspect each hit; `git checkout -- <file>` the false positives and fix manually
```

- [ ] **Step 3: Update root docs and AGENTS.md**

Root `AGENTS.md`: the V2 Session Core and repo-conventions text keep their meaning; update package paths (`packages/opencode/src/plugin/ollama-model-router` → `packages/flynncode/...`). `CONTRIBUTING.md`/`SECURITY.md`/`README.md`: brand-level swaps (command, scope, product name), plus one sentence in README: flynncode imports existing opencode data once on first run. `packages/flynncode/AGENTS.md`: dev-server section (`bun dev`, tmux session `opencode-dev` → `flynncode-dev`, `packages/opencode` path references).

- [ ] **Step 4: This-binary prose in runtime code**

```bash
grep -rln 'opencode\.json\|\.opencode/' packages/flynncode/src/skill packages/flynncode/src/cli/cmd --include='*.ts' \
  | xargs sed -i 's/opencode\.json/flynncode.json/g; s/\.opencode\//.flynncode\//g; s/~\/\.config\/opencode/~\/.config\/flynncode/g'
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: flynncode branding across AGENTS, README, and UI prose"
```

---

### Task 11: Final audit and smoke test

**Files:**
- Modify: nothing expected (fix-ups if the audit finds real residue)
- Run: `script/rename-audit.sh final`

**Interfaces:**
- Consumes: audit script from Task 1
- Produces: audit report + smoke evidence in commit message.

- [ ] **Step 1: Full typecheck across packages**

```bash
for p in core flynncode app desktop session-ui tui server protocol schema sdk client sdk-next; do
  (cd packages/$p && bun typecheck) || echo "TYPECHECK FAILED: $p"
done
```

Expected: no failures.

- [ ] **Step 2: Audit residue**

```bash
bash script/rename-audit.sh final
grep -rl '@opencode-ai/' packages sdks github script .github --exclude-dir=node_modules --exclude-dir=.turbo
```

Expected remaining categories (all allowed): `@opencode-ai/client` vendored dep + its 45 importer files under `packages/app`, third-party auth package names, provider ids (`"opencode"` provider, `opencode/*` model ids), `OPENCODE_*` raw env reads and flag keys outside `flag.ts`, `OPENCODE_TEST_HOME`, legacy import/discovery code, upstream service URL literals inside prose and the `install` shell script.

- [ ] **Step 3: Import smoke test in a temp HOME**

```bash
export SMOKE_HOME=/tmp/opencode/flynncode-smoke
rm -rf "$SMOKE_HOME" && mkdir -p "$SMOKE_HOME/.config/opencode" "$SMOKE_HOME/.local/share/opencode"
echo '{"autoupdate":false}' > "$SMOKE_HOME/.config/opencode/opencode.json"
echo '{"provider":{"mock":{"key":"mk"}}}' > "$SMOKE_HOME/.local/share/opencode/auth.json"
HOME=$SMOKE_HOME bun run packages/flynncode/src/index.ts --help | head -5
ls "$SMOKE_HOME/.local/share/flynncode" && ls "$SMOKE_HOME/.config/flynncode"
```

Expected: `imported` marker, `auth.json` + `flynncode.json` copied into flynncode dirs; legacy dirs untouched.

- [ ] **Step 4: TUI boot via tmux**

```bash
tmux new-session -d -s flynncode-dev 'HOME=/tmp/opencode/flynncode-smoke bun run dev'
sleep 8
tmux capture-pane -pt flynncode-dev | head -30
tmux kill-session -t flynncode-dev
```

(Run from `packages/flynncode`.) Expected: TUI renders without crash.

- [ ] **Step 5: Commit leftovers and final run of core tests**

```bash
git add -A
git commit -m "chore(core): final rename audit fixes"
```

---

## Self-Review Results

- **Spec coverage:** Passes 1-5 of the spec map to Tasks 2-3 (workspace), 5-7 (runtime identity, import, flags), 8 (branding), 9 (service URLs), 10 (docs). Verification section maps to Tasks 1, 11. Allowed-residue list matches spec's "deliberately untouched".
- **Placeholders:** Task 9 endpoint list is concrete values; Tasks 5/8/9 grep commands give exact locations where recon confirmed (line numbers included). Two spots intentionally say "grep to enumerate" because full file lists exceed the plan's snapshot accuracy — the grep pattern + expected category is the spec, not a placeholder.
- **Type consistency:** `importLegacyOpencode(home, data, config)` and `ImportResult { imported, skipped }` used in Tasks 5-6 consistently; `ServiceEndpoints` keys referenced by call-site examples match the module definition.

One nuance to verify during execution (flagged in Task 5/6): session DB copies and `Global home` are used at module-evaluation time across the codebase; `flag-alias` test shape depends on whether `Flag` is an eager object.