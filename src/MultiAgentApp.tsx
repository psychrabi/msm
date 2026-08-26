import { useState } from "react";
import { isValidAgentIp } from "./lib/agent-protocol";
import { hasSavedAgents } from "./lib/agent-storage";
import { useAgentConnections } from "./hooks/useAgentConnections";
import { AppHeader, type Page } from "./components/AppHeader";
import { AgentSidebar } from "./components/AgentSidebar";
import { MonitoringPage } from "./components/MonitoringPage";
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
            onConnectAgent={(id) => void connectAgent(id)}
            onDisconnectAgent={(id) => void handleDisconnectAgent(id)}
            onRemoveAgent={(id) => void removeAgent(id)}
            onAddAgent={() => setActivePage("settings")}
          />
          <MonitoringPage
            agents={agents}
            connectingSessions={connectingSessions}
            connectedByKey={connectedByKey}
            totalSessions={totalSessions}
            fullscreenKey={fullscreenKey}
            fullscreenViewOnly={fullscreenViewOnly}
            globalError={globalError}
            onOpenFullscreen={openFullscreen}
            onCloseFullscreen={closeFullscreen}
            onViewOnlyChange={setFullscreenViewOnly}
            onDisconnectRemote={handleDisconnectRemote}
            onStartSession={(agentIdValue, sessionId) =>
              void startRemoteSession(agentIdValue, sessionId, true)
            }
            onViewerError={setGlobalError}
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
      {activePage === "about" && (
        <AboutPage
          agentCount={agents.length}
          connectedAgentCount={connectedAgentCount}
          remoteViewerCount={remoteConnections.length}
        />
      )}
    </div>
  );
}
