export type SessionKindFilter = "all" | "code" | "knowledge"

export type KindLike = { kind?: string | null | undefined }

export function isKnowledgeSession(session: KindLike) {
  return session.kind === "knowledge"
}

export function filterSessionsByKind<T>(rows: readonly T[], filter: SessionKindFilter, kindOf: (row: T) => KindLike) {
  if (filter === "all") return [...rows]
  if (filter === "knowledge") return rows.filter((row) => isKnowledgeSession(kindOf(row)))
  return rows.filter((row) => !isKnowledgeSession(kindOf(row)))
}
