export function splitPatchToHunks(patch: string) {
  const lines = patch.split("\n")
  const header = lines.filter((line) => line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff "))
  const hunks: string[][] = []
  for (const line of lines) {
    if (line.startsWith("@@ ")) hunks.push([line])
    else if (hunks.length > 0) hunks[hunks.length - 1]?.push(line)
  }
  return hunks
    .map((hunk) => [...header, ...hunk].join("\n"))
    .filter((hunk) => /^@@ /m.test(hunk))
}
