import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  register,
  unregisterAll,
} from "@tauri-apps/plugin-global-shortcut";
import { isValidAgentIp } from "./lib/agent-protocol";
import { hasSavedAgents } from "./lib/agent-storage";
import { useAgentConnections } from "./hooks/useAgentConnections";
import { AppHeader, type Page } from "./components/AppHeader";
import {
  AgentSidebar,
  type AgentSidebarActions,
} from "./components/AgentSidebar";
import {
  MonitoringPage,
  type MonitoringActions,
} from "./components/MonitoringPage";
import { SettingsPage } from "./components/SettingsPage";
import { AboutPage } from "./components/AboutPage";
import { connectionKey } from "./lib/agent-protocol";
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
  const [activePage, setActivePage] = useState<Page>("monitoring");
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

  // Drive real OS fullscreen from the viewer state so every exit path
  // (button, disconnect, shortcut, remote close) restores the window.
  const isAppFullscreen = fullscreenKey !== null;
  useEffect(() => {
    void getCurrentWindow()
      .setFullscreen(isAppFullscreen)
      .catch(() => undefined);
  }, [isAppFullscreen]);

  // Global shortcuts only while a viewer is fullscreen:
  //   Ctrl+Shift+V  toggle view-only / control
  //   Ctrl+Shift+F  exit fullscreen
  // Escape also exits while the window has focus.
  useEffect(() => {
    if (!isAppFullscreen) return;
    const exitFullscreen = () => {
      setFullscreenKey(null);
      setFullscreenViewOnly(true);
    };
    void register("CommandOrControl+Shift+V", (event) => {
      if (event.state !== "Pressed") return;
      setFullscreenViewOnly((viewOnly) => !viewOnly);
    }).catch(() => undefined);
    void register("CommandOrControl+Shift+F", (event) => {
      if (event.state !== "Pressed") return;
      exitFullscreen();
    }).catch(() => undefined);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitFullscreen();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      void unregisterAll().catch(() => undefined);
    };
  }, [isAppFullscreen]);
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

  // Stable-identity action objects: the refs are mutated with fresh closures
  // every render, so memoized children see an unchanged prop while still
  // calling the latest handlers (no stale-closure risk).
  const monitoringActionsRef = useRef<MonitoringActions>({
    openFullscreen: () => undefined,
    closeFullscreen: () => undefined,
    setViewOnly: () => undefined,
    disconnectRemote: () => undefined,
    startSession: () => undefined,
    viewerError: () => undefined,
  });
  monitoringActionsRef.current = {
    openFullscreen,
    closeFullscreen,
    setViewOnly: setFullscreenViewOnly,
    disconnectRemote: handleDisconnectRemote,
    startSession: (agentIdValue, sessionId) =>
      void startRemoteSession(agentIdValue, sessionId, true),
    viewerError: setGlobalError,
  };
  const sidebarActionsRef = useRef<AgentSidebarActions>({
    connect: () => undefined,
    disconnect: () => undefined,
    remove: () => undefined,
    goToAddAgent: () => undefined,
  });
  sidebarActionsRef.current = {
    connect: (id) => void connectAgent(id),
    disconnect: (id) => void handleDisconnectAgent(id),
    remove: (id) => void removeAgent(id),
    goToAddAgent: () => setActivePage("settings"),
  };

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <AppHeader
        activePage={activePage}
        onNavigate={setActivePage}
        connectedAgentCount={connectedAgentCount}
      />
      {activePage === "monitoring" && (
        <div className="flex min-h-0 flex-1">
          <AgentSidebar
            agents={agents}
            connectingSessions={connectingSessions}
            connectedByKey={connectedByKey}
            totalSessions={totalSessions}
            actions={sidebarActionsRef.current}
          />
          <MonitoringPage
            agents={agents}
            connectingSessions={connectingSessions}
            connectedByKey={connectedByKey}
            totalSessions={totalSessions}
            fullscreenKey={fullscreenKey}
            fullscreenViewOnly={fullscreenViewOnly}
            globalError={globalError}
            actions={monitoringActionsRef.current}
          />
        </div>
      )}
      {activePage === "settings" && (
        <SettingsPage
          agents={agents}
          endpointInput={endpointInput}
          tokenInput={tokenInput}
          savedAgentsPresent={savedAgentsPresent}
          onEndpointInputChange={setEndpointInput}
          onTokenInputChange={setTokenInput}
          onAddAgent={() => void handleAddAgent()}
          onConnectAgent={(id) => void connectAgent(id)}
          onDisconnectAgent={(id) => void handleDisconnectAgent(id)}
          onRemoveAgent={(id) => void removeAgent(id)}
        />
      )}
      {activePage === "about" && <AboutPage />}
    </div>
  );
}
