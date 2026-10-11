import type { Part } from "@flynncode/sdk/v2"

export async function parseOutputSchema(raw: string): Promise<Record<string, unknown>> {
  if (raw.trim().length === 0) throw new Error("--output-schema must not be empty")
  if (raw.startsWith("@")) return fromFile(raw.slice(1))
  return fromInline(raw)
}

async function fromFile(path: string): Promise<Record<string, unknown>> {
  if (!(await Bun.file(path).exists())) throw new Error(`--output-schema file not found: ${path}`)
  return toRecord(await Bun.file(path).json().catch(fail(path)), path)
}

function fromInline(raw: string): Record<string, unknown> {
  try {
    return toRecord(JSON.parse(raw), "inline JSON")
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`--output-schema is not valid JSON: ${error.message}`)
    throw error
  }
}

function fail(path: string) {
  return (cause: unknown): never => {
    throw new Error(`--output-schema file is not valid JSON: ${path} (${cause instanceof Error ? cause.message : String(cause)})`)
  }
}

function toRecord(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`--output-schema must be a JSON object schema (from ${source})`)
  return value as Record<string, unknown>
}

export function readStructuredResult(part: Part): unknown {
  if (part.type !== "tool") return undefined
  if (part.tool !== "StructuredOutput") return undefined
  if (part.state.status !== "completed") return undefined
  return part.state.input
}
