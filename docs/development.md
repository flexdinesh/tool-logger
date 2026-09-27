# Development

Run the viewer with live frontend reload and synthetic tool-call data:

```sh
pnpm --filter viewer dev
```

Defaults: `HOST=127.0.0.1`, `PORT=4317`. Bind all IPv4 interfaces or change the port:

```sh
HOST=0.0.0.0 PORT=4318 pnpm --filter viewer dev
```

Startup prints the viewer URL; `HOST=0.0.0.0` prints every IPv4 interface URL.
On Linux/macOS, it automatically opens the browser unless `SSH_CONNECTION` or
`SSH_TTY` is set. These environment variables also configure `pnpm --filter viewer start`.

The viewer exposes unredacted tool inputs and results; use LAN access only on a
trusted network.
