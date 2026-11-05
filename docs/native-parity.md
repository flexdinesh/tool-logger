# UI parity acceptance

The React/Graphite interface replaces MyGo native widgets. One frontend serves the MyGo webview and ordinary local browsers. Existing SQLite, ingestion and source identity contracts remain intact. Browser phone layouts are restored; MyGo retains its Linux/macOS desktop lifecycle.

Browser evidence lives in `apps/web/tests/browser/viewer.spec.ts` and runs against the CLI's loopback gateway, independent collector and temporary SQLite. Unit evidence lives in `apps/web/tests/frontend.test.ts`; HTTP/session evidence in `packages/webui/*test.go`.

| Behavior | Replacement evidence |
| --- | --- |
| Browser login, source-token rejection, cleared token field, expiry and logout | browser auth rejects source tokens, clears submitted password, expires and logs out; TestSessionLifecycleAndSourceCredentials; TestSessionExpiryAndCapacity |
| Source create/edit/configuration, token rotation/revocation and retained history | source create, configuration, edit, rotate and revoke use the real admin API; TestAPIAdministrationAndETag |
| Combined/per-harness scope and independent source grouping | source and harness multi-selection sends repeated independent scopes |
| Every search/status/tool/session/agent/repo/directory/time filter and reset | every filter, missing selected facets, URL history and reset remain usable; OpenCode outcome and agent filters preserve explicit failure evidence |
| Unique cursor pages with stable time bounds and virtualized rows | cursor paging holds time bounds, deduplicates and really virtualizes loaded rows; paging deduplicates by source identity and holds the exact request window |
| Awaiting call completes, leaves filter and updates its inspector | live completion leaves an awaiting scope while its open inspector updates |
| Live time windows expire rows; custom UTC bounds remain fixed | live relative time windows expire old rows while custom UTC filters stay fixed |
| Pause freezes activity, preserves current-scope selection and resumes | pause cancels activity updates, supports current-scope selection and resumes live |
| Detail failure/retry independent of healthy activity | detail failure remains independent of healthy polls and has explicit retry |
| Activity retry while paused preserves pending detail | activity failure and paused retry preserve a pending detail request |
| Discovery failure and retry | discovery failure exposes retry and recovers without a page reload |
| Late detail cannot overwrite newer source-scoped selection | stale detail completion cannot replace a newer source-scoped selection |
| Inspector tabs, literal original payloads, Git evidence and JSON copy | inspector has all evidence tabs, preserves text, copies payload and follows keyboard rows |
| System/light/dark themes, saved panes/columns and optional charts | phone browser restores Graphite, keyboard search and full-width accessible inspector; panes and columns resize by keyboard, persist, and charts toggle |
| Desktop inspector follows successive calls; phone modal contains focus | inspector has all evidence tabs, preserves text, copies payload and follows keyboard rows; phone browser restores Graphite, keyboard search and full-width accessible inspector |
| URLs/back/forward, legacy native links and desktop menu commands | every filter, missing selected facets, URL history and reset remain usable; unknown harness links recover to all harnesses within the selected source; desktop commands and legacy deep links are installed before readiness; TestCommandsAndDeepLinksValidateBeforeDispatch; TestEventDeliveryWaitsForFrontendReadinessAndPreservesLiteralDetail |
| Per-client preferences and compatible native migration | native preferences migrate scopes, theme, time, inspector and column layout; MyGo uses validated shell preferences and exposes Quit without browser storage; TestPreferencesMigrationPreservesNativeFile |
| Startup preference failure exposes recovery | unknown bridge preference values expose startup recovery |
| UI origin/session isolation, no ingestion proxy or credential forwarding | TestHostOriginAndSessionIsolation; TestProxyCredentialAndHeaderBoundary; TestEmbeddedAssetsAndPathBoundaries |
| Headless CLI owns an independent collector; browser exit leaves it running | TestHeadlessCLIConcurrentStartupBrowserAndCollectorLifetimes; TestCollectorProcessConcurrentStartupDurableDeliveryAndShutdown |
| Packaging binding generation never opens user state, listeners or a display | TestBindingGenerationDoesNotOpenStateOrListeners |
| Native close/activation retain collection; Quit stops only UI | TestDesktopQuitLeavesCollectorRunning, opt-in e2e on a desktop/display-equipped CI runner |
| Local and remote windows isolate profiles, credentials and histories | TestDesktopConnectionsKeepNativeProfilesAndHistoriesSeparate; TestRemoteCommandConnectAndPinnedBrowserUseIndependentHistory; TestPinnedRemoteGatewayRevocationAndConnectionIsolation |

Local verification uses headless browsers, real HTTP/SQLite, Go race/vet and available MyGo smoke checks. Native rendering, tray/Dock behavior and real window lifecycle require a display and platform webview. This development machine lacks them; a skipped process test is not a pass. Linux/macOS CI installs the required dependencies and runs process automation plus platform packaging. Cross-compilation does not establish another platform's runtime behavior.
