import React from "react";
import { TableViewer } from "./components/TableViewer";
import { PipelineBar } from "./components/PipelineBar";
import { Tooltip } from "./components/Overlays/Tooltip";
import { JumpToRow } from "./components/Overlays/JumpToRow";
import { CellContextMenu } from "./components/CellContextMenu";
import { ColumnContextMenu } from "./components/ColumnContextMenu";
import { CommandPalette } from "./components/CommandPalette";
import { LandmarkPanel } from "./components/Overlays/LandmarkPanel";
import { BookmarkPanel } from "./components/Overlays/BookmarkPanel";
import { KeyboardShortcutsPanel } from "./components/Overlays/KeyboardShortcutsPanel";
import { StatusBar } from "./components/StatusBar";
import { SearchBar } from "./components/Toolbar/SearchBar";
import { ZoomControls } from "./components/Toolbar/ZoomControls";
import { LayerToggle } from "./components/Toolbar/LayerToggle";
import { SourceManagerLite } from "./components/SourceManager/SourceManagerLite";
import { useUiStore } from "./stores/ui";
import { useTableStore } from "./stores/table";
import "./styles.css";

class TableErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: 8, color: "#6b7280" }}>
          <span style={{ fontSize: 14 }}>Something went wrong rendering the table.</span>
          <button
            onClick={() => this.setState({ hasError: false })}
            style={{ fontSize: 12, padding: "4px 12px", border: "1px solid #e5e7eb", borderRadius: 4, cursor: "pointer", background: "white" }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function LogoMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect width="20" height="20" rx="4.5" fill="#1e40af" />
      <rect x="3.5" y="4" width="13" height="2.5" rx="1.25" fill="white" />
      <rect x="3.5" y="8.75" width="13" height="2" rx="1" fill="white" fillOpacity="0.65" />
      <rect x="3.5" y="13.5" width="13" height="2" rx="1" fill="white" fillOpacity="0.35" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <ellipse cx="6.5" cy="3.25" rx="4" ry="1.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M2.5 3.25v6.5c0 .97 1.79 1.75 4 1.75s4-.78 4-1.75V3.25" stroke="currentColor" strokeWidth="1.25" fill="none" />
      <path d="M2.5 7c0 .97 1.79 1.75 4 1.75S10.5 7.97 10.5 7" stroke="currentColor" strokeWidth="1.25" fill="none" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <circle cx="6.5" cy="6.5" r="2.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M6.5 1v1.5M6.5 10.5V12M1 6.5h1.5M10.5 6.5H12M2.9 2.9l1.05 1.05M9.05 9.05l1.05 1.05M2.9 10.1l1.05-1.05M9.05 3.95l1.05-1.05" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M11 7A5 5 0 1 1 6 2a4 4 0 0 0 5 5z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AppLite() {
  const toggleSourceManager = useUiStore((s) => s.toggleSourceManager);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const isDark = useUiStore((s) => s.isDark);
  const setShowKeyboardShortcuts = useUiStore((s) => s.setShowKeyboardShortcuts);
  const source = useTableStore((s) => s.source);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        background: "var(--c-surface)",
        color: "var(--c-text)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          height: 40,
          background: "var(--c-bg)",
          borderBottom: "1px solid var(--c-border)",
          flexShrink: 0,
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <LogoMark />
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--c-text)", letterSpacing: "-0.3px" }}>
            Tableverse
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "1px 6px",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              background: "var(--c-accent-bg)",
              color: "var(--c-accent)",
              borderRadius: 4,
              border: "1px solid var(--c-accent-border)",
            }}
          >
            Lite
          </span>
          <span style={{ color: "var(--c-border)", fontSize: 16, fontWeight: 300, margin: "0 1px", userSelect: "none" }}>/</span>
          {source ? (
            <button className="tv-btn" onClick={toggleSourceManager} style={{ maxWidth: 260 }}>
              <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#22c55e", flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{source.name}</span>
            </button>
          ) : (
            <button className="tv-btn" onClick={toggleSourceManager}>
              <DatabaseIcon />
              Open file
            </button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SearchBar />
          <ZoomControls />
          <LayerToggle />
          <a
            href="https://github.com/tableverse-labs/tableverse"
            target="_blank"
            rel="noopener noreferrer"
            className="tv-btn tv-btn-ghost tv-github-star"
            title="Star us on GitHub"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ color: "#f59e0b" }}>
              <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.873 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/>
            </svg>
            Star
          </a>
          <button className="tv-btn tv-btn-ghost" onClick={toggleTheme} title={isDark ? "Switch to light mode" : "Switch to dark mode"}>
            {isDark ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            className="tv-btn tv-btn-ghost"
            onClick={() => setShowKeyboardShortcuts(true)}
            title="Keyboard shortcuts (?)"
            style={{ fontWeight: 600, fontSize: 13, minWidth: 26 }}
          >
            ?
          </button>
        </div>
      </header>

      <PipelineBar />

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <TableErrorBoundary>
          <TableViewer />
        </TableErrorBoundary>
      </div>

      <StatusBar />

      <Tooltip />
      <JumpToRow />
      <SourceManagerLite />
      <CellContextMenu />
      <ColumnContextMenu />
      <CommandPalette />
      <LandmarkPanel />
      <BookmarkPanel />
      <KeyboardShortcutsPanel />
    </div>
  );
}
