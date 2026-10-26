import { Option, Schema } from "effect"

export type Cell = Record<string, unknown>
export type CellType = "code" | "markdown" | "raw"
export type Notebook = {
  value: Record<string, unknown> & { cells: Cell[] }
  // undefined means the file was compact (single-line) JSON.
  indent: string | undefined
  newline: boolean
  eol: "\n" | "\r\n"
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function parse(text: string): Notebook | undefined {
  const value = Option.getOrUndefined(decodeJson(text))
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const cells = (value as Record<string, unknown>).cells
  if (
    !Array.isArray(cells) ||
    !cells.every((cell) => typeof cell === "object" && cell !== null && !Array.isArray(cell))
  )
    return undefined
  return {
    value: value as Notebook["value"],
    indent: /^\s*\{\r?\n([ \t]+)"/.exec(text)?.[1],
    newline: /\n$/.test(text),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  }
}

export function serialize(nb: Notebook) {
  const json = JSON.stringify(nb.value, null, nb.indent) + (nb.newline ? "\n" : "")
  return nb.eol === "\r\n" ? json.replaceAll("\n", "\r\n") : json
}

export function cellID(cell: Cell, index: number) {
  return typeof cell.id === "string" ? cell.id : `cell-${index}`
}

export function sourceText(cell: Cell) {
  if (Array.isArray(cell.source)) return cell.source.join("")
  return typeof cell.source === "string" ? cell.source : ""
}

export function hasMissingIDs(nb: Notebook) {
  return nb.value.cells.some((cell) => typeof cell.id !== "string")
}

export function render(nb: Notebook) {
  const missing = hasMissingIDs(nb)
  return [
    `<notebook cells="${nb.value.cells.length}">`,
    ...(missing
      ? [
          "(Some cells have no cell ids. Address them as cell-<index>, 0-based, as shown below, when using notebook_edit.)",
        ]
      : []),
    ...nb.value.cells.flatMap((cell, index) => [
      `<cell id="${cellID(cell, index)}" type="${String(cell.cell_type)}">`,
      ...(sourceText(cell) === "" ? [] : sourceText(cell).split("\n")),
      ...summarize(cell),
      "</cell>",
    ]),
    "</notebook>",
  ]
}

function summarize(cell: Cell) {
  if (!Array.isArray(cell.outputs) || cell.outputs.length === 0) return []
  const kinds = cell.outputs.flatMap((output: unknown) => {
    if (typeof output !== "object" || output === null) return []
    const item = output as Record<string, unknown>
    if (item.output_type === "stream") return [typeof item.name === "string" ? item.name : "stream"]
    if (item.output_type === "error") return [`error: ${typeof item.ename === "string" ? item.ename : "unknown"}`]
    if (typeof item.data === "object" && item.data !== null) return Object.keys(item.data)
    return []
  })
  return [`[outputs: ${cell.outputs.length}${kinds.length > 0 ? ` — ${[...new Set(kinds)].join(", ")}` : ""}]`]
}

export type Change = {
  edit_mode: "replace" | "insert" | "delete"
  cell_id?: string
  cell_type?: CellType
  new_source?: string
}

// Applies one edit in place and returns a one-line description of what happened.
export function apply(nb: Notebook, change: Change) {
  const cells = nb.value.cells
  if (change.edit_mode === "insert") {
    if (!change.cell_type) throw new Error("cell_type is required when inserting a cell")
    if (change.new_source === undefined) throw new Error("new_source is required when inserting a cell")
    const at = change.cell_id === undefined ? 0 : locate(nb, change.cell_id) + 1
    const cell = fresh(nb, change.cell_type, change.new_source)
    cells.splice(at, 0, cell)
    return `Inserted a new ${change.cell_type} cell ${cellID(cell, at)} at position ${at}.`
  }

  if (change.cell_id === undefined) throw new Error(`cell_id is required to ${change.edit_mode} a cell`)
  const index = locate(nb, change.cell_id)

  if (change.edit_mode === "delete") {
    cells.splice(index, 1)
    return `Deleted cell ${change.cell_id}.${hasMissingIDs(nb) ? " Cells without ids are renumbered cell-0, cell-1, ..." : ""}`
  }

  if (change.new_source === undefined) throw new Error("new_source is required when replacing a cell")
  const cell = cells[index]
  const type = change.cell_type ?? cell.cell_type
  const retyped = type !== cell.cell_type
  cell.cell_type = type
  cell.source = formatSource(change.new_source, usesArray(nb, cell))
  if (type === "code") {
    cell.outputs = []
    cell.execution_count = null
  }
  if (type !== "code") {
    delete cell.outputs
    delete cell.execution_count
  }
  if (retyped) cells[index] = order(nb, cell)
  return `Replaced the source of cell ${change.cell_id}.`
}

function locate(nb: Notebook, id: string) {
  const byID = nb.value.cells.findIndex((cell) => cell.id === id)
  if (byID !== -1) return byID
  const index = /^cell-(\d+)$/.exec(id)?.[1]
  if (index !== undefined && Number(index) < nb.value.cells.length) return Number(index)
  const known = nb.value.cells.map(cellID)
  throw new Error(
    `Cell not found: ${id}. Cells in this notebook: ${known.slice(0, 20).join(", ")}${known.length > 20 ? ", ..." : ""}`,
  )
}

function fresh(nb: Notebook, type: CellType, source: string) {
  const taken = new Set(nb.value.cells.flatMap((cell) => (typeof cell.id === "string" ? [cell.id] : [])))
  const useIDs = taken.size > 0 || Number(nb.value.nbformat_minor) >= 5
  return order(nb, {
    cell_type: type,
    ...(useIDs ? { id: newID(taken) } : {}),
    metadata: {},
    ...(type === "code" ? { execution_count: null, outputs: [] } : {}),
    source: formatSource(source, usesArray(nb)),
  })
}

function newID(taken: Set<string>): string {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8)
  return taken.has(id) ? newID(taken) : id
}

// Jupyter writes `source` as an array of lines; follow whatever form the notebook already uses.
function usesArray(nb: Notebook, cell?: Cell) {
  if (cell && typeof cell.source === "string") return false
  if (cell && Array.isArray(cell.source)) return true
  if (nb.value.cells.some((item) => Array.isArray(item.source))) return true
  return !nb.value.cells.some((item) => typeof item.source === "string")
}

function formatSource(text: string, array: boolean) {
  if (!array) return text
  return text === "" ? [] : text.split(/(?<=\n)/)
}

// Jupyter sorts cell keys alphabetically; keep new and retyped cells consistent with notebooks that do.
function order(nb: Notebook, cell: Cell) {
  const sorted = nb.value.cells.every((item) => item === cell || isSorted(Object.keys(item)))
  if (!sorted) return cell
  return Object.fromEntries(Object.entries(cell).sort(([a], [b]) => (a < b ? -1 : 1)))
}

function isSorted(keys: string[]) {
  return keys.every((key, i) => i === 0 || keys[i - 1] < key)
}
