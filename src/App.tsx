import { useEffect, useRef, useState } from 'react';
import WebSocket from '@tauri-apps/plugin-websocket';
import RFB from '@novnc/novnc';
import './styles.css';

type Session = {
  sessionId: string;
  username: string;
  state: string;
  seatId?: string | null;
  display?: string | null;
};
type DeviceIdentity = {
  deviceId: string;
  deviceName: string;
  platform: string;
  architecture: string;
  agentVersion: string;
};
type RemoteSession = {
  sessionId: string;
  port: number;
  vncPassword: string;
};
type AgentMessage =
  | { type: 'hello'; identity: DeviceIdentity }
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'remoteSession'; session: RemoteSession }
  | { type: 'error'; message: string };

type SavedConnection = {
  endpoint: string;
  token: string;
};

const SAVED_CONNECTION_KEY = 'msm.saved-agent-connection';
const RECONNECT_DELAY_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const REMOTE_RECONNECT_DELAY_MS = 2000;

function loadSavedConnection(): SavedConnection | null {
  try {
    const raw = localStorage.getItem(SAVED_CONNECTION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedConnection>;
    if (
      typeof saved.endpoint !== 'string' ||
      typeof saved.token !== 'string' ||
      !saved.endpoint ||
      !saved.token
    ) {
      return null;
    }
    return { endpoint: saved.endpoint, token: saved.token };
  } catch {
    return null;
  }
}

function saveConnection(connection: SavedConnection) {
  localStorage.setItem(SAVED_CONNECTION_KEY, JSON.stringify(connection));
}

function clearSavedConnection() {
  localStorage.removeItem(SAVED_CONNECTION_KEY);
}

function isUnauthorizedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized|authentication failed|not authorized/i.test(message);
}

function normalizeEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/^http/i, 'ws').replace(/\/$/, '') + '/ws';
  }
  if (/^wss?:\/\//i.test(value)) {
    return value.replace(/\/$/, '').endsWith('/ws')
      ? value.replace(/\/$/, '')
      : `${value.replace(/\/$/, '')}/ws`;
  }
  return `ws://${value.replace(/\/$/, '')}/ws`;
}

function App() {
  const initialSavedConnection = useRef(loadSavedConnection());
  const [endpoint, setEndpoint] = useState(
    initialSavedConnection.current?.endpoint ?? 'ws://127.0.0.1:40123/ws',
  );
  const [token, setToken] = useState(initialSavedConnection.current?.token ?? '');
  const [rememberConnection, setRememberConnection] = useState(
    Boolean(initialSavedConnection.current),
  );
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [status, setStatus] = useState('Disconnected');
  const [error, setError] = useState('');
  const [remote, setRemote] = useState<RemoteSession | null>(null);
  const [connectingRemote, setConnectingRemote] = useState(false);
  const [reconnectEnabled, setReconnectEnabled] = useState(Boolean(initialSavedConnection.current));
  const viewerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const endpointRef = useRef(endpoint);
  const tokenRef = useRef(token);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const selectedSessionRef = useRef(selectedSession);
  const sessionsRef = useRef(sessions);

  useEffect(() => {
    endpointRef.current = endpoint;
  }, [endpoint]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  function clearReconnectTimer() {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  async function disconnectSocket() {
    const current = socketRef.current;
    socketRef.current = null;
    setSocket(null);
    if (current) {
      try {
        await current.disconnect();
      } catch {
        // The connection may already have been closed.
      }
    }
  }

  function scheduleReconnect() {
    if (!reconnectEnabled || manualDisconnectRef.current || !tokenRef.current) return;
    if (reconnectTimerRef.current) return;

    setStatus('Reconnecting…');
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void connectAgent(true);
    }, RECONNECT_DELAY_MS);
  }

  async function refreshSessions(connection: WebSocket) {
    try {
      await connection.send(JSON.stringify({ type: 'listSessions' }));
    } catch {
      await disconnectSocket();
      scheduleReconnect();
    }
  }

  async function connectAgent(isReconnect = false): Promise<void> {
    if (connectingRef.current || socketRef.current) return;

    const currentToken = tokenRef.current.trim();
    const currentEndpoint = normalizeEndpoint(endpointRef.current);
    if (!currentEndpoint || !currentToken) {
      setStatus('Disconnected');
      return;
    }

    connectingRef.current = true;
    manualDisconnectRef.current = false;
    setError('');
    setStatus(isReconnect ? 'Reconnecting…' : 'Connecting…');

    try {
      const connection = await WebSocket.connect(currentEndpoint, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });

      endpointRef.current = currentEndpoint;
      setEndpoint(currentEndpoint);

      if (rememberConnection || reconnectEnabled) {
        saveConnection({ endpoint: currentEndpoint, token: currentToken });
      }

      socketRef.current = connection;
      setSocket(connection);
      setReconnectEnabled(true);
      clearReconnectTimer();

      connection.addListener((message) => {
        if (message.type !== 'Text') return;

        try {
          const payload = JSON.parse(message.data) as AgentMessage;

          if (payload.type === 'hello') {
            setIdentity(payload.identity);
            setStatus('Connected');
            setError('');
            void refreshSessions(connection);
            return;
          }

          if (payload.type === 'sessions') {
            setSessions(payload.sessions);
            sessionsRef.current = payload.sessions;

            setSelectedSession((current) => {
              if (current && payload.sessions.some((session) => session.sessionId === current)) {
                return current;
              }
              return payload.sessions[0]?.sessionId ?? null;
            });
            return;
          }

          if (payload.type === 'remoteSession') {
            setRemote(payload.session);
            setConnectingRemote(false);
            return;
          }

          if (payload.type === 'error') {
            setConnectingRemote(false);
            setError(payload.message);
          }
        } catch {
          setError('Received an invalid message from the agent.');
        }
      });
    } catch (connectError) {
      setStatus('Disconnected');

      if (isUnauthorizedError(connectError)) {
        clearSavedConnection();
        setRememberConnection(false);
        setReconnectEnabled(false);
        setToken('');
        setError('Agent authentication failed (401). Enter a new access token.');
      } else {
        setError(
          connectError instanceof Error ? connectError.message : String(connectError),
        );
        scheduleReconnect();
      }
    } finally {
      connectingRef.current = false;
    }
  }

  useEffect(() => {
    if (!initialSavedConnection.current) return;
    void connectAgent(true);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const current = socketRef.current;
      if (!current || manualDisconnectRef.current) return;

      void refreshSessions(current);
    }, HEALTH_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      manualDisconnectRef.current = true;
      clearReconnectTimer();
      if (remoteReconnectTimerRef.current) {
        clearTimeout(remoteReconnectTimerRef.current);
      }
      void socketRef.current?.disconnect();
      rfbRef.current?.disconnect();
    };
  }, []);

  async function disconnect() {
    manualDisconnectRef.current = true;
    setReconnectEnabled(false);
    clearReconnectTimer();

    if (remoteReconnectTimerRef.current) {
      clearTimeout(remoteReconnectTimerRef.current);
      remoteReconnectTimerRef.current = null;
    }

    rfbRef.current?.disconnect();
    rfbRef.current = null;
    setRemote(null);
    setConnectingRemote(false);

    await disconnectSocket();
    setIdentity(null);
    setSessions([]);
    setSelectedSession(null);
    setStatus('Disconnected');
  }

  function forgetConnection() {
    clearSavedConnection();
    setRememberConnection(false);
    setReconnectEnabled(false);
    setToken('');
    setError('Saved agent connection removed.');
  }

  function startRemoteSession() {
    const current = socketRef.current;
    const sessionId = selectedSessionRef.current;
    if (!current || !sessionId) return;

    if (remoteReconnectTimerRef.current) {
      clearTimeout(remoteReconnectTimerRef.current);
      remoteReconnectTimerRef.current = null;
    }

    setError('');
    setConnectingRemote(true);
    void current.send(JSON.stringify({ type: 'startSession', sessionId })).catch(() => {
      setConnectingRemote(false);
      setError('The agent connection was lost. Reconnecting…');
      void disconnectSocket();
      scheduleReconnect();
    });
  }

  useEffect(() => {
    if (!remote || !viewerRef.current) return;

    rfbRef.current?.disconnect();
    viewerRef.current.replaceChildren();

    const controlEndpoint = new URL(normalizeEndpoint(endpoint));
    controlEndpoint.pathname = `/vnc/${remote.sessionId}`;
    controlEndpoint.search = `?token=${encodeURIComponent(token)}`;
    controlEndpoint.protocol = controlEndpoint.protocol === 'wss:' ? 'wss:' : 'ws:';

    const rfb = new RFB(viewerRef.current, controlEndpoint.toString(), {
      credentials: { password: remote.vncPassword },
    });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = false;
    rfb.showDotCursor = true;

    rfb.addEventListener('connect', () => {
      setError('');
    });

    rfb.addEventListener('disconnect', () => {
      rfbRef.current = null;
      setRemote(null);
      setConnectingRemote(false);

      if (manualDisconnectRef.current || !socketRef.current) return;

      setError('Remote desktop disconnected. Reconnecting…');
      if (remoteReconnectTimerRef.current) {
        clearTimeout(remoteReconnectTimerRef.current);
      }

      remoteReconnectTimerRef.current = setTimeout(() => {
        remoteReconnectTimerRef.current = null;
        const sessionId = selectedSessionRef.current;
        const stillExists = sessionsRef.current.some(
          (session) => session.sessionId === sessionId,
        );
        if (sessionId && stillExists && socketRef.current) {
          startRemoteSession();
        }
      }, REMOTE_RECONNECT_DELAY_MS);
    });

    rfb.addEventListener('securityfailure', (event) => {
      setError(`VNC authentication failed: ${event.detail.reason}`);
      setConnectingRemote(false);
    });

    rfbRef.current = rfb;
    return () => rfb.disconnect();
  }, [remote, endpoint, token]);

  const selected = sessions.find((session) => session.sessionId === selectedSession);
  const hasSavedConnection = Boolean(loadSavedConnection());

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">MSM · WINDOWS</div>
          <h1>Remote Monitor &amp; Control</h1>
        </div>
        <div className="device-status">
          <span className={`status-dot ${status === 'Connected' ? 'online' : ''}`} />
          {identity ? `${identity.deviceName} · ${status}` : status}
        </div>
      </header>

      <section className="connection-bar">
        <input
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="ws://host:40123/ws"
          disabled={Boolean(socket)}
        />
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Agent access token"
          type="password"
          disabled={Boolean(socket)}
        />
        {socket ? (
          <button className="secondary-button" type="button" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <button
            className="connect-button"
            type="button"
            onClick={() => void connectAgent(false)}
            disabled={!endpoint || !token || status === 'Connecting…' || status === 'Reconnecting…'}
          >
            {status === 'Reconnecting…' ? 'Reconnecting…' : 'Connect'}
          </button>
        )}
        <label className="remember-connection">
          <input
            type="checkbox"
            checked={rememberConnection}
            onChange={(event) => {
              const checked = event.target.checked;
              setRememberConnection(checked);
              setReconnectEnabled(checked);
              if (checked && token.trim()) {
                saveConnection({ endpoint: normalizeEndpoint(endpoint), token: token.trim() });
              } else if (!checked) {
                clearSavedConnection();
              }
            }}
          />
          <span>Remember</span>
        </label>
        {hasSavedConnection && !socket && (
          <button className="secondary-button" type="button" onClick={forgetConnection}>
            Forget
          </button>
        )}
      </section>

      {error && <div className="error-banner">{error}</div>}

      <section className="workspace">
        <aside className="sidebar">
          <div className="section-heading">
            <span>Windows sessions</span>
            <span className="count">{sessions.length}</span>
          </div>
          <div className="seat-list">
            {sessions.map((session) => (
              <button
                className={`seat-card ${selectedSession === session.sessionId ? 'selected' : ''}`}
                key={session.sessionId}
                type="button"
                onClick={() => {
                  setSelectedSession(session.sessionId);
                  setRemote(null);
                }}
              >
                <span className={`status-dot ${session.state === 'active' ? 'active' : 'locked'}`} />
                <span className="seat-copy">
                  <strong>{session.username}</strong>
                  <span>
                    Session {session.sessionId}
                    {session.seatId ? ` · ${session.seatId}` : ''}
                  </span>
                </span>
                <span className="seat-state">{session.state}</span>
              </button>
            ))}
            {!sessions.length && (
              <div className="empty-state">
                Connect to a Windows MSM agent to discover its logged-in user sessions.
              </div>
            )}
          </div>
        </aside>

        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <div>
              <span className="label">Selected session</span>
              <strong>
                {selected ? `${selected.username} · Session ${selected.sessionId}` : 'None'}
              </strong>
            </div>
            <button
              className="connect-button"
              type="button"
              disabled={!selected || connectingRemote || !socket}
              onClick={startRemoteSession}
            >
              {connectingRemote
                ? 'Starting…'
                : remote
                  ? 'Reconnect desktop'
                  : 'Start remote session'}
            </button>
          </div>

          <div className={`viewer-surface ${remote ? 'active' : ''}`} ref={viewerRef}>
            {!remote && (
              <div className="viewer-placeholder">
                <div className="placeholder-icon">▣</div>
                <h2>{selected ? `Ready for ${selected.username}` : 'Remote desktop'}</h2>
                <p>Select a Windows session and start a remote session.</p>
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
