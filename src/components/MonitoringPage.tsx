import { Monitor } from "lucide-react";
import {
  connectionKey,
  sessionMonitors,
  type AgentConnection,
  type RemoteConnection,
} from "../lib/agent-protocol";
import {
  SessionViewerCard,
  sessionViewerKey,
  type MonitoringActions,
} from "./SessionViewerCard";

export function MonitoringPage({
  agents,
  connectingSessions,
  connectedByKey,
  totalSessions,
  totalMonitors,
  fullscreenKey,
  fullscreenViewOnly,
  globalError,
  actions,
}: {
  agents: AgentConnection[];
  connectingSessions: Set<string>;
  connectedByKey: Map<string, RemoteConnection>;
  totalSessions: number;
  totalMonitors: number;
  fullscreenKey: string | null;
  fullscreenViewOnly: boolean;
  globalError: string;
  actions: MonitoringActions;
}) {
  const sessionRows = agents.flatMap((agent) =>
    agent.sessions.map((session) => ({
      agent,
      session,
      monitors: sessionMonitors(session),
    })),
  );
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
            {totalSessions} sessions · {totalMonitors} monitors. Each session
            preserves the Windows monitor layout and position.
          </p>
        </div>
        {globalError && (
          <div className="border-b bg-destructive/10 px-5 py-2.5 text-sm text-destructive">
            {globalError}
          </div>
        )}
        <section className="flex-1 p-5">
          {totalSessions === 0 ? (
            <div className="flex min-h-vh items-center justify-center rounded-xl border bg-muted/10 text-center">
              <div>
                <Monitor className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
                <p className="text-sm font-medium">
                  No remote sessions available
                </p>
              </div>
            </div>
          ) : (
            <div className="viewer-grid">
              {sessionRows.map(({ agent, session, monitors }) => {
                const key = sessionViewerKey(agent.id, session.sessionId);
                const remotes = new Map<number, RemoteConnection>();
                for (const monitor of monitors) {
                  const remote = connectedByKey.get(
                    connectionKey(agent.id, session.sessionId, monitor.index),
                  );
                  if (remote) remotes.set(monitor.index, remote);
                }
                return (
                  <SessionViewerCard
                    key={key}
                    agent={agent}
                    session={session}
                    monitors={monitors}
                    remotes={remotes}
                    connectingSessions={connectingSessions}
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
