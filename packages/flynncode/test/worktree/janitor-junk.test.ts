import { expect, test } from "bun:test"
import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises"
import path from "path"
import { JanitorJunk } from "../../src/worktree/janitor/junk"
import { tmpdir } from "../fixture/fixture"

const put = async (root: string, file: string, content = "x".repeat(100)) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

const exists = (target: string) =>
  lstat(target)
    .then(() => true)
    .catch(() => false)

test("removeJunk deletes junk at any depth and keeps everything else", async () => {
  await using tmp = await tmpdir()
  await put(tmp.path, "pytest-of-user/x/file")
  await put(tmp.path, "pkg/__pycache__/a.pyc")
  await put(tmp.path, ".pytest_cache/v/cache")
  await put(tmp.path, "src/main.py")
  await put(tmp.path, "node_modules/pkg/__pycache__/b.pyc")
  await put(tmp.path, "node_modules/pkg/index.js")
  await put(tmp.path, ".git/coverage/keep")

  const result = await JanitorJunk.removeJunk(tmp.path)

  expect(result.removed.sort()).toEqual(
    [
      path.join(tmp.path, "pytest-of-user"),
      path.join(tmp.path, "pkg/__pycache__"),
      path.join(tmp.path, ".pytest_cache"),
    ].sort(),
  )
  expect(result.bytes).toBe(300)
  expect(await exists(path.join(tmp.path, "src/main.py"))).toBe(true)
  expect(await exists(path.join(tmp.path, "node_modules/pkg/__pycache__/b.pyc"))).toBe(true)
  expect(await exists(path.join(tmp.path, ".git/coverage/keep"))).toBe(true)
  expect(await exists(path.join(tmp.path, "pytest-of-user"))).toBe(false)
})

test("removeJunk removes directories it leaves empty but never the root", async () => {
  await using tmp = await tmpdir()
  await put(tmp.path, "a/b/__pycache__/x.pyc")
  await put(tmp.path, "keep/__pycache__/y.pyc")
  await put(tmp.path, "keep/real.txt")
  await mkdir(path.join(tmp.path, "already-empty"))
  await put(tmp.path, "coverage/index.html")

  await JanitorJunk.removeJunk(tmp.path)

  expect(await exists(path.join(tmp.path, "a"))).toBe(false)
  expect(await exists(path.join(tmp.path, "keep/real.txt"))).toBe(true)
  expect(await exists(path.join(tmp.path, "already-empty"))).toBe(true)
  expect(await exists(tmp.path)).toBe(true)
  expect(await readdir(tmp.path)).toEqual(expect.arrayContaining(["keep", "already-empty"]))
})

test("removeJunk removes a junk-named symlink as a link only", async () => {
  await using outside = await tmpdir()
  await using tmp = await tmpdir()
  await put(outside.path, "precious.txt", "z".repeat(5000))
  await mkdir(path.join(tmp.path, "pkg"))
  await symlink(outside.path, path.join(tmp.path, "pkg/__pycache__"))
  await put(tmp.path, "pkg/code.py")

  const result = await JanitorJunk.removeJunk(tmp.path)

  expect(result.removed).toEqual([path.join(tmp.path, "pkg/__pycache__")])
  expect(result.bytes).toBeLessThan(100)
  expect(await exists(path.join(tmp.path, "pkg/__pycache__"))).toBe(false)
  expect(await exists(path.join(outside.path, "precious.txt"))).toBe(true)
})

test("size sums file bytes without following symlinks and honors the budget", async () => {
  await using outside = await tmpdir()
  await using tmp = await tmpdir()
  await put(outside.path, "big.bin", "y".repeat(5000))
  await put(tmp.path, "a/one", "x".repeat(10))
  await put(tmp.path, "a/b/two", "x".repeat(20))
  await put(tmp.path, "node_modules/three", "x".repeat(30))
  await symlink(outside.path, path.join(tmp.path, "link"))
  const link = (await lstat(path.join(tmp.path, "link"))).size

  expect(await JanitorJunk.size(tmp.path)).toEqual({ bytes: 60 + link, capped: false })
  expect((await JanitorJunk.size(tmp.path, { budgetMs: 0 })).capped).toBe(true)
})
