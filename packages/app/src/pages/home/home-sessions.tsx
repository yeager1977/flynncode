import type { HomeScrollController } from "./home-scroll-controller"
import type { HomeSessionSearchController } from "./home-session-search-controller"
import type { HomeSessionsController } from "./home-sessions-controller"
import { HomeSessionsView } from "./home-sessions-view"

export function HomeSessions(props: {
  sessions: HomeSessionsController
  search: HomeSessionSearchController
  scroll: HomeScrollController
}) {
  return (
    <HomeSessionsView
      language={props.sessions.copy.language}
      groups={props.sessions.data.groups}
      showProjectName={props.sessions.session.showProjectName}
      server={props.sessions.session.server}
      canCreateSession={props.sessions.session.canCreate}
      searchValue={props.search.query.value}
      searchPlaceholder={props.search.query.placeholder}
      searchOpen={props.search.query.open}
      searchLoading={props.search.result.loading}
      searchResults={props.search.result.list}
      searchActive={props.search.result.active}
      searchNoResultsLabel={props.search.result.noResultsLabel}
      titleOpacity={props.scroll.header.titleOpacity}
      isOpenTab={props.sessions.tab.isOpen}
      onCreateSession={props.sessions.session.create}
      onOpenSession={props.sessions.session.open}
      onArchiveSession={props.sessions.session.archive}
      onSetHoverTarget={props.scroll.viewport.setHoverTarget}
      onSetThumbTrack={props.scroll.viewport.setThumbTrack}
      onSetContent={props.scroll.header.setContent}
      onSetHeader={props.scroll.header.setHeader}
      onWheel={props.scroll.viewport.containWheel}
      onSetSearchRoot={props.search.element.setRoot}
      onSetSearchInput={props.search.element.setInput}
      onSetSearchList={props.search.element.setList}
      onSearchFocus={props.search.query.focus}
      onSearchInput={props.search.query.input}
      onSearchClose={props.search.query.close}
      onSearchMove={props.search.result.move}
      onSearchSelectActive={props.search.result.selectActive}
      onSearchHighlight={props.search.result.highlight}
      onSearchSelect={props.search.result.select}
      selecting={props.sessions.select.active}
      busy={props.sessions.select.busy}
      selectedCount={props.sessions.select.count}
      rowSelected={props.sessions.select.selected}
      rowLocked={props.sessions.select.locked}
      onToggleSelect={props.sessions.select.toggleMode}
      onSelectAll={props.sessions.select.selectAll}
      onArchiveSelected={props.sessions.select.archive}
      onDeleteSelected={props.sessions.select.remove}
      onCancelSelect={props.sessions.select.cancel}
      onBulkCleanup={props.sessions.select.cleanup}
      onToggleRow={props.sessions.select.toggle}
      onClearSelect={props.sessions.select.cancel}
    />
  )
}
