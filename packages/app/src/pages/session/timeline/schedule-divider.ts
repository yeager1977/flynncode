import type { Part, TextPart } from "@flynncode/sdk/v2"

// A scheduled prompt is a synthetic prompt whose text part carries the job in
// metadata; the divider shows a cron job's expression or a wakeup's reason.
export function scheduleContinuation(parts: Part[]) {
  const metadata = parts.find((part): part is TextPart => part.type === "text" && part.synthetic === true)?.metadata
  const schedule = metadata?.["schedule"]
  if (typeof schedule !== "object" || schedule === null) return {}
  const fields: Record<string, unknown> = { ...schedule }
  const kind: "cron" | "wakeup" | undefined =
    fields["kind"] === "cron" ? "cron" : fields["kind"] === "wakeup" ? "wakeup" : undefined
  if (!kind) return {}
  const detail = fields[kind === "cron" ? "cron" : "reason"]
  if (typeof detail !== "string") return {}
  const line = detail.trim().split("\n")[0]?.trim() ?? ""
  if (line === "") return {}
  return { scheduleKind: kind, scheduleDetail: line.length > 160 ? `${line.slice(0, 159)}…` : line }
}
