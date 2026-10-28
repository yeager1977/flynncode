import { ansiCubeRgb, type AnsiColor } from "@flynncode/ui/theme/ansi"

// The 16 base colours resolve to the theme-aware variables in session-status-line.css.
export function ansiCssColor(color: AnsiColor) {
  if (typeof color === "object") return `rgb(${color.r} ${color.g} ${color.b})`
  if (color < 16) return `var(--status-line-ansi-${color})`
  const rgb = ansiCubeRgb(color)
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`
}
