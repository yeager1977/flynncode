import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createResource, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createList } from "solid-list"

export interface FilteredListProps<T> {
  // `signal` aborts when a newer filter supersedes this one or the list is disposed.
  items: T[] | ((filter: string, signal: AbortSignal) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  groupBy?: (x: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: { category: string; items: T[] }, b: { category: string; items: T[] }) => number
  skipFilter?: (item: T) => boolean
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
  // Milliseconds of typing pause before the filter reaches `items`, for searches that hit the server.
  debounce?: number
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  // `filter` is what the user typed; `query` is what has been searched (after the debounce).
  const [store, setStore] = createStore<{ filter: string; query: string }>({ filter: "", query: "" })
  const search = {
    controller: undefined as AbortController | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  onCleanup(() => {
    clearTimeout(search.timer)
    search.controller?.abort()
  })

  type Group = { category: string; items: [T, ...T[]] }
  const empty: Group[] = []

  const [grouped, { refetch }] = createResource(
    () => {
      search.controller?.abort()
      const controller = new AbortController()
      search.controller = controller
      return {
        filter: store.query,
        items: typeof props.items === "function" ? props.items(store.query, controller.signal) : props.items,
      }
    },
    async ({ filter, items }) => {
      const query = filter ?? ""
      const needle = query.toLowerCase()
      const all = (await Promise.resolve(items)) || []
      const result = pipe(
        all,
        (x) => {
          if (!needle) return x
          const skipFilter = props.skipFilter
          const filterable = skipFilter ? x.filter((item) => !skipFilter(item)) : x
          const skipped = skipFilter ? x.filter(skipFilter) : []
          const filtered =
            !props.filterKeys && Array.isArray(filterable) && filterable.every((e) => typeof e === "string")
              ? (fuzzysort.go(needle, filterable).map((x) => x.target) as T[])
              : fuzzysort.go(needle, filterable, { keys: props.filterKeys! }).map((x) => x.obj)
          return skipped.length ? [...filtered, ...skipped] : filtered
        },
        groupBy((x) => (props.groupBy ? props.groupBy(x) : "")),
        entries(),
        map(([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v })),
        (groups) => (props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups),
      )
      return result
    },
    { initialValue: empty },
  )

  const flat = createMemo(() => {
    return pipe(
      grouped.latest || [],
      flatMap((x) => x.items),
    )
  })

  function initialActive() {
    if (props.noInitialSelection) return ""
    if (props.current) return props.key(props.current)

    const items = flat()
    if (items.length === 0) return ""
    return props.key(items[0])
  }

  const list = createList({
    items: () => flat().map(props.key),
    initialActive: initialActive(),
    loop: true,
  })

  const reset = () => {
    if (props.noInitialSelection) {
      list.setActive("")
      return
    }
    const all = flat()
    if (all.length === 0) return
    list.setActive(props.key(all[0]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const selectedIndex = flat().findIndex((x) => props.key(x) === list.active())
      const selected = flat()[selectedIndex]
      if (selected) props.onSelect?.(selected, selectedIndex)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()
        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })
        list.onKeyDown(navEvent)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      list.onKeyDown(event)
    }
  }

  createEffect(
    on(grouped, () => {
      reset()
    }),
  )

  const onInput = (value: string) => {
    clearTimeout(search.timer)
    setStore("filter", value)
    if (!props.debounce) {
      setStore("query", value)
      return
    }
    search.timer = setTimeout(() => setStore("query", value), props.debounce)
  }

  return {
    grouped,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => {
      clearTimeout(search.timer)
      setStore({ filter: "", query: "" })
    },
    onKeyDown,
    onInput,
    active: list.active,
    setActive: list.setActive,
  }
}
