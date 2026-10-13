import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { importConfig } from "@flynncode/core/config-import"
import { Global } from "@flynncode/core/global"
import { Npm } from "@flynncode/core/npm"
import { migrateTuiConfig } from "@/config/tui-migrate"
import { tmpdir } from "../fixture/fixture"

async function snapshot(dir: string) {
  return Promise.all(
    (await fs.readdir(dir, { recursive: true })).sort().map(async (file) => ({
      file,
      content: (await fs.lstat(path.join(dir, file))).isFile()
        ? await fs.readFile(path.join(dir, file), "utf8")
        : undefined,
    })),
  )
}

test("failed import isolates real TUI migration and dependency writes from the original config", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "opencode")
  const target = path.join(tmp.path, "flynncode")
  const cwd = path.join(tmp.path, "work")
  await fs.mkdir(cwd)
  await Bun.write(path.join(source, "opencode.json"), '{"theme":"fixture-theme","tui":{"scroll_speed":3}}')
  await Bun.write(path.join(source, "package.json"), '{"name":"config-fixture","private":true}')
  await Bun.write(path.join(source, "vendor/fixture/package.json"), '{"name":"fixture","version":"1.0.0"}')
  await Bun.write(path.join(source, "z-skills/example.md"), "fixture skill")
  await Bun.write(path.join(target, "z-skills"), "destination edit")
  const before = await snapshot(source)
  const fallback = await importConfig(source, target)
  if (!fallback) throw new Error("Expected a complete fallback snapshot")
  const previous = Global.Path.config
  try {
    Global.Path.config = fallback
    await migrateTuiConfig({ directories: [fallback], cwd })
    await Npm.install(fallback, { add: [{ name: "fixture", version: "file:./vendor/fixture" }] })
    expect(await snapshot(source)).toEqual(before)
    expect(fallback).not.toBe(source)
    expect(fallback).not.toBe(target)
    expect((await fs.stat(path.dirname(fallback))).mode & 0o777).toBe(0o700)
    expect(await Bun.file(path.join(fallback, "tui.json")).json()).toMatchObject({
      theme: "fixture-theme",
      scroll_speed: 3,
    })
    expect(await Bun.file(path.join(fallback, "opencode.json.tui-migration.bak")).exists()).toBe(true)
    expect((await Bun.file(path.join(fallback, "package.json")).json()).dependencies.fixture).toBe(
      "file:vendor/fixture",
    )
    expect(await Bun.file(path.join(target, ".opencode-imported")).exists()).toBe(false)
    expect(await Bun.file(path.join(target, "z-skills")).text()).toBe("destination edit")
    expect(await Bun.file(path.join(target, "opencode.json")).text()).toBe(
      '{"theme":"fixture-theme","tui":{"scroll_speed":3}}',
    )
  } finally {
    Global.Path.config = previous
  }
}, 30_000)
