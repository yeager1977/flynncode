import { describe, expect, it } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "../src/api"

describe("import source routes", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }

  it("exposes the sources listing route", () => {
    expect(spec.paths["/api/import/sources"]?.get?.operationId).toBe("v2.import.sources")
  })

  it("exposes the from-source route", () => {
    expect(spec.paths["/api/import/from-source"]?.post?.operationId).toBe("v2.import.fromSource")
  })
})