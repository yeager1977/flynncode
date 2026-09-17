export * as SessionImportRegistry from "./import-registry"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionTable } from "./sql"

export const ImportedMetadataKey = "import"

export type ImportProvenance = {
  readonly source: "claude-code" | "codex"
  readonly sourceSessionID: string
  readonly sourcePath: string
  readonly importedAt: number
}

const isSource = (value: unknown): value is ImportProvenance["source"] =>
  value === "claude-code" || value === "codex"

export const encodeProvenance = (input: ImportProvenance): Record<string, unknown> => ({
  [ImportedMetadataKey]: {
    source: input.source,
    sourceSessionID: input.sourceSessionID,
    sourcePath: input.sourcePath,
    importedAt: input.importedAt,
  },
})

export const decodeProvenance = (metadata: unknown): ImportProvenance | undefined => {
  if (typeof metadata !== "object" || metadata === null) return
  const value = (metadata as Record<string, unknown>)[ImportedMetadataKey]
  if (typeof value !== "object" || value === null) return
  const record = value as Record<string, unknown>
  if (!isSource(record.source)) return
  if (typeof record.sourceSessionID !== "string") return
  if (typeof record.sourcePath !== "string") return
  if (typeof record.importedAt !== "number") return
  return {
    source: record.source,
    sourceSessionID: record.sourceSessionID,
    sourcePath: record.sourcePath,
    importedAt: record.importedAt,
  }
}

export const findImported = (
  db: Database.Interface["db"],
  input: { readonly source: ImportProvenance["source"]; readonly directory: string },
): Effect.Effect<ReadonlyArray<{ sourceSessionID: string; sessionID: string }>> =>
  db
    .select({ id: SessionTable.id, metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.directory, input.directory))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map(
        (rows) =>
          rows
            .map((row) => ({ row, provenance: decodeProvenance(row.metadata) }))
            .filter((item): item is { row: (typeof rows)[number]; provenance: ImportProvenance } => {
              if (!item.provenance) return false
              return item.provenance.source === input.source
            })
            .map((item) => ({
              sourceSessionID: item.provenance.sourceSessionID,
              sessionID: item.row.id,
            })),
      ),
    )