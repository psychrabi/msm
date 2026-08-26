import { memo } from "react";
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
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { RemoteViewer } from "./RemoteViewer";
import { cn } from "../lib/utils";
import {
  connectionKey,
  gridColumns,
  type AgentConnection,
  type RemoteConnection,
} from "../lib/agent-protocol";

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
  return (
    <Card
      key={key}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        isFullscreen && "fixed inset-0 z-50 m-0 rounded-none border-0",
      )}
    >
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-3 py-2">
        <div className="min-w-0">
          <CardTitle className="truncate text-sm">{session.username}</CardTitle>
          <p className="truncate text-[11px] text-muted-foreground">
            {agent.identity?.deviceName ?? agent.endpoint} · Session{" "}
            {session.sessionId}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {remote && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Fullscreen ${session.username}`}
              onClick={() => actions.openFullscreen(key)}
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </Button>
          )}
          {remote && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Disconnect ${session.username}`}
              onClick={() => actions.disconnectRemote(agent.id, session.sessionId)}
            >
              <X className="h-4 w-4" />
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
      {isFullscreen && remote && (
        <div className="absolute bottom-0 left-0 right-0 z-[60] flex items-center justify-between border-t bg-background/95 px-4 py-3 backdrop-blur">
          <div className="text-sm">
            <span className="font-medium">{session.username}</span>
            <span className="ml-2 text-muted-foreground">
              {agent.identity?.deviceName ?? agent.endpoint} · Session{" "}
              {session.sessionId}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={fullscreenViewOnly}
                onCheckedChange={(checked: boolean | "indeterminate") =>
                  actions.setViewOnly(checked === true)
                }
              />
              {fullscreenViewOnly ? (
                <Eye className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4" />
              )}{" "}
              View only
            </Label>
            <Button variant="outline" size="sm" onClick={actions.closeFullscreen}>
              <Minimize2 className="h-4 w-4" /> Exit fullscreen
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions.disconnectRemote(agent.id, session.sessionId)}
            >
              <X className="h-4 w-4" /> Disconnect
            </Button>
          </div>
        </div>
      )}
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
            <div className="flex min-h-[360px] items-center justify-center rounded-xl border bg-muted/10 text-center">
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
            <div
              className={cn(
                "grid auto-rows-min gap-4",
                gridColumns(totalSessions),
              )}
            >
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
