#!/usr/bin/env bun
// Runs before packaging (prepackage:* scripts): the shared version generator
// stamps every desktop package with a fresh preview version, so the install
// and the packaged app.getVersion() the UI shows reflect the actual build.
// All paths resolve from this script's directory: bun runs pre-hooks with the
// caller's cwd, which varies.
import path from "node:path"
import { Script } from "@flynncode/script"

await import("./prebuild")

const desktopDir = path.resolve(import.meta.dir, "..")
const pkgPath = path.join(desktopDir, "package.json")
const lockPath = path.join(desktopDir, "..", "..", "bun.lock")

const pkg = await Bun.file(pkgPath).json()
const previous = pkg.version
pkg.version = Script.version
await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n")

// The committed lockfile carries the workspace version; rewrite only the
// desktop entry so version checks stay consistent (a full `bun install` here
// would re-run postinstall builds and can recurse).
const lock = await Bun.file(lockPath).text()
const entry = /("packages\/desktop":\s*\{\s*"name": "@flynncode\/desktop",\s*\n(\s*)"version": ")[^"]*(")/
if (!entry.test(lock)) throw new Error("desktop version entry not found in bun.lock — sync it manually")
await Bun.write(lockPath, lock.replace(entry, `$1${Script.version}$3`))

if (previous !== Script.version) console.log(`Updated package.json version to ${Script.version}`)