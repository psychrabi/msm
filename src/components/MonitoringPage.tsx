import { memo, useEffect, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  Monitor,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { RemoteViewer } from "./RemoteViewer";
import { cn } from "../lib/utils";
import {
  connectionKey,
  type AgentConnection,
  type RemoteConnection,
} from "../lib/agent-protocol";

/** Fullscreen chrome appears when the cursor touches this many pixels
 *  from the top or bottom screen edge. Deliberately tiny so remote
 *  interactions near screen edges are not intercepted. */
const EDGE_BAR_PX = 2;

/** How long a revealed bar lingers after the cursor leaves its band. */
const EDGE_BAR_LINGER_MS = 1500;

/** Intent-level actions for the monitoring surface. Passed as one
 *  stable object (identity held by a ref in MultiAgentApp) so memoized
 *  viewer cards only re-render when their own data changes. */
export type MonitoringActions = {
  openFullscreen: (key: string) => void;
  closeFullscreen: () => void;
  setViewOnly: (viewOnly: boolean) => void;
  disconnectRemote: (agentId: string, sessionId: string) => void;
  startSession: (agentId: string, sessionId: string) => void;
  viewerError: (message: string) => void;
};

const SessionViewerCard = memo(function SessionViewerCard({
  agent,
  session,
  remote,
  connecting,
  isFullscreen,
  fullscreenViewOnly,
  actions,
}: {
  agent: AgentConnection;
  session: AgentConnection["sessions"][number];
  remote: RemoteConnection | undefined;
  connecting: boolean;
  isFullscreen: boolean;
  fullscreenViewOnly: boolean;
  actions: MonitoringActions;
}) {
  const key = connectionKey(agent.id, session.sessionId);
  // Fullscreen chrome auto-hide: bars appear only while the cursor is
  // inside a band at the top/bottom edge of the screen. Uses a native
  // window listener because noVNC grabs pointer events on its canvas,
  // which makes React synthetic events unreliable over the video.
  const [edgeBarVisible, setEdgeBarVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while the cursor is over a revealed bar; pauses the hide timer so
  // bars stay usable even though they sit outside the tiny trigger band.
  const overChromeRef = useRef(false);
  const clearHideTimer = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };
  const scheduleHide = () => {
    if (overChromeRef.current || hideTimerRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setEdgeBarVisible(false);
    }, EDGE_BAR_LINGER_MS);
  };
  useEffect(() => {
    if (!isFullscreen) return;
    // Capture phase: noVNC's canvas handlers may stopPropagation() on
    // bubbling mouse events, which would starve a normal window listener.
    const options = { capture: true, passive: true } as const;
    const onMove = (event: MouseEvent) => {
      if (event.clientY <= EDGE_BAR_PX) {
        clearHideTimer();
        setEdgeBarVisible(true);
      } else scheduleHide();
    };
    const onLeaveWindow = () => scheduleHide();
    window.addEventListener("mousemove", onMove, options);
    window.addEventListener("mouseout", onLeaveWindow, options);
    return () => {
      clearHideTimer();
      overChromeRef.current = false;
      setEdgeBarVisible(false);
      window.removeEventListener("mousemove", onMove, options);
      window.removeEventListener("mouseout", onLeaveWindow, options);
    };
  }, [isFullscreen]);
  const chromeHoverHandlers = {
    onMouseEnter: () => {
      overChromeRef.current = true;
      clearHideTimer();
    },
    onMouseLeave: () => {
      overChromeRef.current = false;
      scheduleHide();
    },
  };
  return (
    <Card
      key={key}
      className={cn(
        "group relative flex min-h-0 flex-col overflow-hidden",
        isFullscreen && "fixed inset-0 z-50 m-0 rounded-none border-0",
      )}
    >
      <CardHeader
        {...chromeHoverHandlers}
        className={cn(
          "absolute inset-x-0 top-0 z-30 flex-row items-center justify-between space-y-0 border-b border-white/10 bg-black/60 px-3 py-2 text-primary-foreground backdrop-blur-sm transition-opacity duration-200",
          isFullscreen
            ? edgeBarVisible
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
        )}
      >        <div className="min-w-0">
          <CardTitle className="truncate text-sm text-white">
            {session.username}
          </CardTitle>
          <p className="truncate text-[11px] text-white/60">
            {agent.identity?.deviceName ?? agent.endpoint} · Session{" "}
            {session.sessionId}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isFullscreen && remote && (
            <>
              <Label className="flex items-center gap-2 text-xs text-white">
                <Switch
                  checked={fullscreenViewOnly}
                  onCheckedChange={actions.setViewOnly}
                />
                {fullscreenViewOnly ? (
                  <Eye className="h-4 w-4" />
                ) : (
                  <EyeOff className="h-4 w-4" />
                )}
                View only
              </Label>
              <span className="hidden text-[10px] text-white/50 md:inline">
                Ctrl+Shift+V mode · Ctrl+Shift+F exits
              </span>
            </>
          )}
          {remote && !isFullscreen && (
            <Button
              variant="ghost"
              size="icon"
              className="hover:bg-white/15 hover:text-white"
              aria-label={`Fullscreen ${session.username}`}
              onClick={() => actions.openFullscreen(key)}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          )}
          {remote && (
            <Button
              variant="ghost"
              size="icon"
              className="hover:bg-white/15 hover:text-white"
              aria-label={`Disconnect ${session.username}`}
              onClick={() => actions.disconnectRemote(agent.id, session.sessionId)}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
          {isFullscreen && remote && (
            <Button
              variant="outline"
              size="sm"
              className="border-white/20 bg-transparent text-white hover:bg-white/15 hover:text-white"
              onClick={actions.closeFullscreen}
            >
              <Minimize2 className="h-4 w-4" /> Exit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent
        className={cn(
          "relative min-h-0 bg-black p-0 viewer-viewport",
          isFullscreen && "rounded-none viewer-fullscreen",
        )}
      >
        {remote ? (
          <RemoteViewer
            remote={remote}
            endpoint={agent.endpoint}
            token={agent.token}
            viewOnly={isFullscreen ? fullscreenViewOnly : true}
            onDisconnect={() => actions.disconnectRemote(agent.id, session.sessionId)}
            onError={actions.viewerError}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-black">
            <Button
              size="sm"
              disabled={agent.status !== "Connected" || connecting}
              onClick={() => actions.startSession(agent.id, session.sessionId)}
            >
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
});

export function MonitoringPage({
  agents,
  connectingSessions,
  connectedByKey,
  totalSessions,
  fullscreenKey,
  fullscreenViewOnly,
  globalError,
  actions,
}: {
  agents: AgentConnection[];
  connectingSessions: Set<string>;
  connectedByKey: Map<string, RemoteConnection>;
  totalSessions: number;
  fullscreenKey: string | null;
  fullscreenViewOnly: boolean;
  globalError: string;
  actions: MonitoringActions;
}) {
  return (
    <main className="min-w-0 flex-1 overflow-auto">
      <div className="flex min-h-full flex-col">
        <div className="border-b px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Monitoring
          </p>
          <h1 className="mt-1 text-xl font-semibold">Remote viewers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {agents.length} agent{agents.length === 1 ? "" : "s"} ·{" "}
            {totalSessions} sessions. Connect individual sessions from their
            viewer cards.
          </p>
        </div>
        {globalError && (
          <div className="border-b bg-destructive/10 px-5 py-2.5 text-sm text-destructive">
            {globalError}
          </div>
        )}
        <section className="flex-1 p-5">
          {totalSessions === 0 ? (
            <div className="flex min-h-90 items-center justify-center rounded-xl border bg-muted/10 text-center">
              <div>
                <Monitor className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
                <p className="text-sm font-medium">
                  No remote sessions available
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Connect an MSM agent to see its active sessions.
                </p>
              </div>
            </div>
          ) : (
            <div className="viewer-grid">
              {agents
                .flatMap((agent) =>
                  agent.sessions.map((session) => ({ agent, session })),
                )
                .map(({ agent, session }) => {
                  const key = connectionKey(agent.id, session.sessionId);
                  return (
                    <SessionViewerCard
                      key={key}
                      agent={agent}
                      session={session}
                      remote={connectedByKey.get(key)}
                      connecting={connectingSessions.has(key)}
                      isFullscreen={fullscreenKey === key}
                      fullscreenViewOnly={fullscreenViewOnly}
                      actions={actions}
                    />
                  );
                })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
