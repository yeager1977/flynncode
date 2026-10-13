import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "./fixture/tmpdir"

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )

async function startup(root: string, overrides: Record<string, string> = {}, runtime = process.execPath) {
  const entry = path.join(import.meta.dir, "../src/global.ts")
  const bundle = runtime === process.execPath ? entry : path.join(root, "global.mjs")
  if (runtime !== process.execPath) {
    const built = await Bun.build({ entrypoints: [entry], target: "node", format: "esm" })
    expect(built.success).toBe(true)
    await Bun.write(bundle, built.outputs[0])
  }
  const proc = Bun.spawn(
    [
      runtime,
      "--input-type=module",
      "-e",
      `
    const { Global } = await import(${JSON.stringify(pathToFileURL(bundle).href)})
    console.log(JSON.stringify({ path: Global.Path, config: Global.make().config }))
  `,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code, stderr).toBe(0)
  const result = JSON.parse(stdout) as {
    path: { config: string; data: string; cache: string; state: string }
    config: string
  }
  return { ...result, warning: stderr }
}

test.each([process.execPath, "node"])(
  "startup imports from XDG config before consumers under %s",
  async (runtime) => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "config/opencode/opencode.json"), '{"username":"fixture"}')
    const result = await startup(tmp.path, {}, runtime)
    expect(result.path.config).toBe(path.join(tmp.path, "config/flynncode"))
    expect(await Bun.file(path.join(result.path.config, "opencode.json")).text()).toBe('{"username":"fixture"}')
    expect(result.path.data).toBe(path.join(tmp.path, "data/opencode"))
    expect(result.path.cache).toBe(path.join(tmp.path, "cache/opencode"))
    expect(result.path.state).toBe(path.join(tmp.path, "state/opencode"))
  },
  30_000,
)

test.each(["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_TUI_CONFIG"])(
  "%s suppresses the automatic import",
  async (key) => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "config/opencode/opencode.json"), "{}")
    const result = await startup(tmp.path, { [key]: key.endsWith("CONTENT") ? "{}" : path.join(tmp.path, "custom") })
    expect(await exists(path.join(tmp.path, "config/flynncode/.opencode-imported"))).toBe(false)
    expect(await exists(path.join(tmp.path, "config/flynncode/opencode.json"))).toBe(false)
    if (key === "OPENCODE_CONFIG_DIR") expect(result.config).toBe(path.join(tmp.path, "custom"))
  },
)

test("startup falls back to an independent config snapshot on import failure", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "config/opencode/skills/example.md"), "fixture")
  await Bun.write(path.join(tmp.path, "config/flynncode/skills"), "blocking file")
  const fallback = (await startup(tmp.path)).path.config
  expect(fallback).not.toBe(path.join(tmp.path, "config/opencode"))
  expect(fallback).not.toBe(path.join(tmp.path, "config/flynncode"))
  expect(await Bun.file(path.join(fallback, "skills/example.md")).text()).toBe("fixture")
})

test("concurrent processes complete the same startup import", async () => {
  await using tmp = await tmpdir()
  const content = "fixture".repeat(100_000)
  await Bun.write(path.join(tmp.path, "config/opencode/opencode.json"), content)
  const results = await Promise.all([startup(tmp.path), startup(tmp.path), startup(tmp.path)])
  expect(results.every((result) => result.path.config === path.join(tmp.path, "config/flynncode"))).toBe(true)
  expect(await Bun.file(path.join(tmp.path, "config/flynncode/opencode.json")).text()).toBe(content)
}, 30_000)

test("a test home without an explicit XDG config root does not import", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, ".config/opencode/opencode.json"), "{}")
  await startup(tmp.path, { OPENCODE_TEST_HOME: tmp.path, XDG_CONFIG_HOME: "" })
  expect(await exists(path.join(tmp.path, ".config/flynncode/.opencode-imported"))).toBe(false)
  expect(await exists(path.join(tmp.path, ".config/flynncode/opencode.json"))).toBe(false)
})

test("unavailable legacy config uses a private empty directory and a value-free warning", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "config/opencode")
  await Bun.write(path.join(source, "opencode.json"), "fixture")
  await fs.symlink("missing-file", path.join(source, "broken"))
  const result = await startup(tmp.path)
  expect(result.path.config).not.toBe(source)
  expect(result.path.config).not.toBe(path.join(tmp.path, "config/flynncode"))
  expect(await fs.readdir(result.path.config)).toEqual([])
  expect(result.warning.trim()).toBe(
    "Flynncode config import failed; legacy config is unavailable. Will retry on next startup.",
  )
  expect(await Bun.file(path.join(source, "opencode.json")).text()).toBe("fixture")
  expect(await exists(path.join(tmp.path, "config/flynncode/.opencode-imported"))).toBe(false)
})
