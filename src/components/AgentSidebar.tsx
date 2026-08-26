import { Activity, Plus, Wifi, WifiOff, X } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { connectionKey, type AgentConnection, type RemoteConnection } from "../lib/agent-protocol";

export function AgentSidebar({
  agents,
  connectingSessions,
  connectedByKey,
  totalSessions,
  onConnectAgent,
  onDisconnectAgent,
  onRemoveAgent,
  onAddAgent,
}: {
  agents: AgentConnection[];
  connectingSessions: Set<string>;
  connectedByKey: Map<string, RemoteConnection>;
  totalSessions: number;
  onConnectAgent: (id: string) => void;
  onDisconnectAgent: (id: string) => void;
  onRemoveAgent: (id: string) => void;
  onAddAgent: () => void;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/20">
      <div className="border-b p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Agents
            </p>
            <p className="mt-1 font-semibold">{agents.length} configured</p>
          </div>
          <Badge variant="outline">{totalSessions}</Badge>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="mb-3 rounded-lg border bg-background p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {agent.identity?.deviceName ?? agent.endpoint}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {agent.endpoint}
                </p>
              </div>
              <div className="flex items-center gap-1.5" title={agent.status}>
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    agent.status === "Connected"
                      ? "bg-emerald-500"
                      : "bg-muted-foreground",
                  )}
                />
                {agent.status === "Connecting…" ||
                agent.status === "Reconnecting…" ? (
                  <Activity className="h-3.5 w-3.5" />
                ) : agent.status === "Connected" ? (
                  <Wifi className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {agent.sessions.length} session
                {agent.sessions.length === 1 ? "" : "s"}
              </span>
              <span>{agent.status}</span>
            </div>
            <div className="mt-2 flex gap-1">
              <Button
                className="flex-1"
                size="sm"
                variant="outline"
                disabled={
                  agent.status === "Connected" ||
                  agent.status === "Connecting…" ||
                  agent.status === "Reconnecting…" ||
                  !agent.token
                }
                onClick={() => onConnectAgent(agent.id)}
              >
                {agent.status === "Reconnecting…"
                  ? "Reconnecting…"
                  : "Connect"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={agent.status === "Disconnected"}
                onClick={() => onDisconnectAgent(agent.id)}
              >
                Disconnect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRemoveAgent(agent.id)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {agent.error && (
              <p className="mt-2 text-xs text-destructive">{agent.error}</p>
            )}
            {agent.sessions.map((session) => {
              const key = connectionKey(agent.id, session.sessionId);
              const connected = connectedByKey.has(key);
              const connecting = connectingSessions.has(key);
              return (
                <div
                  key={key}
                  className="mt-2 flex items-center justify-between rounded-md border px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">
                      {session.username}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Session {session.sessionId}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        session.state === "active"
                          ? "bg-emerald-500"
                          : "bg-muted-foreground",
                      )}
                    />
                    {connecting ? (
                      <Activity className="h-3 w-3" />
                    ) : connected ? (
                      <Wifi className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <WifiOff className="h-3 w-3 text-muted-foreground" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {!agents.length && (
          <div className="p-4 text-center text-sm text-muted-foreground">
            Add an MSM agent in Settings.
          </div>
        )}
      </div>
      <div className="border-t p-3">
        <Button className="w-full" variant="outline" onClick={onAddAgent}>
          <Plus className="h-4 w-4" /> Add agent
        </Button>
      </div>
    </aside>
  );
}
