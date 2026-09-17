import { describe, expect, it } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "../src/api"

describe("import routes", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }

  it("exposes the import session route", () => {
    expect(spec.paths["/api/import/session"]?.post?.operationId).toBe("v2.import.session")
  })

  it("exposes the imported listing route", () => {
    expect(spec.paths["/api/import/imported"]?.get?.operationId).toBe("v2.import.imported")
  })
})