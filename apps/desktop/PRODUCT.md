# Tool Logger

Platform: MyGo webview on Linux/macOS and ordinary local browsers, React/Graphite UI.

Developers observe Codex/OpenCode tool activity across local processes, SSH hosts and containers. The source sidebar scopes a searchable call table, metrics/charts and right inspector. Retain Graphite light/dark identity, desktop keyboard behavior and responsive browser layouts.

The app owns HTTP/SQLite; UI data uses REST exclusively. A separate loopback UI server authenticates browser sessions; the MyGo shell owns window/menu lifecycle and desktop preferences. Plugins journal complete payloads; supervised Node workers deliver authenticated HTTP. Window close leaves ingestion running until Quit. Browser tab close/logout leaves ingestion running.

Single user, full retention, no automatic deletion. Source UUID defines identity; hostname/container labels aid recognition. Private-network access is explicit. Source write tokens cannot query/administer.

Success: quickly find a call and understand its observed lifecycle/original evidence without inferring success from result presence. Loading, empty, offline, rejection and retry states stay actionable. Keyboard focus, selectable JSON, system theme, resizing, accessible labels and reduced motion matter. Preferences belong to each client; MyGo seeds compatible native preferences while preserving the original file. Track parity in docs/native-parity.md.
