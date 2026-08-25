import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import WebSocket from '@tauri-apps/plugin-websocket';
import RFB from '@novnc/novnc';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Checkbox } from './components/ui/checkbox';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import './styles.css';

type Session = { sessionId: string; username: string; state: string; seatId?: string | null; display?: string | null };
type DeviceIdentity = { deviceId: string; deviceName: string; platform: string; architecture: string; agentVersion: string };
type RemoteSession = { sessionId: string; port: number; vncPassword: string };
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
    return typeof saved.endpoint === 'string' && saved.endpoint ? normalizeEndpoint(saved.endpoint) : null;
  } catch { return null; }
}
function saveEndpoint(endpoint: string) { localStorage.setItem(SAVED_CONNECTION_KEY, JSON.stringify({ endpoint: normalizeEndpoint(endpoint) } satisfies SavedConnection)); }
function clearSavedEndpoint() { localStorage.removeItem(SAVED_CONNECTION_KEY); }
function credentialKey(endpoint: string) { return `agent-token:${normalizeEndpoint(endpoint)}`; }
async function getCredential(endpoint: string) { return invoke<string | null>('credential_get', { key: credentialKey(endpoint) }); }
async function setCredential(endpoint: string, token: string) { await invoke('credential_set', { key: credentialKey(endpoint), secret: token }); }
async function deleteCredential(endpoint: string) { await invoke('credential_delete', { key: credentialKey(endpoint) }); }
function isUnauthorizedError(error: unknown) { return /\b401\b|unauthorized|authentication failed|not authorized/i.test(error instanceof Error ? error.message : String(error)); }

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
  const remoteStartRequestedRef = useRef(false);

  useEffect(() => { endpointRef.current = endpoint; }, [endpoint]);
  useEffect(() => { tokenRef.current = token; }, [token]);
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
        if (!cancelled) { setToken(storedToken ?? ''); setCredentialsReady(true); }
      } catch (credentialError) {
        if (!cancelled) { setCredentialsReady(true); setError(`Unable to access the Windows credential store: ${credentialError instanceof Error ? credentialError.message : String(credentialError)}`); }
      }
    })();
    return () => { cancelled = true; };
  }, [initialEndpoint]);

  function clearReconnectTimer() { if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; } }
  async function disconnectSocket() {
    const current = socketRef.current; socketRef.current = null; setSocket(null);
    if (current) { try { await current.disconnect(); } catch { /* already closed */ } }
  }
  function scheduleReconnect() {
    if (!reconnectEnabledRef.current || manualDisconnectRef.current || !tokenRef.current || reconnectTimerRef.current) return;
    setStatus('Reconnecting…');
    reconnectTimerRef.current = setTimeout(() => { reconnectTimerRef.current = null; void connectAgent(true); }, RECONNECT_DELAY_MS);
  }
  async function refreshSessions(connection: WebSocket) {
    try { await connection.send(JSON.stringify({ type: 'listSessions' })); } catch { await disconnectSocket(); scheduleReconnect(); }
  }
  async function connectAgent(isReconnect = false): Promise<void> {
    if (connectingRef.current || socketRef.current || !credentialsReady) return;
    const currentEndpoint = normalizeEndpoint(endpointRef.current);
    const currentToken = tokenRef.current.trim();
    if (!currentEndpoint || !currentToken) { setStatus('Disconnected'); return; }
    connectingRef.current = true; manualDisconnectRef.current = false; setError(''); setStatus(isReconnect ? 'Reconnecting…' : 'Connecting…');
    try {
      const connection = await WebSocket.connect(currentEndpoint, { headers: { Authorization: `Bearer ${currentToken}` } });
      endpointRef.current = currentEndpoint; setEndpoint(currentEndpoint); setToken(currentToken);
      if (rememberConnection) { saveEndpoint(currentEndpoint); await setCredential(currentEndpoint, currentToken); reconnectEnabledRef.current = true; }
      else reconnectEnabledRef.current = false;
      socketRef.current = connection; setSocket(connection); clearReconnectTimer();
      connection.addListener((message) => {
        if (message.type !== 'Text') return;
        try {
          const payload = JSON.parse(message.data) as AgentMessage;
          if (payload.type === 'hello') { setIdentity(payload.identity); setStatus('Connected'); setError(''); void refreshSessions(connection); return; }
          if (payload.type === 'sessions') { setSessions(payload.sessions); setSelectedSession((current) => current && payload.sessions.some((session) => session.sessionId === current) ? current : payload.sessions[0]?.sessionId ?? null); return; }
          if (payload.type === 'remoteSession') { if (!remoteStartRequestedRef.current) return; remoteStartRequestedRef.current = false; setRemote(payload.session); setConnectingRemote(false); return; }
          if (payload.type === 'error') { remoteStartRequestedRef.current = false; setConnectingRemote(false); setError(payload.message); }
        } catch { setError('Received an invalid message from the agent.'); }
      });
    } catch (connectError) {
      setStatus('Disconnected');
      if (isUnauthorizedError(connectError)) { await deleteCredential(currentEndpoint).catch(() => undefined); clearSavedEndpoint(); setRememberConnection(false); reconnectEnabledRef.current = false; setToken(''); setError('Agent authentication failed (401). Enter a new access token.'); }
      else { setError(connectError instanceof Error ? connectError.message : String(connectError)); scheduleReconnect(); }
    } finally { connectingRef.current = false; }
  }
  useEffect(() => { if (initialEndpoint && credentialsReady && token) void connectAgent(true); }, [credentialsReady, token]);
  useEffect(() => {
    const interval = setInterval(() => { const current = socketRef.current; if (current && !manualDisconnectRef.current) void refreshSessions(current); }, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => () => { manualDisconnectRef.current = true; clearReconnectTimer(); void socketRef.current?.disconnect(); rfbRef.current?.disconnect(); }, []);

  function disconnectRemote() { remoteStartRequestedRef.current = false; rfbRef.current?.disconnect(); rfbRef.current = null; setRemote(null); setConnectingRemote(false); }
  async function disconnect() { manualDisconnectRef.current = true; reconnectEnabledRef.current = false; clearReconnectTimer(); disconnectRemote(); await disconnectSocket(); setIdentity(null); setSessions([]); setSelectedSession(null); setStatus('Disconnected'); }
  async function forgetConnection() { const currentEndpoint = normalizeEndpoint(endpointRef.current); manualDisconnectRef.current = true; reconnectEnabledRef.current = false; clearReconnectTimer(); await deleteCredential(currentEndpoint).catch(() => undefined); clearSavedEndpoint(); setRememberConnection(false); setToken(''); setError('Saved agent connection removed.'); }
  async function startRemoteSession(sessionId: string) {
    const current = socketRef.current;
    if (!current || !sessionId || remote?.sessionId === sessionId) return;
    disconnectRemote(); setSelectedSession(sessionId); setError(''); setConnectingRemote(true); remoteStartRequestedRef.current = true;
    try { await current.send(JSON.stringify({ type: 'startSession', sessionId })); }
    catch { remoteStartRequestedRef.current = false; setConnectingRemote(false); setError('The agent connection was lost. Reconnecting…'); await disconnectSocket(); scheduleReconnect(); }
  }
  useEffect(() => {
    if (!remote || !viewerRef.current) return;
    rfbRef.current?.disconnect(); viewerRef.current.replaceChildren();
    const controlEndpoint = new URL(normalizeEndpoint(endpoint)); controlEndpoint.pathname = `/vnc/${remote.sessionId}`; controlEndpoint.search = `?token=${encodeURIComponent(token)}`; controlEndpoint.protocol = controlEndpoint.protocol === 'wss:' ? 'wss:' : 'ws:';
    const rfb = new RFB(viewerRef.current, controlEndpoint.toString(), { credentials: { password: remote.vncPassword } });
    rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = viewOnly; rfb.showDotCursor = true;
    rfb.addEventListener('connect', () => setError(''));
    rfb.addEventListener('disconnect', () => { rfbRef.current = null; setRemote(null); setConnectingRemote(false); });
    rfb.addEventListener('securityfailure', (event) => { setError(`VNC authentication failed: ${event.detail.reason ?? 'Unknown reason'}`); setConnectingRemote(false); });
    rfbRef.current = rfb;
    return () => rfb.disconnect();
  }, [remote, endpoint, token, viewOnly]);

  const hasSavedConnection = Boolean(loadSavedEndpoint());
  const isBusy = status === 'Connecting…' || status === 'Reconnecting…';
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">M</div><div><div className="eyebrow">MSM · WINDOWS</div><h1>Remote Monitor &amp; Control</h1></div></div>
        <div className="station-pill"><span className={`status-dot ${status === 'Connected' ? 'online' : ''}`} />{identity ? `${identity.deviceName} · ${status}` : status}</div>
      </header>
      <section className="connection-bar shadcn-toolbar">
        <Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="ws://host:40123/ws" disabled={Boolean(socket)} aria-label="Agent endpoint" />
        <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Agent access token" type="password" disabled={Boolean(socket)} aria-label="Agent access token" />
        {socket ? <Button variant="outline" onClick={() => void disconnect()}>Disconnect agent</Button> : <Button onClick={() => void connectAgent(false)} disabled={!endpoint || !token || !credentialsReady || isBusy}>{isBusy ? 'Connecting…' : 'Connect agent'}</Button>}
        <Label className="inline-option"><Checkbox checked={rememberConnection} onChange={(event) => {
          const checked = event.target.checked; setRememberConnection(checked); reconnectEnabledRef.current = checked; const currentEndpoint = normalizeEndpoint(endpoint);
          if (checked && token.trim()) { saveEndpoint(currentEndpoint); void setCredential(currentEndpoint, token.trim()).catch((credentialError) => setError(`Unable to save credentials: ${credentialError}`)); }
          else if (!checked) { clearSavedEndpoint(); void deleteCredential(currentEndpoint).catch(() => undefined); }
        }} />Remember</Label>
        {hasSavedConnection && !socket && <Button variant="ghost" size="sm" onClick={() => void forgetConnection()}>Forget</Button>}
      </section>
      {error && <div className="error-banner">{error}</div>}
      <section className="connection-grid-panel">
        <div className="section-heading"><div><div className="eyebrow">MONITORING</div><h2>Remote connections</h2></div><Badge>{sessions.length} session{sessions.length === 1 ? '' : 's'}</Badge></div>
        <div className="connection-grid">
          {sessions.map((session) => {
            const isConnected = remote?.sessionId === session.sessionId; const isSelected = selectedSession === session.sessionId;
            return <Card className={`connection-card ${isSelected ? 'selected' : ''} ${isConnected ? 'connected' : ''}`} key={session.sessionId}>
              <CardHeader><div className="connection-card-header"><span className={`status-dot ${session.state === 'active' ? 'active' : 'locked'}`} /><Badge className={isConnected ? 'status-badge-online' : ''}>{isConnected ? 'Connected' : session.state}</Badge></div><CardTitle>{session.username}</CardTitle><span>Session {session.sessionId}{session.seatId ? ` · Seat ${session.seatId}` : ''}</span></CardHeader>
              <CardContent><div className="connection-card-actions"><Label className="inline-option"><Checkbox checked={viewOnly} onChange={(event) => setViewOnly(event.target.checked)} />View only</Label>{isConnected ? <Button variant="outline" onClick={disconnectRemote}>Disconnect</Button> : <Button disabled={!socket || connectingRemote} onClick={() => void startRemoteSession(session.sessionId)}>{connectingRemote && isSelected ? 'Starting…' : 'Connect'}</Button>}</div></CardContent>
            </Card>;
          })}
          {!sessions.length && <div className="empty-state">Connect to an MSM agent to discover active Windows sessions.</div>}
        </div>
      </section>
      <section className="viewer-panel shadcn-card">
        <div className="viewer-toolbar"><div><span className="label">Remote desktop</span><strong>{remote ? `Connected · Session ${remote.sessionId}` : 'Not connected'}</strong></div><div className="viewer-actions">{remote && <Button variant="outline" onClick={disconnectRemote}>Disconnect</Button>}</div></div>
        <div className={`viewer-surface ${remote ? 'active' : ''}`} ref={viewerRef}>{!remote && <div className="viewer-placeholder"><div className="placeholder-icon">▣</div><h2>Remote desktop</h2><p>Select a session above and click Connect.</p></div>}</div>
      </section>
    </main>
  );
}
export default App;
