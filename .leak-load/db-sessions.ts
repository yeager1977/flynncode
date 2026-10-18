import { Database } from "bun:sqlite"
const db = new Database(process.env.HOME + "/.local/share/opencode/opencode-dev.db", { readonly: true })
const cols = db.query("PRAGMA table_info(session)").all().map((c: any) => c.name)
console.log("columns:", cols.join(","))
const rows = db
  .query("SELECT id, title, parent_id, time_created, time_updated FROM session ORDER BY time_created DESC LIMIT 40")
  .all() as any[]
for (const r of rows) {
  console.log(new Date(r.time_created).toISOString().slice(0, 19), r.parent_id ? "child" : "root ", JSON.stringify(r.title))
}
