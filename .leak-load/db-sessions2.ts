import { Database } from "bun:sqlite"
const db = new Database(process.env.HOME + "/.local/share/opencode/opencode-dev.db", { readonly: true })
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => t.name)
console.log("tables:", tables.filter((t: string) => /message|part|session/.test(t)).join(","))
const mcols = db.query("PRAGMA table_info(message)").all().map((c: any) => c.name)
console.log("message cols:", mcols.join(","))
const roots = db
  .query("SELECT id, title, agent, model, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_created DESC LIMIT 24")
  .all() as any[]
for (const r of roots) {
  const msgs = db.query("SELECT json_extract(data,'$.role') AS role, json_extract(data,'$.agent') AS agent, json_extract(data,'$.model.providerID') AS p, json_extract(data,'$.model.modelID') AS m FROM message WHERE session_id = ? ORDER BY time_created").all(r.id) as any[]
  const users = msgs.filter((m) => m.role === "user")
  const def = /^New session - \d{4}-/.test(r.title)
  console.log(
    def ? "STUCK " : "titled",
    new Date(r.time_created).toISOString().slice(5, 19),
    "msgs=" + msgs.length,
    "users=" + users.length,
    "agent=" + (users[0]?.agent ?? r.agent ?? "?"),
    "model=" + (users[0]?.p ?? "?") + "/" + (users[0]?.m ?? "?"),
    "| " + r.title.slice(0, 40),
  )
}
