# Native parity acceptance

The removed web viewer's behavior is preserved in native terms. Source setup/health adds distributed ingestion scope. Browser-only responsive phone layouts are replaced by the approved Linux/macOS desktop layout.

| Previous behavior | Native evidence |
| --- | --- |
| Combined/per-harness views | TestNativeCollectionInspectorAndCopy; TestNativeProductionRESTBoundary |
| Source grouping | Source sidebar, real source-scoped backend tests and REST integration |
| Search/status/tool/session/agent/repo/directory/time filters and reset | TestFilterWidgetsSendEveryFilterAndKeepMissingFacet; TestNativeFiltersHistoryPagingAndPause |
| Unique cursor pages and time-window stability | TestTimePagingFreezesWindowAndLiveRefreshExpiresRows; SQLite cursor tests |
| Awaiting call becomes completed, disappears from filter, inspector updates | TestLiveFilterRetainsInspectorWhenRowLeavesScope |
| Expiring time-window calls | TestTimePagingFreezesWindowAndLiveRefreshExpiresRows |
| Current-scope selection while paused | TestStableRowsSelectionAndPauseFreeze |
| Detail failure/retry independent of healthy activity | TestDetailErrorsRetryAndStaleSelection |
| Activity retry while paused | TestPausedActivityRetryKeepsDetailPending |
| Discovery failure/onboarding/retry | TestDiscoveryRetryAndOnboarding |
| Activity failure preserves pending details | TestPausedActivityRetryKeepsDetailPending |
| Late responses cannot overwrite selection | TestDetailErrorsRetryAndStaleSelection |
| Inspector tabs, raw payload text and JSON copy | TestNativeCollectionInspectorAndCopy |
| Git snapshots/native metadata | TestNativeCollectionInspectorAndCopy; harness adapter tests |
| Theme follows system and saves explicit choice | TestThemeSystemPreferenceAndVirtualization |
| Desktop inspector follows successive rows | TestNativeCollectionInspectorAndCopy; TestNativeSplitterKeyboardAndPreferenceSnapshotIsolation |
| Live/pause collection semantics | TestStableRowsSelectionAndPauseFreeze |
| Filtered empty state/recovery | Native view tests and production REST boundary |
| Browser URL/filter navigation | TestFilterAndWindowPreferencesDeepLinks; native activity links/back/forward |
| Native source creation/configuration/token lifecycle | TestSourceSetupUsesHTTPAndCopiesConfiguration; actual HTTP credential tests |
| Window close retains ingestion, reopen, explicit Quit | TestNativeProcessHTTPIngestionAndAutomation through real native process |
| Composed executable owns server/window lifetime and reaches live visibility target | TestComposedAppOwnsServerThroughWindowCloseAndQuit builds the actual CLI, ingests over HTTP, verifies native evidence within two seconds, retains HTTP through close, and closes HTTP on Quit |

Verification during rebuild: Go race suite and MyGo vet passed; built native process automation passed on Linux using a virtual X display with the application running on the host. Linux platform packaging passed. macOS execution is delegated to the committed macOS CI job and must not be represented as locally verified.
