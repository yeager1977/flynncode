import { Effect, Schema } from "effect"
import { Search } from "@flynncode/codemode"
import { PositiveInt } from "@flynncode/core/schema"
import { McpLoaded } from "@/mcp/loaded"
import { Session } from "@/session/session"
import { isRecord } from "@/util/record"
import { levenshtein } from "./edit"
import { Tool } from "./tool"
import DESCRIPTION from "./tool-search.txt"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: 'Keyword query, or "select:name_a,name_b" to load exact tool names',
  }),
  max_results: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of keyword search results (default 5, maximum 20)",
  }),
})

/** One deferred MCP tool, as `MCP.tools()` describes it. */
export type Entry = {
  id: string
  description?: string
  inputSchema: object
}

type Metadata = {
  query: string
  loaded: string[]
}

const SELECT = "select:"
const DEFAULT_RESULTS = 5
const MAX_RESULTS = 20
// Bytes, not characters: Tool.wrap truncates by bytes and its notice would replace our message.
const OUTPUT_CAP = 25_000
const SUGGESTIONS = 5

/**
 * Built per turn from that turn's deferred tools (already filtered by permissions), so
 * it can only list and load tools the agent may see.
 */
export function make(input: { deferred: ReadonlyArray<Entry> }) {
  return Tool.define<typeof Parameters, Metadata, Session.Service>(
    "tool_search",
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const index = input.deferred.map(indexEntry)
      return {
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
          Effect.gen(function* () {
            const found = find(index, params)
            const missing = [
              ...found.missing.map((name) => {
                const near = closest(index, name).slice(0, 3)
                return near.length === 0 ? `no such tool: ${name}` : `no such tool: ${name} (closest: ${near.join(", ")})`
              }),
              ...(found.skipped > 0
                ? [`select: loads at most ${MAX_RESULTS} tools per call; ${found.skipped} extra name(s) were ignored`]
                : []),
            ]
            if (found.matched.length === 0) {
              return {
                title: "No MCP tools matched",
                metadata: { query: params.query, loaded: [] },
                output: missing.length > 0 ? missing.join("\n") : noMatch(index, params.query),
              }
            }
            const ids = found.matched.map((item) => item.entry.id)
            yield* McpLoaded.add(sessions, ctx.sessionID, ids)
            return {
              title: `Loaded ${ids.length} MCP tool${ids.length === 1 ? "" : "s"}`,
              metadata: { query: params.query, loaded: ids },
              output: render(found.matched, missing),
            }
          }),
      }
    }),
  )
}

type Indexed = ReturnType<typeof indexEntry>

function indexEntry(entry: Entry) {
  const id = entry.id.toLowerCase()
  const description = entry.description ?? ""
  const properties =
    isRecord(entry.inputSchema) && isRecord(entry.inputSchema.properties)
      ? Object.entries(entry.inputSchema.properties)
      : []
  return {
    entry,
    fields: {
      names: [id, ...Search.tokenize(entry.id)],
      path: id,
      description: description.toLowerCase(),
      searchText: [
        id,
        description,
        ...properties.flatMap(([name, value]) =>
          isRecord(value) && typeof value.description === "string" ? [name, value.description] : [name],
        ),
      ]
        .join("\n")
        .toLowerCase(),
    },
  }
}

function find(index: ReadonlyArray<Indexed>, params: Schema.Schema.Type<typeof Parameters>) {
  const query = params.query.trim()
  if (query.slice(0, SELECT.length).toLowerCase() === SELECT) {
    const requested = [
      ...new Set(
        query
          .slice(SELECT.length)
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      ),
    ]
    const names = requested.slice(0, MAX_RESULTS)
    return {
      matched: names.flatMap((name) => index.filter((item) => item.entry.id === name)),
      missing: names.filter((name) => !index.some((item) => item.entry.id === name)),
      skipped: requested.length - names.length,
    }
  }
  const terms = Search.terms(query)
  return {
    matched: index
      .map((item) => ({ item, score: Search.score(terms, item.fields) }))
      .filter((ranked) => ranked.score > 0)
      .toSorted((left, right) => right.score - left.score || left.item.entry.id.localeCompare(right.item.entry.id))
      .slice(0, Math.min(params.max_results ?? DEFAULT_RESULTS, MAX_RESULTS))
      .map((ranked) => ranked.item),
    missing: [],
    skipped: 0,
  }
}

function noMatch(index: ReadonlyArray<Indexed>, query: string) {
  const near = closest(index, query)
  return near.length === 0
    ? `No deferred tools matched "${query}".`
    : `No deferred tools matched "${query}". Closest names: ${near.join(", ")}`
}

function render(matched: ReadonlyArray<Indexed>, missing: ReadonlyArray<string>) {
  const ids = matched.map((item) => item.entry.id)
  const full = [
    ...missing,
    ...matched.map(
      (item) =>
        `## ${item.entry.id}\n${item.entry.description ?? ""}\nParameters: ${JSON.stringify(item.entry.inputSchema, null, 2)}`,
    ),
    `Loaded: ${ids.join(", ")}. Call them directly; they stay loaded for this session.`,
  ].join("\n\n")
  if (Buffer.byteLength(full) <= OUTPUT_CAP) return full
  return [
    ...missing,
    `Loaded ${ids.length} tools: ${ids.join(", ")}.`,
    "Their schemas exceed the output limit, so they are omitted here; the tools arrive with full schemas on your next step. To read schemas here, narrow your query or select fewer names.",
  ].join("\n\n")
}

/** Closest tool ids by search score, then by edit distance to the query. */
function closest(index: ReadonlyArray<Indexed>, query: string) {
  const terms = Search.terms(query)
  const target = query.trim().toLowerCase()
  return index
    .map((item) => ({
      id: item.entry.id,
      score: Search.score(terms, item.fields),
      distance: levenshtein(target, item.fields.path),
    }))
    .toSorted(
      (left, right) => right.score - left.score || left.distance - right.distance || left.id.localeCompare(right.id),
    )
    .slice(0, SUGGESTIONS)
    .map((item) => item.id)
}

export * as ToolSearch from "./tool-search"
