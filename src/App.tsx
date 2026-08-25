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

type Station = {
  id: string;
  name: string;
  endpoint: string;
};

const STATIONS_KEY = 'msm.stations';
const LEGACY_CONNECTION_KEY = 'msm.saved-agent-connection';
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

function loadStations(): Station[] {
  try {
    const raw = localStorage.getItem(STATIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((station): station is Station =>
          Boolean(
            station &&
              typeof station === 'object' &&
              typeof (station as Station).id === 'string' &&
              typeof (station as Station).name === 'string' &&
              typeof (station as Station).endpoint === 'string',
          ),
        );
      }
    }

    const legacy = localStorage.getItem(LEGACY_CONNECTION_KEY);
    if (legacy) {
      const endpoint = normalizeEndpoint(legacy);
      return [{ id: crypto.randomUUID(), name: 'Local Agent', endpoint }];
    }
  } catch {
    // Ignore malformed local configuration.
  }
  return [];
}

function saveStations(stations: Station[]) {
  localStorage.setItem(STATIONS_KEY, JSON.stringify(stations));
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

function App() {
  const initialStations = loadStations();
  const [stations, setStations] = useState<Station[]>(initialStations);
  const [activeStationId, setActiveStationId] = useState<string | null>(initialStations[0]?.id ?? null);
  const [view, setView] = useState<'monitoring' | 'stations' | 'settings' | 'about'>('monitoring');
  const [showStationEditor, setShowStationEditor] = useState(false);
  const [editingStationId, setEditingStationId] = useState<string | null>(null);
  const [stationName, setStationName] = useState('');
  const [endpoint, setEndpoint] = useState(initialStations[0]?.endpoint ?? 'ws://127.0.0.1:40123/ws');
  const [token, setToken] = useState('');
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [status, setStatus] = useState('Disconnected');
  const [error, setError] = useState('');
  const [remote, setRemote] = useState<RemoteSession | null>(null);
  const [connectingRemote, setConnectingRemote] = useState(false);
  const [viewOnly, setViewOnly] = useState(true);
  const [credentialsReady, setCredentialsReady] = useState(false);

  const vncContainerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const endpointRef = useRef(endpoint);
  const tokenRef = useRef(token);
  const activeStationIdRef = useRef(activeStationId);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const reconnectEnabledRef = useRef(false);
  const remoteStartRequestedRef = useRef(false);
  const selectedSessionRef = useRef(selectedSession);
  const sessionsRef = useRef(sessions);

  useEffect(() => { endpointRef.current = endpoint; }, [endpoint]);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { activeStationIdRef.current = activeStationId; }, [activeStationId]);
  useEffect(() => { selectedSessionRef.current = selectedSession; }, [selectedSession]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => saveStations(stations), [stations]);

  const activeStation = stations.find((station) => station.id === activeStationId) ?? null;

  useEffect(() => {
    if (!activeStation) {
      setCredentialsReady(true);
      return;
    }
    let cancelled = false;
    setCredentialsReady(false);
    setEndpoint(activeStation.endpoint);
    setError('');
    void (async () => {
      try {
        let storedToken = await getCredential(activeStation.endpoint);
        if (!storedToken) {
          const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
          if (legacyToken && stations.length === 1) {
            await setCredential(activeStation.endpoint, legacyToken);
            localStorage.removeItem(LEGACY_TOKEN_KEY);
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
  }, [activeStationId, stations.length]);

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
    const stationId = activeStationIdRef.current;
    if (!stationId || !currentEndpoint || !currentToken) {
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
      if (stationId !== activeStationIdRef.current) {
        await connection.disconnect().catch(() => undefined);
        return;
      }
      endpointRef.current = currentEndpoint;
      setEndpoint(currentEndpoint);
      socketRef.current = connection;
      setSocket(connection);
      clearReconnectTimer();
      reconnectEnabledRef.current = true;
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
            setSelectedSession((current) => current && payload.sessions.some((session) => session.sessionId === current)
              ? current
              : payload.sessions[0]?.sessionId ?? null);
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
        setToken('');
        setError('Agent authentication failed (401). Edit the station and enter a new access token.');
      } else {
        setError(connectError instanceof Error ? connectError.message : String(connectError));
        scheduleReconnect();
      }
    } finally {
      connectingRef.current = false;
    }
  }

  useEffect(() => {
    if (!activeStation || !credentialsReady || !token) return;
    manualDisconnectRef.current = false;
    reconnectEnabledRef.current = true;
    void connectAgent(true);
  }, [activeStationId, credentialsReady, token]);

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
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    setRemote(null);
    setConnectingRemote(false);
  }

  async function disconnectAgent() {
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

  async function selectStation(stationId: string) {
    if (stationId === activeStationIdRef.current) return;
    await disconnectAgent();
    setActiveStationId(stationId);
    setView('monitoring');
  }

  function openNewStation() {
    setEditingStationId(null);
    setStationName('');
    setEndpoint('ws://127.0.0.1:40123/ws');
    setToken('');
    setShowStationEditor(true);
  }

  function editStation(station: Station) {
    setEditingStationId(station.id);
    setStationName(station.name);
    setEndpoint(station.endpoint);
    void getCredential(station.endpoint).then((value) => setToken(value ?? ''));
    setShowStationEditor(true);
  }

  async function saveStation() {
    const normalized = normalizeEndpoint(endpoint);
    const name = stationName.trim() || 'Unnamed Station';
    if (!normalized || !token.trim()) {
      setError('Station address and access token are required.');
      return;
    }
    const id = editingStationId ?? crypto.randomUUID();
    const station = { id, name, endpoint: normalized } satisfies Station;
    if (editingStationId) {
      const old = stations.find((item) => item.id === editingStationId);
      if (old && old.endpoint !== normalized) await deleteCredential(old.endpoint).catch(() => undefined);
      setStations((current) => current.map((item) => item.id === id ? station : item));
    } else {
      setStations((current) => [...current, station]);
    }
    await setCredential(normalized, token.trim());
    setActiveStationId(id);
    setShowStationEditor(false);
    setView('monitoring');
    setError('');
  }

  async function removeStation(station: Station) {
    const wasActive = station.id === activeStationIdRef.current;
    if (wasActive) await disconnectAgent();
    await deleteCredential(station.endpoint).catch(() => undefined);
    const remaining = stations.filter((item) => item.id !== station.id);
    setStations(remaining);
    if (wasActive) setActiveStationId(remaining[0]?.id ?? null);
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
    if (!remote || !vncContainerRef.current) return;
    rfbRef.current?.disconnect();
    const controlEndpoint = new URL(normalizeEndpoint(endpointRef.current));
    controlEndpoint.pathname = `/vnc/${remote.sessionId}`;
    controlEndpoint.search = `?token=${encodeURIComponent(tokenRef.current)}`;
    controlEndpoint.protocol = controlEndpoint.protocol === 'wss:' ? 'wss:' : 'ws:';
    const rfb = new RFB(vncContainerRef.current, controlEndpoint.toString(), {
      credentials: { password: remote.vncPassword },
    });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = viewOnly;
    rfb.showDotCursor = true;
    rfb.addEventListener('connect', () => setError(''));
    rfb.addEventListener('disconnect', () => {
      if (rfbRef.current !== rfb) return;
      rfbRef.current = null;
      setRemote(null);
      setConnectingRemote(false);
    });
    rfb.addEventListener('securityfailure', (event) => {
      setError(`VNC authentication failed: ${event.detail.reason ?? 'Unknown reason'}`);
      setConnectingRemote(false);
    });
    rfbRef.current = rfb;
    return () => {
      rfb.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
    };
  }, [remote]);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  const connectedStationId = socket ? activeStationId : null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="eyebrow">MSM REMOTE</div>
            <h1>{view === 'monitoring' ? 'Monitoring' : view === 'stations' ? 'Stations' : view === 'settings' ? 'Settings' : 'About'}</h1>
          </div>
        </div>
        <div className="topbar-actions">
          {activeStation && <span className="station-pill"><span className={`status-dot ${status === 'Connected' ? 'online' : ''}`} />{identity?.deviceName ?? activeStation.name}</span>}
          <button className="menu-button" type="button" onClick={() => setView(view === 'settings' ? 'monitoring' : 'settings')} aria-label="Settings">⚙</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-section">
            <div className="sidebar-heading"><span>Stations</span><button type="button" onClick={openNewStation}>＋</button></div>
            <button className={`nav-item ${view === 'monitoring' ? 'active' : ''}`} type="button" onClick={() => setView('monitoring')}>▣ <span>Monitoring</span></button>
            <button className={`nav-item ${view === 'stations' ? 'active' : ''}`} type="button" onClick={() => setView('stations')}>▤ <span>Stations</span></button>
          </div>
          <div className="sidebar-section station-list">
            {stations.map((station) => (
              <button key={station.id} className={`station-nav ${activeStationId === station.id ? 'active' : ''}`} type="button" onClick={() => void selectStation(station.id)}>
                <span className={`status-dot ${connectedStationId === station.id ? 'online' : ''}`} />
                <span>{station.name}</span>
              </button>
            ))}
            {!stations.length && <div className="sidebar-empty">No stations configured.</div>}
          </div>
          <div className="sidebar-footer">
            <button className="nav-item" type="button" onClick={() => setView('settings')}>⚙ <span>Settings</span></button>
            <button className="nav-item" type="button" onClick={() => setView('about')}>ⓘ <span>About</span></button>
          </div>
        </aside>

        <section className="content">
          {error && <div className="error-banner">{error}</div>}

          {view === 'monitoring' && (
            <>
              <div className="content-header">
                <div><div className="eyebrow">MONITORING</div><h2>{identity?.deviceName ?? activeStation?.name ?? 'Workstations'}</h2></div>
                <div className="header-actions">
                  {socket ? <button className="secondary-button" type="button" onClick={() => void disconnectAgent()}>Disconnect agent</button> : activeStation && <button className="connect-button" type="button" disabled={!token || !credentialsReady} onClick={() => void connectAgent(false)}>Connect agent</button>}
                </div>
              </div>
              <div className="monitor-grid">
                {sessions.map((session) => {
                  const isConnected = remote?.sessionId === session.sessionId;
                  const isSelected = selectedSession === session.sessionId;
                  return (
                    <article className={`station-card ${isSelected ? 'selected' : ''} ${isConnected ? 'connected' : ''}`} key={session.sessionId}>
                      <div className="preview">
                        <div className="preview-screen"><span>{isConnected ? 'Connected' : 'Remote desktop'}</span></div>
                        <span className={`preview-status ${session.state === 'active' ? 'active' : ''}`} />
                      </div>
                      <div className="station-card-body">
                        <div className="station-title"><strong>{session.username}</strong><span>Session {session.sessionId}</span></div>
                        <div className="station-meta">{session.seatId ? `Seat ${session.seatId}` : session.display ?? 'Windows workstation'}</div>
                        <div className="station-actions">
                          <label className="view-toggle"><input type="checkbox" checked={viewOnly} onChange={(event) => setViewOnly(event.target.checked)} /> View only</label>
                          {isConnected ? <button className="secondary-button" type="button" onClick={disconnectRemote}>Disconnect</button> : <button className="connect-button" type="button" disabled={!socket || connectingRemote} onClick={() => void startRemoteSession(session.sessionId)}>{connectingRemote && isSelected ? 'Starting…' : 'Connect'}</button>}
                        </div>
                      </div>
                    </article>
                  );
                })}
                {!sessions.length && <div className="empty-state"><div className="empty-icon">▦</div><strong>{activeStation ? 'No active sessions' : 'No stations configured'}</strong><span>{activeStation ? 'The agent is connected, but no interactive Windows sessions are currently available.' : 'Add a station to begin monitoring remote Windows sessions.'}</span>{!activeStation && <button className="connect-button" type="button" onClick={openNewStation}>New station</button>}</div>}
              </div>

              <section className="desktop-panel">
                <div className="desktop-toolbar"><div><span className="label">Remote desktop</span><strong>{remote ? `${identity?.deviceName ?? activeStation?.name} · Session ${remote.sessionId}` : 'Select a session and connect'}</strong></div>{remote && <button className="secondary-button" type="button" onClick={disconnectRemote}>Disconnect</button>}</div>
                <div className={`desktop-surface ${remote ? 'active' : ''}`}>
                  <div ref={vncContainerRef} className="vnc-container" />
                  {!remote && <div className="viewer-placeholder"><div className="placeholder-icon">▣</div><h3>Remote desktop</h3><p>Connecting to the agent does not open a desktop automatically.</p></div>}
                </div>
              </section>
            </>
          )}

          {view === 'stations' && (
            <div className="page-panel">
              <div className="content-header"><div><div className="eyebrow">STATIONS</div><h2>Stations</h2></div><button className="connect-button" type="button" onClick={openNewStation}>New station</button></div>
              <div className="station-management-list">
                {stations.map((station) => (
                  <div className="managed-station" key={station.id}>
                    <div className="managed-station-icon">▣</div><div className="managed-station-info"><strong>{station.name}</strong><span>{station.endpoint}</span></div><span className={`status-badge ${activeStationId === station.id && status === 'Connected' ? 'online' : ''}`}>{activeStationId === station.id && status === 'Connected' ? 'Connected' : 'Saved'}</span><button className="secondary-button" type="button" onClick={() => editStation(station)}>Edit</button><button className="danger-button" type="button" onClick={() => void removeStation(station)}>Remove</button>
                  </div>
                ))}
                {!stations.length && <div className="empty-state"><strong>No stations</strong><span>Add your first MSM agent connection.</span><button className="connect-button" type="button" onClick={openNewStation}>New station</button></div>}
              </div>
            </div>
          )}

          {view === 'settings' && <div className="page-panel"><div className="content-header"><div><div className="eyebrow">SETTINGS</div><h2>Settings</h2></div></div><div className="settings-card"><strong>Remote control defaults</strong><label className="setting-row"><span>Start new remote sessions in view-only mode</span><input type="checkbox" checked={viewOnly} onChange={(event) => setViewOnly(event.target.checked)} /></label><p>View-only is enabled by default. Disable it only when you intentionally want to control a remote desktop.</p></div></div>}

          {view === 'about' && <div className="page-panel about-page"><div className="brand-mark large">M</div><div className="eyebrow">MSM REMOTE</div><h2>Remote monitoring and control</h2><p>Manage persistent MSM agent connections and monitor multiple Windows user sessions from one workstation.</p><span>Agent {identity?.agentVersion ?? '—'}</span></div>}
        </section>
      </div>

      {showStationEditor && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowStationEditor(false); }}><form className="station-dialog" onSubmit={(event) => { event.preventDefault(); void saveStation(); }}><div className="dialog-header"><div><div className="eyebrow">STATIONS</div><h2>{editingStationId ? 'Edit station' : 'Add station'}</h2></div><button type="button" className="icon-button" onClick={() => setShowStationEditor(false)}>×</button></div><label>Display name<input value={stationName} onChange={(event) => setStationName(event.target.value)} placeholder="Office PC" autoFocus /></label><label>Host address<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="192.168.1.100:40123" /></label><label>Access token<input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Agent access token" type="password" /></label><p className="dialog-note">The token is stored in the Windows credential store. Connecting to a station discovers its active user sessions; remote desktops are opened only when you click Connect.</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setShowStationEditor(false)}>Cancel</button><button type="submit" className="connect-button">{editingStationId ? 'Save changes' : 'Add station'}</button></div></form></div>}
    </main>
  );
}

export default App;
