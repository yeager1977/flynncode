// Diff two V8 heapsnapshots: aggregate self-size/count per constructor name,
// report the biggest growth A->B, and drill short retainer chains for top types.
import fs from "node:fs"

const [aPath, bPath, topN = "15"] = process.argv.slice(2)
if (!aPath || !bPath) { console.error("usage: diff.mjs <A.heapsnapshot> <B.heapsnapshot> [topN]"); process.exit(1) }

type NodeMeta = { type: string; name: string; selfSize: number; count: number; id: number }

function load(path: string) {
  const json = JSON.parse(fs.readFileSync(path, "latin1"))
  const meta = json.snapshot.meta
  const fieldWidths = meta.node_fields.map((f: string, i: number) => [f, meta.node_types[i]]) as [string, any][]
  const nodes = json.nodes as number[]
  const strings = json.strings as string[]
  const width = meta.node_fields.length
  const idx = Object.fromEntries(meta.node_fields.map((f: string, i: number) => [f, i]))
  const nodeTypeNames = meta.node_types[idx.type].map ? meta.node_types[0].indexOf : null
  // node_types[0] is the list of type names; the `type` field holds its index
  const typeNames = meta.node_types[0] as string[]
  const out: NodeMeta[] = []
  for (let i = 0; i < nodes.length / width; i++) {
    const base = i * width
    const type = typeNames[nodes[base + idx.type]] ?? String(nodes[base + idx.type])
    const name = strings[nodes[base + idx.name]] ?? ""
    out.push({ type, name, selfSize: nodes[base + idx.self_size], count: 1, id: i })
  }
  return { out, width, idx, nodes, strings }
}

const A = load(aPath)
const B = load(bPath)

function aggregate(list: NodeMeta[]) {
  const m = new Map<string, { count: number; selfSize: number }>()
  for (const n of list) {
    const key = n.type === "object" || n.type === "hidden" ? `${n.type}:${n.name}` : n.type
    const e = m.get(key) ?? { count: 0, selfSize: 0 }
    e.count++; e.selfSize += n.selfSize
    m.set(key, e)
  }
  return m
}

const aggA = aggregate(A.out)
const aggB = aggregate(B.out)
const rows = []
for (const [key, a] of aggA) {
  const b = aggB.get(key) ?? { count: 0, selfSize: 0 }
  rows.push({ key: key as string, dcount: b.count - a.count, dsize: b.selfSize - a.selfSize, countB: b.count, sizeB: b.selfSize })
}
for (const [key, b] of aggB) if (!aggA.has(key)) rows.push({ key, dcount: b.count, dsize: b.selfSize, countB: b.count, sizeB: b.selfSize })
rows.sort((x, y) => y.dsize - x.dsize)
const n = Number(topN)
console.log(`nodes: ${A.out.length} -> ${B.out.length}`)
console.log(`total self bytes: ${A.out.reduce((s, x) => s + x.selfSize, 0)} -> ${B.out.reduce((s, x) => s + x.selfSize, 0)}`)
console.log(`\ntop ${n} growth by self-size (A -> B):`)
for (const r of rows.slice(0, n)) {
  console.log(`  ${r.dsize >= 0 ? "+" : ""}${(r.dsize / 1048576).toFixed(1).padStart(9)} MB  count ${r.dcount >= 0 ? "+" : ""}${String(r.dcount).padStart(7)}  ${r.key}`)
}

const totalSizeB = B.out.reduce((s, x) => s + x.selfSize, 0)
console.log(`\ntop ${n} holders in B:`)
const rowsB = [...aggB.entries()].map(([key, v]) => ({ key, ...v })).sort((x, y) => y.selfSize - x.selfSize)
for (const r of rowsB.slice(0, n)) console.log(`  ${(r.selfSize / 1048576).toFixed(1).padStart(9)} MB  n=${String(r.count).padStart(7)}  ${r.key}`)