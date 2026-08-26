import { useEffect, useRef, useState } from "react";
import WebSocket from "@tauri-apps/plugin-websocket";
import {
  agentId,
  connectionKey,
  isUnauthorizedError,
  isValidAgentIp,
  normalizeAgentIp,
  normalizeEndpoint,
  type AgentConnection,
  type AgentMessage,
  type RemoteConnection,
} from "../lib/agent-protocol";
import {
  addSavedAgent,
  clearLegacySavedConnection,
  deleteCredential,
  getCredential,
  getSavedAgents,
  LEGACY_ENDPOINT_KEY,
  LEGACY_TOKEN_KEY,
  removeSavedAgent,
  setCredential,
} from "../lib/agent-storage";

const RECONNECT_DELAY_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 5000;

/**
 * Owns the full agent-connection lifecycle: sockets, reconnect timers,
 * credentials, remembered endpoints, and active remote (VNC) viewers.
 * Consumers see declarative state plus intent-level actions.
 */
export function useAgentConnections() {
  const [agents, setAgents] = useState<AgentConnection[]>([]);
  const [remoteConnections, setRemoteConnections] = useState<
    RemoteConnection[]
  >([]);
  const [connectingSessions, setConnectingSessions] = useState<Set<string>>(
    new Set(),
  );
  const [globalError, setGlobalError] = useState("");
  const socketsRef = useRef(new Map<string, WebSocket>());
  const reconnectTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const manualDisconnectRef = useRef(new Set<string>());
  const pendingRemoteRequestsRef = useRef(new Set<string>());
  const connectingAgentsRef = useRef(new Set<string>());
  const agentsRef = useRef<AgentConnection[]>([]);
  const initialLoadRef = useRef(false);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    let cancelled = false;
    void (async () => {
      let saved = getSavedAgents();
      const legacyEndpoint = localStorage.getItem(LEGACY_ENDPOINT_KEY);
      const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
      if (legacyEndpoint && saved.length === 0)
        saved = [{ endpoint: normalizeEndpoint(legacyEndpoint) }];
      const loaded = await Promise.all(
        saved.map(async (item): Promise<AgentConnection> => {
          try {
            let token = await getCredential(item.endpoint);
            if (
              !token &&
              legacyToken &&
              legacyEndpoint &&
              normalizeEndpoint(legacyEndpoint) === item.endpoint
            ) {
              await setCredential(item.endpoint, legacyToken);
              token = legacyToken;
            }
            return {
              id: agentId(item.endpoint),
              endpoint: item.endpoint,
              token: token ?? "",
              identity: null,
              sessions: [],
              status: "Disconnected",
              error: "",
              remembered: true,
            };
          } catch (error) {
            return {
              id: agentId(item.endpoint),
              endpoint: item.endpoint,
              token: "",
              identity: null,
              sessions: [],
              status: "Disconnected",
              error: String(error),
              remembered: true,
            };
          }
        }),
      );
      if (legacyEndpoint) clearLegacySavedConnection();
      if (cancelled) return;
      setAgents(loaded);
      for (const agent of loaded)
        if (agent.token)
          setTimeout(() => void connectAgentRef.current(agent.id, true), 0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function updateAgent(id: string, patch: Partial<AgentConnection>) {
    setAgents((current) =>
      current.map((agent) =>
        agent.id === id ? { ...agent, ...patch } : agent,
      ),
    );
  }
  function clearReconnectTimer(id: string) {
    const timer = reconnectTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    reconnectTimersRef.current.delete(id);
  }
  async function disconnectAgentSocket(id: string) {
    const socket = socketsRef.current.get(id);
    socketsRef.current.delete(id);
    if (socket) {
      try {
        await socket.disconnect();
      } catch {
        /* already closed */
      }
    }
  }
  function scheduleReconnect(id: string) {
    const agent = agentsRef.current.find((item) => item.id === id);
    if (
      !agent ||
      !agent.remembered ||
      !agent.token ||
      manualDisconnectRef.current.has(id) ||
      reconnectTimersRef.current.has(id)
    )
      return;
    updateAgent(id, { status: "Reconnecting…" });
    reconnectTimersRef.current.set(
      id,
      setTimeout(() => {
        reconnectTimersRef.current.delete(id);
        void connectAgent(id, true);
      }, RECONNECT_DELAY_MS),
    );
  }
  async function refreshSessions(id: string) {
    const socket = socketsRef.current.get(id);
    if (!socket) return;
    try {
      await socket.send(JSON.stringify({ type: "listSessions" }));
    } catch {
      await disconnectAgentSocket(id);
      scheduleReconnect(id);
    }
  }
  async function connectAgent(id: string, isReconnect = false) {
    const agent = agentsRef.current.find((item) => item.id === id);
    if (
      !agent ||
      connectingAgentsRef.current.has(id) ||
      socketsRef.current.has(id) ||
      !agent.token
    )
      return;
    connectingAgentsRef.current.add(id);

    // Only clear an agent-level manual disconnect.
    // Viewer-level manual disconnects use `${agentId}::${sessionId}`
    // and must survive agent reconnects.
    manualDisconnectRef.current.delete(id);
    updateAgent(id, {
      status: isReconnect ? "Reconnecting…" : "Connecting…",
      error: "",
    });
    try {
      const connection = await WebSocket.connect(agent.endpoint, {
        headers: { Authorization: `Bearer ${agent.token.trim()}` },
      });
      socketsRef.current.set(id, connection);
      clearReconnectTimer(id);
      updateAgent(id, { status: "Connected", error: "" });
      addSavedAgent(agent.endpoint);
      await setCredential(agent.endpoint, agent.token.trim());
      connection.addListener((message) => {
        if (message.type !== "Text") return;
        try {
          const payload = JSON.parse(message.data) as AgentMessage;
          if (payload.type === "hello") {
            updateAgent(id, {
              identity: payload.identity,
              status: "Connected",
              error: "",
            });
            void refreshSessions(id);
            return;
          }
          if (payload.type === "sessions") {
            updateAgent(id, { sessions: payload.sessions });
            for (const session of payload.sessions) {
              if (session.state !== "active") continue;
              void startRemoteSession(id, session.sessionId);
            }
            return;
          }
          if (payload.type === "remoteSession") {
            const key = connectionKey(id, payload.session.sessionId);
            if (!pendingRemoteRequestsRef.current.has(key)) return;
            pendingRemoteRequestsRef.current.delete(key);
            setConnectingSessions((current) => {
              const next = new Set(current);
              next.delete(key);
              return next;
            });
            setRemoteConnections((current) =>
              current.some(
                (item) =>
                  item.agentId === id &&
                  item.sessionId === payload.session.sessionId,
              )
                ? current
                : [
                    ...current,
                    {
                      ...payload.session,
                      agentId: id,
                      username:
                        agentsRef.current
                          .find((item) => item.id === id)
                          ?.sessions.find(
                            (session) =>
                              session.sessionId === payload.session.sessionId,
                          )?.username ?? `Session ${payload.session.sessionId}`,
                    },
                  ],
            );
            return;
          }
          if (payload.type === "error")
            setGlobalError(
              `${agentsRef.current.find((item) => item.id === id)?.identity?.deviceName ?? id}: ${payload.message}`,
            );
        } catch {
          updateAgent(id, {
            error: "Received an invalid message from the agent.",
          });
        }
      });
      // Do not depend on the initial `hello` frame arriving before the listener is attached.
      // The socket is already established, so request the session list immediately.
      void refreshSessions(id);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        await deleteCredential(agent.endpoint).catch(() => undefined);
        removeSavedAgent(agent.endpoint);
        updateAgent(id, {
          status: "Disconnected",
          token: "",
          remembered: false,
          error: "Authentication failed (401).",
        });
      } else {
        updateAgent(id, {
          status: "Disconnected",
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleReconnect(id);
      }
    } finally {
      connectingAgentsRef.current.delete(id);
    }
  }
  const connectAgentRef = useRef(connectAgent);
  useEffect(() => {
    connectAgentRef.current = connectAgent;
  });

  /** Returns true when a new agent record was created. */
  async function addAgent(endpointIp: string, token: string): Promise<boolean> {
    const ip = endpointIp.trim();
    const normalized = normalizeAgentIp(ip);
    const trimmedToken = token.trim();
    if (!isValidAgentIp(ip) || !normalized || !trimmedToken) return false;
    const existing = agentsRef.current.find(
      (agent) => agent.id === agentId(normalized),
    );
    if (existing) {
      updateAgent(existing.id, { token: trimmedToken, remembered: true, error: "" });
      addSavedAgent(normalized);
      await setCredential(normalized, trimmedToken);
      setTimeout(() => void connectAgentRef.current(existing.id), 0);
      return false;
    }
    const next: AgentConnection = {
      id: agentId(normalized),
      endpoint: normalized,
      token: trimmedToken,
      identity: null,
      sessions: [],
      status: "Disconnected",
      error: "",
      remembered: true,
    };
    setAgents((current) => [...current, next]);
    addSavedAgent(normalized);
    await setCredential(normalized, trimmedToken);
    setTimeout(() => void connectAgentRef.current(next.id), 0);
    return true;
  }
  async function disconnectAgent(id: string) {
    manualDisconnectRef.current.add(id);
    clearReconnectTimer(id);
    pendingRemoteRequestsRef.current.forEach((key) => {
      if (key.startsWith(`${id}::`))
        pendingRemoteRequestsRef.current.delete(key);
    });
    setConnectingSessions((current) => {
      const next = new Set(current);
      for (const key of next) if (key.startsWith(`${id}::`)) next.delete(key);
      return next;
    });
    setRemoteConnections((current) =>
      current.filter((item) => item.agentId !== id),
    );
    await disconnectAgentSocket(id);
    updateAgent(id, { status: "Disconnected", identity: null, sessions: [] });
  }
  async function removeAgent(id: string) {
    const agent = agentsRef.current.find((item) => item.id === id);
    if (!agent) return;
    await disconnectAgent(id);
    await deleteCredential(agent.endpoint).catch(() => undefined);
    removeSavedAgent(agent.endpoint);
    setAgents((current) => current.filter((item) => item.id !== id));
  }
  async function startRemoteSession(
    agentIdValue: string,
    sessionId: string,
    userInitiated = false,
  ) {
    const socket = socketsRef.current.get(agentIdValue);
    const key = connectionKey(agentIdValue, sessionId);

    // A user clicking "Connect" overrides a previous manual disconnect;
    // automatic reconnects after agent refresh must not.
    if (userInitiated) manualDisconnectRef.current.delete(key);

    if (
      manualDisconnectRef.current.has(key) ||
      !socket ||
      pendingRemoteRequestsRef.current.has(key) ||
      remoteConnections.some(
        (item) => item.agentId === agentIdValue && item.sessionId === sessionId,
      )
    ) {
      return;
    }

    pendingRemoteRequestsRef.current.add(key);

    setConnectingSessions((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });

    try {
      await socket.send(
        JSON.stringify({
          type: "startSession",
          sessionId,
        }),
      );
    } catch {
      pendingRemoteRequestsRef.current.delete(key);

      setConnectingSessions((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });

      await disconnectAgentSocket(agentIdValue);
      scheduleReconnect(agentIdValue);
    }
  }

  function disconnectRemote(agentIdValue: string, sessionId: string) {
    const key = connectionKey(agentIdValue, sessionId);

    // Remember that this viewer was intentionally disconnected.
    // Agent reconnect/session refresh must not automatically reconnect it.
    manualDisconnectRef.current.add(key);

    pendingRemoteRequestsRef.current.delete(key);

    setConnectingSessions((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });

    setRemoteConnections((current) =>
      current.filter(
        (item) =>
          !(item.agentId === agentIdValue && item.sessionId === sessionId),
      ),
    );
  }

  useEffect(() => {
    const interval = setInterval(() => {
      for (const agent of agentsRef.current)
        if (socketsRef.current.has(agent.id)) void refreshSessions(agent.id);
    }, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
  useEffect(
    () => () => {
      for (const timer of reconnectTimersRef.current.values())
        clearTimeout(timer);
      for (const socket of socketsRef.current.values())
        void socket.disconnect().catch(() => undefined);
    },
    [],
  );

  return {
    agents,
    remoteConnections,
    connectingSessions,
    globalError,
    setGlobalError,
    addAgent,
    connectAgent,
    disconnectAgent,
    removeAgent,
    startRemoteSession,
    disconnectRemote,
  };
}
