import { expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"

test("provider endpoints return models and conditional responses under Node", async () => {
  await using tmp = await tmpdir()
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for the provider runtime compatibility test")
  const bundle = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "../../src/node.ts")],
    target: "node",
    format: "esm",
    external: ["jsonc-parser", "@lydell/node-pty"],
    define: { OPENCODE_MODELS_DEV: "{}", OPENCODE_VERSION: '"test"', OPENCODE_CHANNEL: '"dev"' },
  })
  expect(bundle.success).toBe(true)
  const entry = path.join(tmp.path, "server.mjs")
  await Bun.write(entry, bundle.outputs[0])
  await symlink(path.join(import.meta.dir, "../../../desktop/node_modules"), path.join(tmp.path, "node_modules"), "dir")
  const child = Bun.spawn(
    [
      node,
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict"
      import { createServer } from "node:net"
      import { Server } from ${JSON.stringify(pathToFileURL(entry).href)}
      assert.equal(typeof Bun, "undefined")
      const probe = createServer()
      await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).on("error", reject))
      const port = probe.address().port
      await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()))
      const server = await Server.listen({ hostname: "127.0.0.1", port })
      try {
        for (const route of ["/provider", "/provider/connected"]) {
          const response = await fetch(new URL(route, server.url), { headers: { "x-opencode-directory": ${JSON.stringify(tmp.path)} } })
          assert.equal(response.status, 200, route + " " + await response.clone().text())
          const body = await response.json()
          assert.ok(body.connected.includes("anthropic"), route)
          assert.ok(body.all.some((provider) => provider.id === "anthropic" && Object.keys(provider.models).length > 0), route)
          const etag = response.headers.get("etag")
          assert.ok(etag, route)
          const cached = await fetch(new URL(route, server.url), { headers: { "x-opencode-directory": ${JSON.stringify(tmp.path)}, "if-none-match": etag } })
          assert.equal(cached.status, 304, route)
          assert.equal(cached.headers.get("etag"), etag, route)
        }
      } finally {
        await server.stop(true)
      }
    `,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_TEST_HOME: tmp.path,
        OPENCODE_DB: ":memory:",
        OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: "api", key: "test-key" } }),
        OPENCODE_MODELS_PATH: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
      },
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
}, 90_000)
