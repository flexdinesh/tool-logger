# Tool Logger

Platform: native Linux/macOS, MyGo UI in Go.

Developers observe Codex/OpenCode tool activity across local processes, SSH hosts and containers. The source sidebar scopes a searchable call table, metrics/charts and right inspector. Retain Graphite light/dark identity and native keyboard behavior.

The app owns HTTP/SQLite; UI uses REST exclusively. Plugins journal complete payloads; supervised Node workers deliver authenticated HTTP. Window close leaves ingestion running until Quit.

Single user, full retention, no automatic deletion. Source UUID defines identity; hostname/container labels aid recognition. Private-network access is explicit. Source write tokens cannot query/administer.

Success: quickly find a call and understand its observed lifecycle/original evidence without inferring success from result presence. Loading, empty, offline, rejection and retry states stay actionable. Keyboard focus, selectable JSON, system theme, resizing, accessible labels and reduced motion matter. Track parity in docs/native-parity.md.
