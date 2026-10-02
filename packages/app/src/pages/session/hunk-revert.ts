export function reversePatch(patch: string) {
  const lines = patch.split("\n")
  const out: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const next = lines[index + 1]
    if (line.startsWith("--- ") && next?.startsWith("+++ ")) {
      out.push(`--- ${next.slice(4)}`)
      out.push(`+++ ${line.slice(4)}`)
      index++
      continue
    }
    if (line.startsWith("@@")) {
      out.push(reverseHunkHeader(line))
      continue
    }
    if (line.startsWith("+")) {
      out.push(`-${line.slice(1)}`)
      continue
    }
    if (line.startsWith("-")) {
      out.push(`+${line.slice(1)}`)
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

export function browserAnnotation(input: {
  url: string
  note: string
  x: number
  y: number
  width: number
  height: number
}) {
  const start = `${Math.round(input.x)}%,${Math.round(input.y)}%`
  const end = `${Math.round(input.x + input.width)}%,${Math.round(input.y + input.height)}%`
  const mark = input.width < 1 && input.height < 1 ? start : `${start}-${end}`
  return `${input.url} ${mark}: ${input.note}`
}

function reverseHunkHeader(line: string) {
  return line.replace(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
    (_match, oldStart: string, oldLines: string | undefined, newStart: string, newLines: string | undefined) =>
      `@@ -${newStart}${newLines ? `,${newLines}` : ""} +${oldStart}${oldLines ? `,${oldLines}` : ""} @@`,
  )
}
