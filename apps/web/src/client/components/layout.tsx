import { ArrowLeft, ArrowRight, Link, Pause, Play, TerminalSquare } from "lucide-react";
import type { ReactNode, CSSProperties } from "react";
import { useViewerActions, useViewerState } from "../state/viewer-context.ts";
import { usePreferences } from "../preferences.tsx";
import { SessionAction } from "../session.tsx";
import { Button } from "./ui/button.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";
import { SourceSidebar } from "./sources.tsx";
import { Splitter } from "./splitter.tsx";
export function Layout({ children }: { children: ReactNode }) {
  const { live, selectedCallId, notice } = useViewerState();
  const { toggleLive, back, forward, copyLink } = useViewerActions();
  const { preferences, updatePreferences, preferencesError } = usePreferences();
  const style: CSSProperties & { "--sidebar-width": string; "--inspector-width": string } = {
    "--sidebar-width": preferences.sidebar + "px",
    "--inspector-width": "max(300px, " + (100 - preferences.collection) + "vw)",
  };
  return <div className="app-shell" style={style}>
    <header className="topbar"><a className="brand" href="/" aria-label="Tool Logger home"><span className="brand-mark"><TerminalSquare aria-hidden="true" /></span>tool logger</a>
      <nav className="topbar-actions" aria-label="Activity controls">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={back}><ArrowLeft aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" aria-label="Forward" onClick={forward}><ArrowRight aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" aria-label="Copy activity link" onClick={copyLink}><Link aria-hidden="true" /></Button>
        <Button id="live" variant="outline" size="compact" aria-pressed={live} onClick={toggleLive}><span className={live ? "live-dot live-on" : "live-dot live-off"} /><span id="live-label">{live ? "Live updates" : "Updates paused"}</span>{live ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</Button>
        <ThemeToggle /><SessionAction />
      </nav>
    </header>
    <div className="shell-body"><SourceSidebar /><Splitter label="Sidebar width" value={preferences.sidebar} min={160} max={360} onChange={(sidebar) => updatePreferences({ sidebar })} />
      <main className={selectedCallId ? "workspace inspector-open" : "workspace"}>{preferencesError && <p role="alert" className="connection-notice">{preferencesError}</p>}{notice && <p role="status" className="copy-notice">{notice}</p>}{children}</main>
    </div>
  </div>;
}
