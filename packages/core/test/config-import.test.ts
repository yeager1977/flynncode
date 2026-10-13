import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { importConfig } from "../src/config-import"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const marker = ".opencode-imported"
const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )

test("absent source remains eligible for a later import", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  expect(await importConfig(source, target)).toBe(target)
  expect(await exists(path.join(target, marker))).toBe(false)
  await Bun.write(path.join(source, "opencode.json"), "{}")
  await importConfig(source, target)
  expect(await Bun.file(path.join(target, "opencode.json")).text()).toBe("{}")
})

test("copies the full config tree and permissions without modifying its source", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  const files = {
    "opencode.jsonc": '{ "instructions": ["./instructions.md"] }',
    "instructions.md": "fixture instruction",
    "skills/example/SKILL.md": "fixture skill",
    "commands/example.md": "fixture command",
    "hooks/hooks.json": "{}",
    "plugins/example.js": "export const fixture = true",
    "package.json": '{ "dependencies": { "fixture": "file:./vendor/fixture" } }',
    "vendor/fixture/package.json": '{ "name": "fixture" }',
    "node_modules/fixture/index.js": "export const value = 42",
    "tui.json": "{}",
  }
  await Promise.all(Object.entries(files).map(([file, content]) => Bun.write(path.join(source, file), content)))
  await fs.chmod(path.join(source, "opencode.jsonc"), 0o600)
  await fs.chmod(path.join(source, "skills"), 0o700)
  expect(await importConfig(source, target)).toBe(target)
  for (const [file, content] of Object.entries(files)) {
    expect(await Bun.file(path.join(target, file)).text()).toBe(content)
    expect(await Bun.file(path.join(source, file)).text()).toBe(content)
  }
  expect((await fs.stat(path.join(target, "opencode.jsonc"))).mode & 0o777).toBe(0o600)
  expect((await fs.stat(path.join(target, "skills"))).mode & 0o777).toBe(0o700)
  expect(await exists(path.join(source, marker))).toBe(false)
  expect(await exists(path.join(target, marker))).toBe(true)
})

test("preserves destination edits and completes only once", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "opencode.json"), "source")
  await Bun.write(path.join(source, "instructions.md"), "imported")
  await Bun.write(path.join(target, "opencode.json"), "user edit")
  await importConfig(source, target)
  expect(await Bun.file(path.join(target, "instructions.md")).text()).toBe("imported")
  expect(await exists(path.join(target, marker))).toBe(true)
  expect(await Bun.file(path.join(target, "opencode.json")).text()).toBe("user edit")
  await Bun.write(path.join(source, "later.md"), "late source change")
  await importConfig(source, target)
  expect(await exists(path.join(target, "later.md"))).toBe(false)
})

test("partial publication uses an independent snapshot without a marker and retries without overwriting", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "a.json"), "copied")
  await Bun.write(path.join(source, "z-skills", "SKILL.md"), "skill")
  await Bun.write(path.join(target, "z-skills"), "blocking user file")
  const fallback = await importConfig(source, target)
  expect(fallback).not.toBe(source)
  expect(fallback).not.toBe(target)
  if (!fallback) throw new Error("Expected an independent fallback snapshot")
  expect(await Bun.file(path.join(fallback, "a.json")).text()).toBe("copied")
  expect(await exists(path.join(target, marker))).toBe(false)
  expect(await Bun.file(path.join(target, "a.json")).text()).toBe("copied")
  await Bun.write(path.join(target, "a.json"), "edited after failure")
  await fs.rm(path.join(target, "z-skills"))
  expect(await importConfig(source, target)).toBe(target)
  expect(await Bun.file(path.join(target, "a.json")).text()).toBe("edited after failure")
  expect(await Bun.file(path.join(target, "z-skills", "SKILL.md")).text()).toBe("skill")
  expect(await exists(path.join(target, marker))).toBe(true)
})

test("concurrent imports publish complete files", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  const content = "fixture".repeat(100_000)
  await Bun.write(path.join(source, "opencode.json"), content)
  expect(await Promise.all(Array.from({ length: 4 }, () => importConfig(source, target)))).toEqual([
    target,
    target,
    target,
    target,
  ])
  expect(await Bun.file(path.join(target, "opencode.json")).text()).toBe(content)
  expect(await Bun.file(path.join(source, "opencode.json")).text()).toBe(content)
})

test("external linked plugin packages become independent copies with working relative imports", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(
    path.join(tmp.path, "vendor/fixture/package.json"),
    '{"name":"fixture","type":"module","exports":"./index.js"}',
  )
  await Bun.write(path.join(tmp.path, "vendor/fixture/index.js"), "export const value = 42")
  await Bun.write(path.join(source, "plugins/example.js"), "export { value } from 'fixture'")
  await fs.mkdir(path.join(source, "node_modules"))
  await fs.symlink("../../vendor/fixture", path.join(source, "node_modules/fixture"), "dir")
  expect(await importConfig(source, target)).toBe(target)
  expect((await fs.lstat(path.join(target, "node_modules/fixture"))).isSymbolicLink()).toBe(false)
  expect((await import(path.join(target, "plugins/example.js"))).value).toBe(42)
  await Bun.write(path.join(target, "node_modules/fixture/index.js"), "destination edit")
  expect(await Bun.file(path.join(tmp.path, "vendor/fixture/index.js")).text()).toBe("export const value = 42")
})

test("destination directory symlinks cannot redirect import writes into the source", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "skills/example.md"), "fixture")
  await fs.mkdir(target)
  await fs.symlink(path.join(source, "skills"), path.join(target, "skills"), "dir")
  expect(await importConfig(source, target)).not.toBe(source)
  expect(await exists(path.join(target, marker))).toBe(false)
  expect(await Bun.file(path.join(source, "skills/example.md")).text()).toBe("fixture")
})

test("a failed full snapshot never returns the original source or marks completion", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "opencode.json"), "fixture")
  await fs.symlink("missing-file", path.join(source, "broken"))
  expect(await importConfig(source, target)).toBeUndefined()
  expect(await exists(path.join(target, marker))).toBe(false)
  expect(await Bun.file(path.join(source, "opencode.json")).text()).toBe("fixture")
})

test("a legacy path that is a file cannot be returned as a usable config directory", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(source, "fixture")
  expect(await importConfig(source, target)).toBeUndefined()
  expect(await Bun.file(source).text()).toBe("fixture")
  expect(await exists(path.join(target, marker))).toBe(false)
})

test("Node can execute imported node_modules bin symlinks with package-relative requires", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "node_modules/foo/bin/cli.cjs"), "console.log(require('../lib/main.cjs'))")
  await Bun.write(path.join(source, "node_modules/foo/lib/main.cjs"), "module.exports = 'fixture executable'")
  await fs.mkdir(path.join(source, "node_modules/.bin"))
  await fs.symlink("../foo/bin/cli.cjs", path.join(source, "node_modules/.bin/foo"))
  const run = async (dir: string) => {
    const proc = Bun.spawn(["node", path.join(dir, "node_modules/.bin/foo")], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe("fixture executable")
  }
  await run(source)
  expect(await importConfig(source, target)).toBe(target)
  await run(target)
  expect((await fs.lstat(path.join(target, "node_modules/.bin/foo"))).isSymbolicLink()).toBe(true)
})

test("absolute internal symlinks are remapped to the destination rather than the original", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "notes.md"), "original")
  await fs.symlink(path.join(source, "notes.md"), path.join(source, "alias.md"))
  expect(await importConfig(source, target)).toBe(target)
  expect((await fs.lstat(path.join(target, "alias.md"))).isSymbolicLink()).toBe(true)
  expect(await fs.realpath(path.join(target, "alias.md"))).toBe(path.join(target, "notes.md"))
  await Bun.write(path.join(target, "alias.md"), "destination edit")
  expect(await Bun.file(path.join(target, "notes.md")).text()).toBe("destination edit")
  expect(await Bun.file(path.join(source, "notes.md")).text()).toBe("original")
})

test("internal absolute links also rebase when the legacy config root is itself a symlink", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const actual = path.join(tmp.path, "legacy")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(actual, "notes.md"), "original")
  await fs.symlink(actual, source, "dir")
  await fs.symlink(path.join(source, "notes.md"), path.join(source, "alias.md"))
  expect(await importConfig(source, target)).toBe(target)
  expect((await fs.lstat(path.join(target, "alias.md"))).isSymbolicLink()).toBe(true)
  expect(await fs.realpath(path.join(target, "alias.md"))).toBe(path.join(target, "notes.md"))
})

test("source directory loops fail without a completed marker or recursive self-copy", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "opencode.json"), "fixture")
  await fs.symlink(source, path.join(source, "loop"), "dir")
  expect(await importConfig(source, target)).toBeUndefined()
  expect(await exists(path.join(target, marker))).toBe(false)
  expect((await fs.readdir(source)).sort()).toEqual(["loop", "opencode.json"])
})

test("a destination inside the source is rejected before creating import bookkeeping", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  await Bun.write(path.join(source, "opencode.json"), "fixture")
  expect(await importConfig(source, path.join(source, "flynncode"))).toBeUndefined()
  expect(await fs.readdir(source)).toEqual(["opencode.json"])
})

const posix = process.platform === "win32" ? test.skip : test

posix("readable nonwritable source directories publish children before restoring permissions", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "skills/example.md"), "fixture skill")
  await fs.chmod(path.join(source, "skills"), 0o500)
  await fs.chmod(source, 0o500)
  try {
    expect(await importConfig(source, target)).toBe(target)
    expect(await Bun.file(path.join(target, "skills/example.md")).text()).toBe("fixture skill")
    expect((await fs.stat(path.join(target, "skills"))).mode & 0o777).toBe(0o500)
    expect((await fs.stat(target)).mode & 0o777).toBe(0o500)
    expect(await exists(path.join(target, marker))).toBe(true)
    expect(await importConfig(source, target)).toBe(target)
  } finally {
    await fs.chmod(source, 0o700)
    await fs.chmod(path.join(source, "skills"), 0o700)
    if (await exists(target)) await fs.chmod(target, 0o700)
    if (await exists(path.join(target, "skills"))) await fs.chmod(path.join(target, "skills"), 0o700)
  }
})

posix("failed imports resume directory permissions and preserve user directory modes", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "locked/a.md"), "first")
  await Bun.write(path.join(source, "user/example.md"), "user directory child")
  await Bun.write(path.join(source, "z-conflict/example.md"), "last")
  await fs.chmod(path.join(source, "locked"), 0o500)
  await fs.chmod(path.join(source, "user"), 0o500)
  await Bun.write(path.join(target, "z-conflict"), "user file")
  await fs.mkdir(path.join(target, "user"), { mode: 0o700 })
  const fallback = await importConfig(source, target)
  try {
    expect(fallback).toBeDefined()
    expect(fallback).not.toBe(target)
    expect(await Bun.file(path.join(target, "locked/a.md")).text()).toBe("first")
    expect((await fs.stat(path.join(target, "locked"))).mode & 0o777).toBe(0o700)
    await fs.chmod(path.join(source, "locked"), 0o700)
    await Bun.write(path.join(source, "locked/b.md"), "added before retry")
    await fs.chmod(path.join(source, "locked"), 0o500)
    await fs.rm(path.join(target, "z-conflict"))
    expect(await importConfig(source, target)).toBe(target)
    expect(await Bun.file(path.join(target, "locked/b.md")).text()).toBe("added before retry")
    expect((await fs.stat(path.join(target, "locked"))).mode & 0o777).toBe(0o500)
    expect((await fs.stat(path.join(target, "user"))).mode & 0o777).toBe(0o700)
  } finally {
    await fs.chmod(path.join(source, "locked"), 0o700)
    await fs.chmod(path.join(source, "user"), 0o700)
    if (await exists(path.join(target, "locked"))) await fs.chmod(path.join(target, "locked"), 0o700)
    if (fallback && fallback !== source) {
      await fs.chmod(path.join(fallback, "locked"), 0o700)
      await fs.chmod(path.join(fallback, "user"), 0o700)
    }
  }
})

posix("a user's directory permission edit between retries is preserved", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "locked/example.md"), "fixture")
  await Bun.write(path.join(source, "z-conflict/example.md"), "fixture")
  await fs.chmod(path.join(source, "locked"), 0o500)
  await Bun.write(path.join(target, "z-conflict"), "blocking file")
  const fallback = await importConfig(source, target)
  try {
    expect(fallback).not.toBe(target)
    await fs.chmod(path.join(target, "locked"), 0o750)
    await fs.rm(path.join(target, "z-conflict"))
    expect(await importConfig(source, target)).toBe(target)
    expect((await fs.stat(path.join(target, "locked"))).mode & 0o777).toBe(0o750)
  } finally {
    await fs.chmod(path.join(source, "locked"), 0o700)
    await fs.chmod(path.join(target, "locked"), 0o700)
    if (fallback && fallback !== source) await fs.chmod(path.join(fallback, "locked"), 0o700)
  }
})

posix("interrupted finalization recovers root mode and journal before accepting completion", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  await Bun.write(path.join(source, "opencode.json"), "{}")
  await fs.mkdir(target, { recursive: true })
  await fs.chmod(target, 0o700)
  const created = await fs.lstat(target)
  const locks = path.join(path.dirname(target), ".flynncode-import-locks")
  await fs.mkdir(locks, { recursive: true })
  const journal = path.join(locks, `${Hash.fast(target)}.directories.jsonl`)
  await Bun.write(
    journal,
    `${JSON.stringify({ file: target, mode: 0o500, dev: created.dev, ino: created.ino })}\n`,
  )
  await Bun.write(path.join(target, marker), "")
  try {
    expect(await importConfig(source, target)).toBe(target)
    expect((await fs.stat(target)).mode & 0o777).toBe(0o500)
    expect(await exists(journal)).toBe(false)
    expect(await exists(path.join(target, marker))).toBe(true)
    expect(await Bun.file(path.join(source, "opencode.json")).text()).toBe("{}")
  } finally {
    await fs.chmod(target, 0o700)
  }
})
