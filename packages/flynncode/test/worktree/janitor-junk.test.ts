import { expect, test } from "bun:test"
import { chmod, lstat, mkdir, readdir, symlink, utimes, writeFile } from "node:fs/promises"
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

  const result = await JanitorJunk.removeJunk(tmp.path, await JanitorJunk.findJunk(tmp.path))

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

  await JanitorJunk.removeJunk(tmp.path, await JanitorJunk.findJunk(tmp.path))

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

  const result = await JanitorJunk.removeJunk(tmp.path, await JanitorJunk.findJunk(tmp.path))

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

  expect(await JanitorJunk.size(tmp.path)).toMatchObject({ bytes: 60 + link, capped: false })
  expect((await JanitorJunk.size(tmp.path, { budgetMs: 0 })).capped).toBe(true)
})

test("removeJunk deletes only the approved paths, never junk found later", async () => {
  await using outside = await tmpdir()
  await using tmp = await tmpdir()
  await put(tmp.path, "coverage/report.txt")
  await put(tmp.path, "pkg/__pycache__/a.pyc")
  await put(tmp.path, "src/main.py")
  await put(outside.path, "__pycache__/b.pyc")
  const approved = (await JanitorJunk.findJunk(tmp.path)).filter((target) => !target.endsWith("coverage"))
  await put(tmp.path, "later/__pycache__/c.pyc")

  const result = await JanitorJunk.removeJunk(tmp.path, [
    ...approved,
    path.join(tmp.path, "src"),
    path.join(outside.path, "__pycache__"),
  ])

  expect(result.removed).toEqual([path.join(tmp.path, "pkg/__pycache__")])
  expect(result.bytes).toBe(100)
  expect(await exists(path.join(tmp.path, "coverage/report.txt"))).toBe(true)
  expect(await exists(path.join(tmp.path, "later/__pycache__/c.pyc"))).toBe(true)
  expect(await exists(path.join(tmp.path, "src/main.py"))).toBe(true)
  expect(await exists(path.join(outside.path, "__pycache__/b.pyc"))).toBe(true)
  expect(await exists(path.join(tmp.path, "pkg/__pycache__"))).toBe(false)
})

test("removeJunk does nothing when the root is a symlink", async () => {
  await using outside = await tmpdir()
  await using tmp = await tmpdir()
  await put(outside.path, "__pycache__/a.pyc")
  await symlink(outside.path, path.join(tmp.path, "link"))

  expect(
    await JanitorJunk.removeJunk(path.join(tmp.path, "link"), [path.join(tmp.path, "link", "__pycache__")]),
  ).toEqual({ removed: [], bytes: 0, items: [] })
  expect(await exists(path.join(outside.path, "__pycache__/a.pyc"))).toBe(true)
})

test("removeJunk skips a target it cannot delete and keeps going", async () => {
  await using tmp = await tmpdir()
  await put(tmp.path, "a/__pycache__/locked/x.pyc")
  await put(tmp.path, "b/__pycache__/y.pyc")
  const locked = path.join(tmp.path, "a/__pycache__/locked")
  await chmod(locked, 0o555)
  try {
    const result = await JanitorJunk.removeJunk(tmp.path, await JanitorJunk.findJunk(tmp.path))
    expect(result.removed).toEqual([path.join(tmp.path, "b/__pycache__")])
    expect(result.bytes).toBe(100)
    expect(result.items).toEqual([{ path: path.join(tmp.path, "b/__pycache__"), bytes: 100 }])
    expect(await exists(path.join(locked, "x.pyc"))).toBe(true)
  } finally {
    await chmod(locked, 0o755)
  }
})

test("isRegenerable accepts rebuildable output and rejects local files", () => {
  const regenerable = [
    "dist/",
    "web/node_modules/",
    "pkg/__pycache__/",
    "pytest-of-me/",
    "a/b.pyc",
    "tsconfig.tsbuildinfo",
    ".DS_Store",
  ]
  // Only the entry itself counts: an ignored file inside a tracked out/ or dist/
  // folder is still local data.
  const local = [
    ".env",
    "config/local.json",
    "notes/distribution.txt",
    ".env.local",
    "tools/out/secrets.json",
    "dist/local.env",
    "build/notes/",
  ]
  expect(regenerable.filter((file) => !JanitorJunk.isRegenerable(file))).toEqual([])
  expect(local.filter((file) => JanitorJunk.isRegenerable(file))).toEqual([])
})

test("findJunk lists junk targets without deleting them", async () => {
  await using tmp = await tmpdir()
  await put(tmp.path, "coverage/index.ts")
  await put(tmp.path, "pkg/__pycache__/a.pyc")
  await put(tmp.path, "node_modules/x/__pycache__/b.pyc")
  expect((await JanitorJunk.findJunk(tmp.path)).sort()).toEqual([
    path.join(tmp.path, "coverage"),
    path.join(tmp.path, "pkg/__pycache__"),
  ])
  expect(await exists(path.join(tmp.path, "coverage/index.ts"))).toBe(true)
  expect(await exists(path.join(tmp.path, "pkg/__pycache__/a.pyc"))).toBe(true)
})

test("size reports the newest mtime anywhere and caps on an unreadable folder", async () => {
  await using tmp = await tmpdir()
  await put(tmp.path, "a/b/new.txt")
  const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
  for (const entry of ["a/b", "a", "."]) await utimes(path.join(tmp.path, entry), old, old)
  const newest = (await lstat(path.join(tmp.path, "a/b/new.txt"))).mtimeMs
  expect(await JanitorJunk.size(tmp.path)).toMatchObject({ mtime: newest, capped: false })
  await chmod(path.join(tmp.path, "a/b"), 0o000)
  try {
    expect((await JanitorJunk.size(tmp.path)).capped).toBe(true)
  } finally {
    await chmod(path.join(tmp.path, "a/b"), 0o755)
  }
})

test("findJunk never descends into or lists a nested repository", async () => {
  await using tmp = await tmpdir()
  await put(tmp.path, "pkg/__pycache__/a.pyc")
  await put(tmp.path, "vendor/lib/.git/HEAD", "ref: refs/heads/main\n")
  await put(tmp.path, "vendor/lib/__pycache__/b.pyc")
  await put(tmp.path, "coverage/.git/HEAD", "ref: refs/heads/main\n")

  expect(await JanitorJunk.findJunk(tmp.path)).toEqual([path.join(tmp.path, "pkg/__pycache__")])
})

test("size lists every nested repository below the root", async () => {
  await using tmp = await tmpdir()
  await put(tmp.path, "notes.md")
  await put(tmp.path, "sub/.git/HEAD", "ref: refs/heads/main\n")
  await put(tmp.path, "a/b/.git", "gitdir: /elsewhere/.git/worktrees/b\n")
  expect((await JanitorJunk.size(tmp.path)).repos).toEqual(["a/b", "sub"])
})

test("findJunk never descends into virtualenvs or site-packages", async () => {
  await using tmp = await tmpdir()
  await put(tmp.path, "pkg/__pycache__/a.pyc")
  await put(tmp.path, ".venv/lib/python3.12/site-packages/coverage/__init__.py")
  await put(tmp.path, "venv/lib/python3.12/site-packages/coverage/__init__.py")
  await put(tmp.path, "vendor/site-packages/coverage/__init__.py")
  expect(await JanitorJunk.findJunk(tmp.path)).toEqual([path.join(tmp.path, "pkg/__pycache__")])
})
