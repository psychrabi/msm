import { invoke } from '@tauri-apps/api/core';
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

type SavedConnection = { endpoint: string };

const SAVED_CONNECTION_KEY = 'msm.saved-agent-connection';
const LEGACY_TOKEN_KEY = 'msm.saved-agent-token';
const RECONNECT_DELAY_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 5000;

function normalizeEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) {
    const ws = value.replace(/^http/i, 'ws').replace(/\/$/, '');
    return ws.endsWith('/ws') ? ws : `${ws}/ws`;
  }
  if (/^wss?:\/\//i.test(value)) {
    const ws = value.replace(/\/$/, '');
    return ws.endsWith('/ws') ? ws : `${ws}/ws`;
  }
  return `ws://${value.replace(/\/$/, '')}/ws`;
}

function loadSavedEndpoint(): string | null {
  try {
    const raw = localStorage.getItem(SAVED_CONNECTION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedConnection>;
    return typeof saved.endpoint === 'string' && saved.endpoint
      ? normalizeEndpoint(saved.endpoint)
      : null;
  } catch {
    return null;
  }
}

function saveEndpoint(endpoint: string) {
  localStorage.setItem(
    SAVED_CONNECTION_KEY,
    JSON.stringify({ endpoint: normalizeEndpoint(endpoint) } satisfies SavedConnection),
  );
}

function clearSavedEndpoint() {
  localStorage.removeItem(SAVED_CONNECTION_KEY);
}

function credentialKey(endpoint: string): string {
  return `agent-token:${normalizeEndpoint(endpoint)}`;
}

async function getCredential(endpoint: string): Promise<string | null> {
  return invoke<string | null>('credential_get', { key: credentialKey(endpoint) });
}

async function setCredential(endpoint: string, token: string): Promise<void> {
  await invoke('credential_set', { key: credentialKey(endpoint), secret: token });
}

async function deleteCredential(endpoint: string): Promise<void> {
  await invoke('credential_delete', { key: credentialKey(endpoint) });
}

function isUnauthorizedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized|authentication failed|not authorized/i.test(message);
}

function deriveAgentBase(endpoint: string): URL {
  const url = new URL(normalizeEndpoint(endpoint));
  url.pathname = '/';
  url.search = '';
  return url;
}

function deriveVncUrl(endpoint: string, sessionId: string, token: string): string {
  const url = deriveAgentBase(endpoint);
  url.pathname = `/vnc/${sessionId}`;
  url.search = `?token=${encodeURIComponent(token)}`;
  return url.toString();
}

function App() {
  const initialEndpoint = loadSavedEndpoint();
  const [endpoint, setEndpoint] = useState(initialEndpoint ?? 'ws://127.0.0.1:40123/ws');
  const [token, setToken] = useState('');
  const [rememberConnection, setRememberConnection] = useState(Boolean(initialEndpoint));
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [status, setStatus] = useState('Disconnected');
  const [error, setError] = useState('');
  const [remote, setRemote] = useState<RemoteSession | null>(null);
  const [connectingRemote, setConnectingRemote] = useState(false);
  const [viewOnly, setViewOnly] = useState(true);
  const [credentialsReady, setCredentialsReady] = useState(!initialEndpoint);

  const viewerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const endpointRef = useRef(endpoint);
  const tokenRef = useRef(token);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const reconnectEnabledRef = useRef(Boolean(initialEndpoint));
  const selectedSessionRef = useRef(selectedSession);
  const sessionsRef = useRef(sessions);
  const remoteStartRequestedRef = useRef(false);
  const remoteOwnerRef = useRef<symbol | null>(null);
  const rfbGenerationRef = useRef(0);

  useEffect(() => { endpointRef.current = endpoint; }, [endpoint]);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { selectedSessionRef.current = selectedSession; }, [selectedSession]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  useEffect(() => {
    if (!initialEndpoint) return;
    let cancelled = false;
    void (async () => {
      try {
        let storedToken = await getCredential(initialEndpoint);
        if (!storedToken) {
          const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
          if (legacyToken) {
            await setCredential(initialEndpoint, legacyToken);
            localStorage.removeItem(LEGACY_TOKEN_KEY);
            localStorage.removeItem('msm.saved-agent-connection-token');
            storedToken = legacyToken;
          }
        }
        if (!cancelled) {
          setToken(storedToken ?? '');
          setCredentialsReady(true);
        }
      } catch (credentialError) {
        if (!cancelled) {
          setCredentialsReady(true);
          setError(`Unable to access the Windows credential store: ${credentialError instanceof Error ? credentialError.message : String(credentialError)}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [initialEndpoint]);

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
      try { await current.disconnect(); } catch { /* Already closed. */ }
    }
  }

  function scheduleReconnect() {
    if (!reconnectEnabledRef.current || manualDisconnectRef.current || !tokenRef.current) return;
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
    if (connectingRef.current || socketRef.current || !credentialsReady) return;
    const currentEndpoint = normalizeEndpoint(endpointRef.current);
    const currentToken = tokenRef.current.trim();
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
      setToken(currentToken);
      if (rememberConnection) {
        saveEndpoint(currentEndpoint);
        await setCredential(currentEndpoint, currentToken);
        reconnectEnabledRef.current = true;
      } else {
        reconnectEnabledRef.current = false;
      }
      socketRef.current = connection;
      setSocket(connection);
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
            setSelectedSession((current) => current && payload.sessions.some((session) => session.sessionId === current) ? current : payload.sessions[0]?.sessionId ?? null);
            return;
          }
          if (payload.type === 'remoteSession') {
            if (!remoteStartRequestedRef.current) return;
            remoteStartRequestedRef.current = false;
            setRemote(payload.session);
            setConnectingRemote(false);
            return;
          }
          if (payload.type === 'error') {
            remoteStartRequestedRef.current = false;
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
        await deleteCredential(currentEndpoint).catch(() => undefined);
        clearSavedEndpoint();
        setRememberConnection(false);
        reconnectEnabledRef.current = false;
        setToken('');
        setError('Agent authentication failed (401). Enter a new access token.');
      } else {
        setError(connectError instanceof Error ? connectError.message : String(connectError));
        scheduleReconnect();
      }
    } finally {
      connectingRef.current = false;
    }
  }

  useEffect(() => {
    if (!initialEndpoint || !credentialsReady || !token) return;
    void connectAgent(true);
  }, [credentialsReady, token]);

  useEffect(() => {
    const interval = setInterval(() => {
      const current = socketRef.current;
      if (!current || manualDisconnectRef.current) return;
      void refreshSessions(current);
    }, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => () => {
    manualDisconnectRef.current = true;
    clearReconnectTimer();
    void socketRef.current?.disconnect();
    rfbRef.current?.disconnect();
  }, []);

  function disconnectRemote() {
    remoteStartRequestedRef.current = false;
    rfbGenerationRef.current += 1;
    const rfb = rfbRef.current;
    rfbRef.current = null;
    if (rfb) {
      try { rfb.disconnect(); } catch { /* Already closed. */ }
    }
    remoteOwnerRef.current = null;
    const container = viewerRef.current;
    if (container) {
      while (container.firstChild) container.removeChild(container.firstChild);
    }
    setRemote(null);
    setConnectingRemote(false);
  }

  async function disconnect() {
    manualDisconnectRef.current = true;
    reconnectEnabledRef.current = false;
    clearReconnectTimer();
    disconnectRemote();
    await disconnectSocket();
    setIdentity(null);
    setSessions([]);
    setSelectedSession(null);
    setStatus('Disconnected');
  }

  async function forgetConnection() {
    const currentEndpoint = normalizeEndpoint(endpointRef.current);
    manualDisconnectRef.current = true;
    reconnectEnabledRef.current = false;
    clearReconnectTimer();
    await deleteCredential(currentEndpoint).catch(() => undefined);
    clearSavedEndpoint();
    setRememberConnection(false);
    setToken('');
    setError('Saved agent connection removed.');
  }

  function selectSession(sessionId: string) {
    if (selectedSessionRef.current === sessionId) return;
    disconnectRemote();
    setSelectedSession(sessionId);
    setError('');
  }

  async function startRemoteSession(sessionId: string) {
    const current = socketRef.current;
    if (!current || !sessionId) return;
    if (remote?.sessionId === sessionId) return;
    disconnectRemote();
    setSelectedSession(sessionId);
    setError('');
    setConnectingRemote(true);
    remoteStartRequestedRef.current = true;
    try {
      await current.send(JSON.stringify({ type: 'startSession', sessionId }));
    } catch {
      remoteStartRequestedRef.current = false;
      setConnectingRemote(false);
      setError('The agent connection was lost. Reconnecting…');
      await disconnectSocket();
      scheduleReconnect();
    }
  }

  useEffect(() => {
    if (!remote || !viewerRef.current) return;
    const container = viewerRef.current;
    const generation = rfbGenerationRef.current + 1;
    rfbGenerationRef.current = generation;

    const previous = rfbRef.current;
    rfbRef.current = null;
    if (previous) {
      try { previous.disconnect(); } catch { /* Already closed. */ }
    }
    while (container.firstChild) container.removeChild(container.firstChild);

    const vncUrl = deriveVncUrl(endpoint, remote.sessionId, token);
    let rfb: RFB;
    try {
      rfb = new RFB(container, vncUrl, {
        credentials: { password: remote.vncPassword },
      });
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Failed to create VNC connection');
      setRemote(null);
      setConnectingRemote(false);
      return;
    }

    remoteOwnerRef.current = Symbol(remote.sessionId);
    rfb.showDotCursor = true;
    rfb.viewOnly = viewOnly;
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfbRef.current = rfb;

    rfb.addEventListener('connect', () => {
      if (rfbRef.current !== rfb || rfbGenerationRef.current !== generation) return;
      setError('');
      setConnectingRemote(false);
    });

    rfb.addEventListener('disconnect', () => {
      if (rfbRef.current !== rfb || rfbGenerationRef.current !== generation) return;
      rfbRef.current = null;
      remoteOwnerRef.current = null;
      setRemote(null);
      setConnectingRemote(false);
    });

    rfb.addEventListener('securityfailure', (event) => {
      if (rfbRef.current !== rfb || rfbGenerationRef.current !== generation) return;
      setError(`VNC authentication failed: ${event.detail.reason ?? 'Unknown reason'}`);
      setConnectingRemote(false);
    });

    rfb.addEventListener('credentialsrequired', () => {
      if (rfbRef.current !== rfb || rfbGenerationRef.current !== generation) return;
      rfb.sendCredentials({
        username: '',
        password: remote.vncPassword || '',
        target: '',
      });
    });

    return () => {
      if (rfbRef.current === rfb) {
        rfbRef.current = null;
        try { rfb.disconnect(); } catch { /* Already closed. */ }
      }
      while (container.firstChild) container.removeChild(container.firstChild);
      remoteOwnerRef.current = null;
    };
  }, [remote, endpoint, token, viewOnly]);

  const hasSavedConnection = Boolean(loadSavedEndpoint());

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
        <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="ws://host:40123/ws" disabled={Boolean(socket)} />
        <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Agent access token" type="password" disabled={Boolean(socket)} />
        {socket ? (
          <button className="secondary-button" type="button" onClick={() => void disconnect()}>Disconnect agent</button>
        ) : (
          <button className="connect-button" type="button" onClick={() => void connectAgent(false)} disabled={!endpoint || !token || !credentialsReady || status === 'Connecting…' || status === 'Reconnecting…'}>
            {status === 'Reconnecting…' ? 'Reconnecting…' : 'Connect agent'}
          </button>
        )}
        <label className="remember-connection">
          <input type="checkbox" checked={rememberConnection} onChange={(event) => {
            const checked = event.target.checked;
            setRememberConnection(checked);
            reconnectEnabledRef.current = checked;
            const currentEndpoint = normalizeEndpoint(endpoint);
            if (checked && token.trim()) {
              saveEndpoint(currentEndpoint);
              void setCredential(currentEndpoint, token.trim()).catch((credentialError) => setError(`Unable to save credentials: ${credentialError}`));
            } else if (!checked) {
              clearSavedEndpoint();
              void deleteCredential(currentEndpoint).catch(() => undefined);
            }
          }} />
          <span>Remember</span>
        </label>
        {hasSavedConnection && !socket && <button className="secondary-button" type="button" onClick={() => void forgetConnection()}>Forget</button>}
      </section>

      {error && <div className="error-banner">{error}</div>}

      <section className="connection-grid-panel">
        <div className="section-heading">
          <span>Remote connections</span>
          <span className="count">{sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
        </div>
        <div className="connection-grid">
          {sessions.map((session) => {
            const isConnected = remote?.sessionId === session.sessionId;
            const isSelected = selectedSession === session.sessionId;
            return (
              <article className={`connection-card ${isSelected ? 'selected' : ''} ${isConnected ? 'connected' : ''}`} key={session.sessionId}>
                <button className="connection-card-main" type="button" onClick={() => selectSession(session.sessionId)}>
                  <div className="connection-card-header">
                    <span className={`status-dot ${session.state === 'active' ? 'active' : 'locked'}`} />
                    <span className="connection-state">{isConnected ? 'Connected' : session.state}</span>
                  </div>
                  <strong>{session.username}</strong>
                  <span>Session {session.sessionId}{session.seatId ? ` · Seat ${session.seatId}` : ''}</span>
                </button>
                <div className="connection-card-actions">
                  <label className="card-view-only">
                    <input type="checkbox" checked={viewOnly} onChange={(event) => setViewOnly(event.target.checked)} />
                    View only
                  </label>
                  {isConnected ? (
                    <button className="secondary-button" type="button" onClick={disconnectRemote}>Disconnect</button>
                  ) : (
                    <button className="connect-button" type="button" disabled={!socket || connectingRemote} onClick={() => void startRemoteSession(session.sessionId)}>
                      {connectingRemote && isSelected ? 'Starting…' : 'Connect'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {!sessions.length && <div className="empty-state">Connect to an MSM agent to discover active Windows sessions.</div>}
        </div>
      </section>

      <section className="viewer-panel">
        <div className="viewer-toolbar">
          <div>
            <span className="label">Remote desktop</span>
            <strong>{remote ? `Connected · Session ${remote.sessionId}` : 'Not connected'}</strong>
          </div>
          <div className="viewer-actions">
            {remote && <button className="secondary-button" type="button" onClick={disconnectRemote}>Disconnect</button>}
          </div>
        </div>
        <div className={`viewer-surface ${remote ? 'active' : ''}`} ref={viewerRef}>
          {!remote && <div className="viewer-placeholder"><div className="placeholder-icon">▣</div><h2>Remote desktop</h2><p>Select a session above and click Connect.</p></div>}
        </div>
      </section>
    </main>
  );
}

export default App;
