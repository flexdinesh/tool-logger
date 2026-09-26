import { HardDrive, Pause, Play, TerminalSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useViewerActions, useViewerState } from "../state/viewer-context.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

export function Layout({ children }: { children: ReactNode }) {
  const { harnessList, live, selectedCallId } = useViewerState();
  const { toggleLive } = useViewerActions();
  return <>
    <header className="topbar">
      <a className="brand" href="/" aria-label="Tool Logger home"><span className="brand-mark"><TerminalSquare aria-hidden="true" /></span>tool logger</a>
      <div className="topbar-actions">
        <Badge id="demo" variant="warning" hidden={!harnessList?.demo}>TEST DATA</Badge>
        <span className="local-label"><HardDrive aria-hidden="true" /> Local logs</span>
        <Button id="live" variant="outline" size="compact" aria-pressed={live} onClick={toggleLive}>
          <span className={live ? "live-dot live-on" : "live-dot live-off"} />
          <span id="live-label">{live ? "Live updates" : "Updates paused"}</span>
          {live ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </Button>
        <ThemeToggle />
      </div>
    </header>
    <main className={selectedCallId ? "workspace inspector-open" : "workspace"}>{children}</main>
  </>;
}
