export * as ConfigDependencies from "./dependencies"

import { Effect } from "effect"
import path from "path"
import { Npm } from "@flynncode/core/npm"
import { FSUtil } from "@flynncode/core/fs-util"
import { isRecord } from "@/util/record"
import plugin from "../../../plugin/package.json"

export const make = Effect.gen(function* () {
  const npm = yield* Npm.Service
  const fs = yield* FSUtil.Service
  return Effect.fn("ConfigDependencies.install")(function* (dir: string) {
    const manifest = yield* fs.readJson(path.join(dir, "package.json")).pipe(Effect.orElseSucceed(() => ({})))
    const declared =
      isRecord(manifest) &&
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(
        (key) => isRecord(manifest[key]) && Object.hasOwn(manifest[key], "@opencode-ai/plugin"),
      )
    // Config directories are external npm projects. Use the published upstream
    // API version matching our workspace, never a fork/dev binary version.
    yield* npm.install(dir, {
      add: declared ? [] : [{ name: "@opencode-ai/plugin", version: plugin.version }],
    })
  })
})
