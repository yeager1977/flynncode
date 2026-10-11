export type ReviewPreset = "uncommitted" | "base-branch" | "commit"

export function reviewPresetArgs(preset: ReviewPreset, target?: string) {
  const trimmed = target?.trim() ?? ""
  if (preset === "base-branch" || preset === "commit") return trimmed
  return ""
}
