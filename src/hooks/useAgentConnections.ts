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
const MAX_RECONNECT_DELAY_MS = 60000;
const RECONNECT_JITTER = 0.15;
const HEALTH_CHECK_INTERVAL_MS = 30000;

/** Per-viewer lifecycle flags for one session on one agent. */
type ViewerRuntime = {
  /** Viewer was closed by the user; automatic reconnects must not reopen it. */
  manualDisconnected: boolean;
  /** A startSession request is in flight and awaiting a remoteSession reply. */
  pendingRequest: boolean;
};

/**
 * Per-agent connection state machine. One entry per known agent replaces
 * the previous five parallel collections (sockets, timers, manual
 * disconnects, pending requests, connecting attempts), so every invariant —
 * "a reconnect timer only exists while disconnected and remembered",
 * "a socket only exists while connected", "viewer-level manual disconnects
 * survive agent reconnects" — lives in one place.
 */
type AgentRuntime = {
  socket: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** A connect attempt is currently in flight. */
  connecting: boolean;
  /** The agent itself was manually disconnected (not its viewers). */
  manualDisconnected: boolean;
  /** Consecutive failed reconnects; drives the exponential backoff delay. */
  reconnectAttempts: number;
  viewers: Map<string, ViewerRuntime>;
};

function newAgentRuntime(): AgentRuntime {
  return {
    socket: null,
    reconnectTimer: null,
    connecting: false,
    manualDisconnected: false,
    reconnectAttempts: 0,
    viewers: new Map(),
  };
}

function newViewerRuntime(): ViewerRuntime {
  return { manualDisconnected: false, pendingRequest: false };
}

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
  const runtimesRef = useRef(new Map<string, AgentRuntime>());
  const agentsRef = useRef<AgentConnection[]>([]);
  const initialLoadRef = useRef(false);

  function getRuntime(id: string): AgentRuntime {
    let runtime = runtimesRef.current.get(id);
    if (!runtime) {
      runtime = newAgentRuntime();
      runtimesRef.current.set(id, runtime);
    }
    return runtime;
  }
  function getViewer(runtime: AgentRuntime, sessionId: string): ViewerRuntime {
    let viewer = runtime.viewers.get(sessionId);
    if (!viewer) {
      viewer = newViewerRuntime();
      runtime.viewers.set(sessionId, viewer);
    }
    return viewer;
  }

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
    const runtime = getRuntime(id);
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }
  async function disconnectAgentSocket(id: string) {
    const runtime = getRuntime(id);
    const socket = runtime.socket;
    runtime.socket = null;
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
    const runtime = getRuntime(id);
    if (
      !agent ||
      !agent.remembered ||
      !agent.token ||
      runtime.manualDisconnected ||
      runtime.reconnectTimer
    )
      return;
    updateAgent(id, { status: "Reconnecting…" });
    // Exponential backoff with jitter so many agents that dropped during
    // the same outage do not all hammer their agents in lockstep.
    const backoff = Math.min(
      RECONNECT_DELAY_MS * 2 ** runtime.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    const delay = backoff * (1 - RECONNECT_JITTER + Math.random() * RECONNECT_JITTER * 2);
    runtime.reconnectAttempts += 1;
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null;
      void connectAgent(id, true);
    }, delay);
  }
  async function refreshSessions(id: string) {
    const socket = runtimesRef.current.get(id)?.socket;
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
    const runtime = getRuntime(id);
    if (!agent || runtime.connecting || runtime.socket || !agent.token) return;

    // Only clear an agent-level manual disconnect.
    // Viewer-level manual disconnects live on each viewer runtime
    // and must survive agent reconnects.
    runtime.connecting = true;
    runtime.manualDisconnected = false;
    updateAgent(id, {
      status: isReconnect ? "Reconnecting…" : "Connecting…",
      error: "",
    });
    try {
      const connection = await WebSocket.connect(agent.endpoint, {
        headers: { Authorization: `Bearer ${agent.token.trim()}` },
      });
      runtime.socket = connection;
      runtime.reconnectAttempts = 0;
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
            const viewer = runtime.viewers.get(payload.session.sessionId);
            if (!viewer?.pendingRequest) return;
            viewer.pendingRequest = false;
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
      runtime.connecting = false;
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
    const runtime = getRuntime(id);
    runtime.manualDisconnected = true;
    clearReconnectTimer(id);
    // Cancel any in-flight viewer requests, but keep their
    // manualDisconnected flags so auto-reconnect stays suppressed.
    for (const viewer of runtime.viewers.values())
      viewer.pendingRequest = false;
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
    runtimesRef.current.delete(id);
    setAgents((current) => current.filter((item) => item.id !== id));
  }
  async function startRemoteSession(
    agentIdValue: string,
    sessionId: string,
    userInitiated = false,
  ) {
    const runtime = getRuntime(agentIdValue);
    const viewer = getViewer(runtime, sessionId);
    const key = connectionKey(agentIdValue, sessionId);

    // A user clicking "Connect" overrides a previous manual disconnect;
    // automatic reconnects after agent refresh must not.
    if (userInitiated) viewer.manualDisconnected = false;

    if (
      viewer.manualDisconnected ||
      !runtime.socket ||
      viewer.pendingRequest ||
      remoteConnections.some(
        (item) => item.agentId === agentIdValue && item.sessionId === sessionId,
      )
    ) {
      return;
    }

    viewer.pendingRequest = true;

    setConnectingSessions((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });

    try {
      await runtime.socket.send(
        JSON.stringify({
          type: "startSession",
          sessionId,
        }),
      );
    } catch {
      viewer.pendingRequest = false;

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
    const runtime = runtimesRef.current.get(agentIdValue);
    if (runtime) {
      const viewer = getViewer(runtime, sessionId);
      viewer.manualDisconnected = true;
      viewer.pendingRequest = false;
    }

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
    const refreshConnected = () => {
      for (const agent of agentsRef.current)
        if (runtimesRef.current.get(agent.id)?.socket)
          void refreshSessions(agent.id);
    };
    // Skip polling while the window is hidden; catch up immediately on return.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refreshConnected();
    }, HEALTH_CHECK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshConnected();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  useEffect(
    () => () => {
      for (const runtime of runtimesRef.current.values()) {
        if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
        if (runtime.socket)
          void runtime.socket.disconnect().catch(() => undefined);
      }
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
