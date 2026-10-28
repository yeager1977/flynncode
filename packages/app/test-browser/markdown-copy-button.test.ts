import { describe, expect, mock, test } from "bun:test"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { I18nProvider, type UiI18n } from "@flynncode/ui/context/i18n"

// Bun cannot load Vite's `?worker&url` imports; point them at the real worker so markdown renders code blocks.
const sessionUI = new URL("../../session-ui/src/", import.meta.url).pathname
mock.module(`${sessionUI}components/markdown.worker.ts?worker&url`, () => ({
  default: new URL("components/markdown.worker.ts", `file://${sessionUI}`).href,
}))

const { Markdown } = await import("@flynncode/session-ui/markdown")

const code = (name: string) => "```ts\n" + `export const ${name} = 1\n` + "```\n\n"
const answer = `Intro paragraph.\n\n${code("first")}Middle paragraph.\n\n${code("second")}`

async function until(check: () => boolean) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("timed out waiting for markdown to render")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function mount(initial: string) {
  const host = document.createElement("div")
  document.body.append(host)
  const [text, setText] = createSignal(initial)
  const [locale, setLocale] = createSignal("en")
  const calls = { t: 0 }
  const i18n: UiI18n = {
    locale,
    t: (key) => {
      calls.t += 1
      return `${locale()}:${key}`
    },
    plural: (key) => `${locale()}:${key}`,
  }
  const dispose = render(
    () =>
      createComponent(I18nProvider, {
        value: i18n,
        get children() {
          return createComponent(Markdown, {
            get text() {
              return text()
            },
            streaming: true,
            cacheKey: "copy-button-test",
          })
        },
      }),
    host,
  )
  const buttons = () => [...host.querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')]
  const label = (button: HTMLElement) => button.querySelector("button")?.getAttribute("aria-label")
  const rendered = (value: string) => host.querySelector("[data-component=markdown]")?.textContent?.includes(value)
  return {
    calls,
    buttons,
    label,
    rendered,
    setLocale,
    async append(value: string) {
      setText((current) => current + value)
      await until(() => !!rendered(value))
    },
    dispose() {
      dispose()
      host.remove()
    },
  }
}

describe("markdown copy buttons", () => {
  test("labels are created once and streaming updates do not relabel or rebuild buttons", async () => {
    const view = mount(answer)
    await until(() => view.buttons().length === 2)
    const icons = view.buttons().map((button) => button.querySelector("[data-copy-icon]"))
    view.calls.t = 0

    await view.append("Streaming tail")
    await view.append(" keeps growing")
    await view.append(" with more words")

    expect(view.calls.t).toBe(0)
    expect(view.buttons().map((button) => button.querySelector("[data-copy-icon]"))).toEqual(icons)
    expect(view.buttons().map(view.label)).toEqual(["en:ui.message.copy", "en:ui.message.copy"])
    view.dispose()
  })

  test("a locale change relabels every copy button", async () => {
    const view = mount(answer)
    await until(() => view.buttons().length === 2)

    view.setLocale("fr")

    await until(() => view.buttons().every((button) => view.label(button) === "fr:ui.message.copy"))
    view.dispose()
  })

  test("a copied button keeps its copied state across streaming updates", async () => {
    const view = mount(answer)
    await until(() => view.buttons().length === 2)
    const [first, second] = view.buttons()

    first!.querySelector("button")!.click()
    await until(() => first!.getAttribute("data-copied") === "true")
    expect(await navigator.clipboard.readText()).toBe("export const first = 1")
    expect(view.label(first!)).toBe("en:ui.message.copied")

    await view.append("Streaming tail")

    expect(first!.getAttribute("data-copied")).toBe("true")
    expect(view.label(first!)).toBe("en:ui.message.copied")
    expect(second!.hasAttribute("data-copied")).toBe(false)
    expect(view.label(second!)).toBe("en:ui.message.copy")
    view.dispose()
  })
})
