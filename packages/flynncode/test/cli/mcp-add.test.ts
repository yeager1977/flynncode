import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { cliIt } from "../lib/cli-process"

// The global config lives in ~/.config/flynncode since the rename. The CLI
// prefers an existing opencode.json / opencode.jsonc and writes opencode.json
// when neither exists.
async function readGlobalConfig(home: string) {
  const dir = path.join(home, ".config", "flynncode")
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = Bun.file(path.join(dir, name))
    if (!(await file.exists())) continue
    return parseJsonc(await file.text()) as {
      mcp?: Record<string, unknown>
    }
  }
  throw new Error(`No global config written in ${dir}`)
}

describe("opencode mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config.mcp?.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config.mcp?.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
      }),
    60_000,
  )
})
