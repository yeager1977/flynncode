// Keyboard entry into the sidebar's right-click menus: the ContextMenu (Apps)
// key and Shift+F10 open the menu at the trigger, the way browsers do it.
export function dispatchContextMenu(target: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return false
  event.preventDefault()
  const rect = target.getBoundingClientRect()
  return target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    }),
  )
}