import { useState } from "react";
import {
  Activity,
  CircleHelp,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
  Settings2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { RemoteViewer } from "./components/RemoteViewer";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { cn } from "./lib/utils";
import {
  connectionKey,
  gridColumns,
  isValidAgentIp,
} from "./lib/agent-protocol";
import { hasSavedAgents } from "./lib/agent-storage";
import { useAgentConnections } from "./hooks/useAgentConnections";
import "./styles.css";

export default function MultiAgentApp() {
  const {
    agents,
    remoteConnections,
    connectingSessions,
    globalError,
    setGlobalError,
    addAgent,
    connectAgent,
    disconnectAgent: disconnectAgentConnection,
    removeAgent,
    startRemoteSession,
    disconnectRemote: disconnectRemoteViewer,
  } = useAgentConnections();
  const [endpointInput, setEndpointInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [activePage, setActivePage] = useState<
    "monitoring" | "settings" | "about"
  >("monitoring");
  const [fullscreenKey, setFullscreenKey] = useState<string | null>(null);
  const [fullscreenViewOnly, setFullscreenViewOnly] = useState(true);

  function openFullscreen(key: string) {
    setFullscreenViewOnly(true);
    setFullscreenKey(key);
  }
  function closeFullscreen() {
    setFullscreenKey(null);
    setFullscreenViewOnly(true);
  }
  async function handleDisconnectAgent(id: string) {
    if (fullscreenKey?.startsWith(`${id}::`)) closeFullscreen();
    await disconnectAgentConnection(id);
  }
  function handleDisconnectRemote(agentIdValue: string, sessionId: string) {
    if (fullscreenKey === connectionKey(agentIdValue, sessionId))
      closeFullscreen();
    disconnectRemoteViewer(agentIdValue, sessionId);
  }
  async function handleAddAgent() {
    const ip = endpointInput.trim();
    const token = tokenInput.trim();
    if (!isValidAgentIp(ip) || !token) {
      setGlobalError("Enter a valid agent IP address and access token.");
      return;
    }
    const created = await addAgent(ip, token);
    if (created) {
      setEndpointInput("");
      setTokenInput("");
      setActivePage("monitoring");
    }
  }

  const connectedAgentCount = agents.filter(
    (agent) => agent.status === "Connected",
  ).length;
  const totalSessions = agents.reduce(
    (sum, agent) => sum + agent.sessions.length,
    0,
  );
  const connectedByKey = new Map(
    remoteConnections.map((remote) => [
      connectionKey(remote.agentId, remote.sessionId),
      remote,
    ]),
  );
  const savedAgentsPresent = hasSavedAgents();

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="relative flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Monitor className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold">MSM Viewer</p>
            <p className="text-[11px] text-muted-foreground">
              Remote workstation management
            </p>
          </div>
        </div>
        <nav className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
          <Button
            variant={activePage === "monitoring" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setActivePage("monitoring")}
          >
            <Activity className="h-4 w-4" /> Monitoring
          </Button>
          <Button
            variant={activePage === "settings" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setActivePage("settings")}
          >
            <Settings2 className="h-4 w-4" /> Settings
          </Button>
          <Button
            variant={activePage === "about" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setActivePage("about")}
          >
            <CircleHelp className="h-4 w-4" /> About
          </Button>
        </nav>
        <Badge
          variant={connectedAgentCount ? "default" : "outline"}
          className="gap-1.5"
        >
          {connectedAgentCount ? (
            <Wifi className="h-3 w-3" />
          ) : (
            <WifiOff className="h-3 w-3" />
          )}
          {connectedAgentCount} agent{connectedAgentCount === 1 ? "" : "s"}{" "}
          connected
        </Badge>
      </header>
      {activePage === "monitoring" && (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/20">
            <div className="border-b p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Agents
                  </p>
                  <p className="mt-1 font-semibold">
                    {agents.length} configured
                  </p>
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
                    <div
                      className="flex items-center gap-1.5"
                      title={agent.status}
                    >
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
                      onClick={() => void connectAgent(agent.id)}
                    >
                      {agent.status === "Reconnecting…"
                        ? "Reconnecting…"
                        : "Connect"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={agent.status === "Disconnected"}
                      onClick={() => void handleDisconnectAgent(agent.id)}
                    >
                      Disconnect
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void removeAgent(agent.id)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  {agent.error && (
                    <p className="mt-2 text-xs text-destructive">
                      {agent.error}
                    </p>
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
              <Button
                className="w-full"
                variant="outline"
                onClick={() => setActivePage("settings")}
              >
                <Plus className="h-4 w-4" /> Add agent
              </Button>
            </div>
          </aside>
          <main className="min-w-0 flex-1 overflow-auto">
            <div className="flex min-h-full flex-col">
              <div className="border-b px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Monitoring
                </p>
                <h1 className="mt-1 text-xl font-semibold">Remote viewers</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {agents.length} agent{agents.length === 1 ? "" : "s"} ·{" "}
                  {totalSessions} sessions. Connect individual sessions from
                  their viewer cards.
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
                        const remote = connectedByKey.get(key);
                        const connecting = connectingSessions.has(key);
                        const isFullscreen = fullscreenKey === key;
                        return (
                          <Card
                            key={key}
                            className={cn(
                              "flex min-h-0 flex-col overflow-hidden",
                              isFullscreen &&
                                "fixed inset-0 z-50 m-0 rounded-none border-0",
                            )}
                          >
                            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-3 py-2">
                              <div className="min-w-0">
                                <CardTitle className="truncate text-sm">
                                  {session.username}
                                </CardTitle>
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {agent.identity?.deviceName ?? agent.endpoint}{" "}
                                  · Session {session.sessionId}
                                </p>
                              </div>
                              <div className="flex items-center gap-1">
                                {remote && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Fullscreen ${session.username}`}
                                    onClick={() => openFullscreen(key)}
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
                                    onClick={() =>
                                      handleDisconnectRemote(
                                        agent.id,
                                        session.sessionId,
                                      )
                                    }
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                            </CardHeader>
                            <CardContent
                              className={cn(
                                "relative min-h-0 bg-black p-0 viewer-viewport",
                                isFullscreen &&
                                  "rounded-none viewer-fullscreen",
                              )}
                            >
                              {remote ? (
                                <RemoteViewer
                                  remote={remote}
                                  endpoint={agent.endpoint}
                                  token={agent.token}
                                  viewOnly={
                                    isFullscreen ? fullscreenViewOnly : true
                                  }
                                  onDisconnect={() =>
                                    handleDisconnectRemote(
                                      agent.id,
                                      session.sessionId,
                                    )
                                  }
                                  onError={setGlobalError}
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center bg-black">
                                  <Button
                                    size="sm"
                                    disabled={
                                      agent.status !== "Connected" || connecting
                                    }
                                    onClick={() =>
                                      void startRemoteSession(
                                        agent.id,
                                        session.sessionId,
                                        true,
                                      )
                                    }
                                  >
                                    {connecting ? "Connecting…" : "Connect"}
                                  </Button>
                                </div>
                              )}
                            </CardContent>
                            {isFullscreen && remote && (
                              <div className="absolute bottom-0 left-0 right-0 z-[60] flex items-center justify-between border-t bg-background/95 px-4 py-3 backdrop-blur">
                                <div className="text-sm">
                                  <span className="font-medium">
                                    {session.username}
                                  </span>
                                  <span className="ml-2 text-muted-foreground">
                                    {agent.identity?.deviceName ??
                                      agent.endpoint}{" "}
                                    · Session {session.sessionId}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <Label className="flex items-center gap-2 text-sm">
                                    <Checkbox
                                      checked={fullscreenViewOnly}
                                      onCheckedChange={(
                                        checked: boolean | "indeterminate",
                                      ) =>
                                        setFullscreenViewOnly(checked === true)
                                      }
                                    />
                                    {fullscreenViewOnly ? (
                                      <Eye className="h-4 w-4" />
                                    ) : (
                                      <EyeOff className="h-4 w-4" />
                                    )}{" "}
                                    View only
                                  </Label>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={closeFullscreen}
                                  >
                                    <Minimize2 className="h-4 w-4" /> Exit
                                    fullscreen
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      handleDisconnectRemote(
                                        agent.id,
                                        session.sessionId,
                                      )
                                    }
                                  >
                                    <X className="h-4 w-4" /> Disconnect
                                  </Button>
                                </div>
                              </div>
                            )}
                          </Card>
                        );
                      })}
                  </div>
                )}
              </section>
            </div>
          </main>
        </div>
      )}
      {activePage === "settings" && (
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-4xl p-6">
            <div className="mb-6">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Settings
              </p>
              <h1 className="mt-1 text-2xl font-semibold">Agents</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Add multiple MSM agents. Enter the agent's IP address and access
                token. Agents are always remembered and reconnect automatically.
              </p>
            </div>
            <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
              <Card>
                <CardHeader>
                  <CardTitle>Add agent</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="agent-ip">Agent IP address</Label>
                    <Input
                      id="agent-ip"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="192.168.1.10"
                      value={endpointInput}
                      onChange={(event) => setEndpointInput(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="agent-token">Access token</Label>
                    <Input
                      id="agent-token"
                      type="password"
                      value={tokenInput}
                      onChange={(event) => setTokenInput(event.target.value)}
                    />
                  </div>
                  <Button
                    className="w-full"
                    onClick={() => void handleAddAgent()}
                    disabled={
                      !isValidAgentIp(endpointInput) || !tokenInput.trim()
                    }
                  >
                    <Plus className="h-4 w-4" /> Add and connect
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Configured agents</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {agents.length ? (
                    agents.map((agent) => (
                      <div key={agent.id} className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {agent.identity?.deviceName ?? agent.endpoint}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {agent.endpoint}
                            </p>
                          </div>
                          <Badge
                            variant={
                              agent.status === "Connected"
                                ? "default"
                                : "outline"
                            }
                          >
                            {agent.status}
                          </Badge>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              agent.status === "Connected" || !agent.token
                            }
                            onClick={() => void connectAgent(agent.id)}
                          >
                            Connect
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={agent.status !== "Connected"}
                            onClick={() => void handleDisconnectAgent(agent.id)}
                          >
                            Disconnect
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void removeAgent(agent.id)}
                          >
                            Forget
                          </Button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      No agents configured.
                    </p>
                  )}
                  {savedAgentsPresent && (
                    <p className="pt-2 text-xs text-muted-foreground">
                      Configured agents are restored from the native credential
                      store on startup.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </main>
      )}
      {activePage === "about" && (
        <main className="flex flex-1 items-center justify-center p-6">
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle>MSM Viewer</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <div className="flex justify-between border-b pb-3">
                <span className="text-muted-foreground">Agents</span>
                <span>{agents.length}</span>
              </div>
              <div className="flex justify-between border-b pb-3">
                <span className="text-muted-foreground">Connected</span>
                <span>{connectedAgentCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Remote viewers</span>
                <span>{remoteConnections.length}</span>
              </div>
            </CardContent>
          </Card>
        </main>
      )}
    </div>
  );
}
