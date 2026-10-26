import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { Button } from "@flynncode/ui/button"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import {
  formatElapsed,
  runningCount,
  shellElapsed,
  useBackgroundShells,
  type ShellEntry,
} from "@/hooks/use-background-shells"
import { showToast } from "@/utils/toast"

export function BackgroundShellsSection(props: { sessionID: () => string }) {
  const language = useLanguage()
  const store = useBackgroundShells(() => props.sessionID() || undefined)
  const [now, setNow] = createSignal(Date.now())

  const running = createMemo(() => runningCount(store.shells()))
  const ordered = createMemo(() =>
    store.shells().toSorted((a, b) => Number(b.status === "running") - Number(a.status === "running")),
  )
  // Rows are keyed by id string and read their entry through the map, so a
  // live update never remounts a row and drops its expanded or in-flight state.
  const ids = createMemo(() => ordered().map((item) => item.id))
  const byID = createMemo(() => new Map(store.shells().map((item) => [item.id, item])))

  createEffect(() => {
    if (running() === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={ids().length > 0}>
      <div class="flex flex-col gap-2 p-2 pb-0 text-12-regular text-text-base" data-component="background-shells">
        <div class="text-text-weak">
          {language.t("session.shells.title")} {running()}/{ids().length}
        </div>
        <For each={ids()}>
          {(id) => (
            <Row
              entry={() => byID().get(id)}
              now={now}
              loadTail={() => store.loadTail(id)}
              stop={() => store.stop(id)}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

function Row(props: {
  entry: () => ShellEntry | undefined
  now: () => number
  loadTail: () => Promise<void>
  stop: () => Promise<boolean>
}) {
  return <Show when={props.entry()}>{(shell) => <RowBody shell={shell} {...props} />}</Show>
}

function RowBody(props: {
  shell: () => ShellEntry
  now: () => number
  loadTail: () => Promise<void>
  stop: () => Promise<boolean>
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const [expanded, setExpanded] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [opening, setOpening] = createSignal(false)
  const [pinned, setPinned] = createSignal(true)
  let scroller: HTMLPreElement | undefined

  const running = () => props.shell().status === "running"
  const canOpen = () =>
    platform.platform === "desktop" && !!platform.openPath && server.isLocal() && !!props.shell().outputPath
  const status = () => {
    const shell = props.shell()
    if (shell.status === "running") return language.t("session.shells.status.running")
    if (shell.status === "killed") return language.t("session.shells.status.killed")
    if (shell.status === "timed_out") return language.t("session.shells.status.timedOut")
    if (shell.exitCode === undefined || shell.exitCode === 0) return language.t("session.shells.status.exited")
    return language.t("session.shells.status.exitedCode", { code: shell.exitCode })
  }

  createEffect(
    on(expanded, (open) => {
      if (open) void props.loadTail()
    }),
  )

  createEffect(
    on(
      () => props.shell().tail,
      () => {
        if (!scroller || !pinned()) return
        scroller.scrollTop = scroller.scrollHeight
      },
    ),
  )

  const stop = async () => {
    if (stopping()) return
    setStopping(true)
    const ok = await props.stop()
    setStopping(false)
    if (!ok) showToast({ title: language.t("session.shells.stop.failed") })
  }

  const openOutput = async () => {
    const open = platform.openPath
    if (opening() || !open) return
    setOpening(true)
    await open(props.shell().outputPath).catch(() => showToast({ title: language.t("session.shells.open.failed") }))
    setOpening(false)
  }

  return (
    <div
      class="flex flex-col gap-1 rounded-md border border-border-weak-base bg-v2-background-bg-layer-02 px-2 py-1.5"
      data-action="background-shell-row"
      data-status={props.shell().status}
    >
      <div class="truncate font-mono text-text-strong" title={props.shell().command}>
        <bdi dir="ltr">{props.shell().command}</bdi>
      </div>
      <div class="text-text-weak">
        <bdi dir="ltr">{props.shell().id}</bdi>
        {" · "}
        {status()}
        {" · "}
        {formatElapsed(shellElapsed(props.shell(), props.now()))}
      </div>
      <div class="flex flex-wrap gap-1">
        <Button
          type="button"
          size="small"
          variant="ghost"
          aria-expanded={expanded()}
          data-action="background-shell-output"
          onClick={() => setExpanded(!expanded())}
        >
          {expanded() ? language.t("session.shells.output.hide") : language.t("session.shells.output.show")}
        </Button>
        <Show when={running()}>
          <Button
            type="button"
            size="small"
            variant="ghost"
            data-action="background-shell-stop"
            disabled={stopping()}
            onClick={() => void stop()}
          >
            {stopping() ? language.t("session.shells.stopping") : language.t("session.shells.stop")}
          </Button>
        </Show>
        <Show when={canOpen()}>
          <Button
            type="button"
            size="small"
            variant="ghost"
            data-action="background-shell-open"
            disabled={opening()}
            onClick={() => void openOutput()}
          >
            {language.t("session.shells.openOutput")}
          </Button>
        </Show>
      </div>
      <Show when={expanded()}>
        <pre
          ref={scroller}
          dir="ltr"
          tabIndex={0}
          class="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-v2-background-bg-base p-1.5 font-mono text-11-regular text-text-base"
          onScroll={(event) =>
            setPinned(
              event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 24,
            )
          }
        >
          {props.shell().tail || language.t("session.shells.output.empty")}
        </pre>
      </Show>
    </div>
  )
}
