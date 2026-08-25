import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { Activity, CircleHelp, Eye, EyeOff, Monitor, Settings2, Wifi, WifiOff, X } from 'lucide-react';
import WebSocket from '@tauri-apps/plugin-websocket';
import RFB from '@novnc/novnc';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Checkbox } from './components/ui/checkbox';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { cn } from './lib/utils';
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
type RemoteConnection = RemoteSession & { username: string };

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

type RemoteViewerProps = {
  remote: RemoteConnection;
  endpoint: string;
  token: string;
  viewOnly: boolean;
  onDisconnect: () => void;
  onError: (message: string) => void;
};

function RemoteViewer({ remote, endpoint, token, viewOnly, onDisconnect, onError }: RemoteViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const disposingRef = useRef(false);
  const viewOnlyRef = useRef(viewOnly);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  useEffect(() => { viewOnlyRef.current = viewOnly; }, [viewOnly]);
  useEffect(() => { onDisconnectRef.current = onDisconnect; }, [onDisconnect]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposingRef.current = false;

    const controlEndpoint = new URL(normalizeEndpoint(endpoint));
    controlEndpoint.pathname = `/vnc/${remote.sessionId}`;
    controlEndpoint.search = `token=${encodeURIComponent(token)}`;
    controlEndpoint.protocol = controlEndpoint.protocol === 'wss:' ? 'wss:' : 'ws:';

    container.replaceChildren();
    const rfb = new RFB(container, controlEndpoint.toString(), { credentials: { password: remote.vncPassword } });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.viewOnly = viewOnly;
    rfb.showDotCursor = true;
    rfb.addEventListener('connect', () => onErrorRef.current(''));
    rfb.addEventListener('clipboard', (event) => {
      if (navigator.clipboard) {
        void navigator.clipboard.writeText(event.detail.text).catch(() => undefined);
      }
    });
    rfb.addEventListener('securityfailure', (event) => onErrorRef.current(`VNC authentication failed: ${event.detail.reason ?? 'Unknown reason'}`));
    rfb.addEventListener('disconnect', (event) => {
      // Ignore disconnects caused by this effect's cleanup. In development React
      // may mount/cleanup/mount an effect twice, and that local cleanup must not
      // remove the viewer from application state.
      if (!disposingRef.current && event.detail.clean) onDisconnectRef.current();
    });
    rfbRef.current = rfb;

    const handlePaste = (event: ClipboardEvent) => {
      if (viewOnlyRef.current || !event.clipboardData || !rfbRef.current) return;
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      rfb.clipboardPasteFrom(text);
    };
    container.addEventListener('paste', handlePaste);

    const resizeObserver = new ResizeObserver(() => {
      if (rfbRef.current === rfb) rfb.scaleViewport = true;
    });
    resizeObserver.observe(container);

    return () => {
      disposingRef.current = true;
      container.removeEventListener('paste', handlePaste);
      resizeObserver.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
      try { rfb.disconnect(); } catch { /* already disconnected */ }
      container.replaceChildren();
    };
  }, [remote.sessionId, remote.vncPassword, endpoint, token]);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  return <div ref={containerRef} className="vnc-surface h-full w-full min-h-0" />;
}

function App() {
  const initialEndpoint = loadSavedEndpoint();
  const [endpoint, setEndpoint] = useState(initialEndpoint ?? 'ws://127.0.0.1:40123/ws');
  const [token, setToken] = useState('');
  const [rememberConnection, setRememberConnection] = useState(Boolean(initialEndpoint));
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [status, setStatus] = useState('Disconnected');
  const [error, setError] = useState('');
  const [remoteConnections, setRemoteConnections] = useState<RemoteConnection[]>([]);
  const [connectingSessions, setConnectingSessions] = useState<Set<string>>(new Set());
  const [viewOnly, setViewOnly] = useState(true);
  const [credentialsReady, setCredentialsReady] = useState(!initialEndpoint);
  const [activePage, setActivePage] = useState<'monitoring' | 'settings' | 'about'>('monitoring');

  const socketRef = useRef<WebSocket | null>(null);
  const endpointRef = useRef(endpoint);
  const tokenRef = useRef(token);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const reconnectEnabledRef = useRef(Boolean(initialEndpoint));
  const pendingRemoteRequestsRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef<Session[]>([]);

  useEffect(() => { endpointRef.current = endpoint; }, [endpoint]);
  useEffect(() => { tokenRef.current = token; }, [token]);
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
        if (!cancelled) { setToken(storedToken ?? ''); setCredentialsReady(true); }
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
      try { await current.disconnect(); } catch { /* already closed */ }
    }
  }

  function scheduleReconnect() {
    if (!reconnectEnabledRef.current || manualDisconnectRef.current || !tokenRef.current || reconnectTimerRef.current) return;
    setStatus('Reconnecting…');
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void connectAgent(true);
    }, RECONNECT_DELAY_MS);
  }

  async function refreshSessions(connection: WebSocket) {
    try { await connection.send(JSON.stringify({ type: 'listSessions' })); }
    catch {
      await disconnectSocket();
      scheduleReconnect();
    }
  }

  async function connectAgent(isReconnect = false): Promise<void> {
    if (connectingRef.current || socketRef.current || !credentialsReady) return;
    const currentEndpoint = normalizeEndpoint(endpointRef.current);
    const currentToken = tokenRef.current.trim();
    if (!currentEndpoint || !currentToken) { setStatus('Disconnected'); return; }

    connectingRef.current = true;
    manualDisconnectRef.current = false;
    setError('');
    setStatus(isReconnect ? 'Reconnecting…' : 'Connecting…');
    try {
      const connection = await WebSocket.connect(currentEndpoint, { headers: { Authorization: `Bearer ${currentToken}` } });
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
            return;
          }
          if (payload.type === 'remoteSession') {
            const sessionId = payload.session.sessionId;
            if (!pendingRemoteRequestsRef.current.has(sessionId)) return;
            pendingRemoteRequestsRef.current.delete(sessionId);
            setConnectingSessions((current) => {
              const next = new Set(current);
              next.delete(sessionId);
              return next;
            });
            setRemoteConnections((current) => {
              if (current.some((item) => item.sessionId === sessionId)) return current;
              const session = sessionsRef.current.find((item) => item.sessionId === sessionId);
              return [...current, { ...payload.session, username: session?.username ?? `Session ${sessionId}` }];
            });
            return;
          }
          if (payload.type === 'error') {
            pendingRemoteRequestsRef.current.clear();
            setConnectingSessions(new Set());
            setError(payload.message);
          }
        } catch { setError('Received an invalid message from the agent.'); }
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
    if (initialEndpoint && credentialsReady && token) void connectAgent(true);
  }, [credentialsReady, token]);

  useEffect(() => {
    const interval = setInterval(() => {
      const current = socketRef.current;
      if (current && !manualDisconnectRef.current) void refreshSessions(current);
    }, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => () => {
    manualDisconnectRef.current = true;
    clearReconnectTimer();
    void socketRef.current?.disconnect();
  }, []);

  async function disconnect() {
    manualDisconnectRef.current = true;
    reconnectEnabledRef.current = false;
    clearReconnectTimer();
    pendingRemoteRequestsRef.current.clear();
    setConnectingSessions(new Set());
    setRemoteConnections([]);
    await disconnectSocket();
    setIdentity(null);
    setSessions([]);
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

  async function startRemoteSession(sessionId: string) {
    const current = socketRef.current;
    if (!current || !sessionId || remoteConnections.some((item) => item.sessionId === sessionId) || pendingRemoteRequestsRef.current.has(sessionId)) return;
    setError('');
    pendingRemoteRequestsRef.current.add(sessionId);
    setConnectingSessions((currentSet) => new Set(currentSet).add(sessionId));
    try {
      await current.send(JSON.stringify({ type: 'startSession', sessionId }));
    } catch {
      pendingRemoteRequestsRef.current.delete(sessionId);
      setConnectingSessions((currentSet) => {
        const next = new Set(currentSet);
        next.delete(sessionId);
        return next;
      });
      setError('The agent connection was lost. Reconnecting…');
      await disconnectSocket();
      scheduleReconnect();
    }
  }

  function disconnectRemote(sessionId: string) {
    pendingRemoteRequestsRef.current.delete(sessionId);
    setConnectingSessions((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    setRemoteConnections((current) => current.filter((item) => item.sessionId !== sessionId));
  }

  const hasSavedConnection = Boolean(loadSavedEndpoint());
  const isBusy = status === 'Connecting…' || status === 'Reconnecting…';

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="relative flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground"><Monitor className="h-4 w-4" /></div>
          <div className="leading-tight"><p className="text-sm font-semibold">MSM Viewer</p><p className="text-[11px] text-muted-foreground">Remote workstation management</p></div>
        </div>
        <nav className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
          <Button variant={activePage === 'monitoring' ? 'secondary' : 'ghost'} size="sm" onClick={() => setActivePage('monitoring')}><Activity className="h-4 w-4" /> Monitoring</Button>
          <Button variant={activePage === 'settings' ? 'secondary' : 'ghost'} size="sm" onClick={() => setActivePage('settings')}><Settings2 className="h-4 w-4" /> Settings</Button>
          <Button variant={activePage === 'about' ? 'secondary' : 'ghost'} size="sm" onClick={() => setActivePage('about')}><CircleHelp className="h-4 w-4" /> About</Button>
        </nav>
        <Badge variant={status === 'Connected' ? 'default' : 'outline'} className="gap-1.5">{status === 'Connected' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{identity?.deviceName ?? status}</Badge>
      </header>

      {activePage === 'monitoring' && <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
          <div className="border-b p-4"><div className="flex items-center justify-between"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sessions</p><p className="mt-1 font-semibold">{identity?.deviceName ?? 'No agent'}</p></div><Badge variant="outline">{sessions.length}</Badge></div></div>
          <div className="flex-1 overflow-y-auto p-2">
            {sessions.map((session) => {
              const connected = remoteConnections.some((item) => item.sessionId === session.sessionId);
              const connecting = connectingSessions.has(session.sessionId);
              return <div key={session.sessionId} className="mb-2 rounded-lg border bg-background p-2.5"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{session.username}</p><p className="text-xs text-muted-foreground">Session {session.sessionId}</p></div><span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', session.state === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground')} /></div>{connected ? <Button className="mt-2 w-full" variant="outline" size="sm" onClick={() => disconnectRemote(session.sessionId)}>Disconnect</Button> : <Button className="mt-2 w-full" size="sm" disabled={!socket || connecting} onClick={() => void startRemoteSession(session.sessionId)}>{connecting ? 'Connecting…' : 'Connect'}</Button>}</div>;
            })}
            {!sessions.length && <div className="p-4 text-center text-sm text-muted-foreground">{socket ? 'No active user sessions.' : 'Connect to an MSM agent.'}</div>}
          </div>
          <div className="border-t p-3"><Button className="w-full" variant="outline" onClick={() => void disconnect()} disabled={!socket}>Disconnect agent</Button></div>
        </aside>

        <main className="min-w-0 flex-1 overflow-auto">
          <div className="flex min-h-full flex-col">
            <div className="border-b px-5 py-4"><div className="flex items-center justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Monitoring</p><h1 className="mt-1 text-xl font-semibold">Remote viewers</h1><p className="mt-1 text-sm text-muted-foreground">Connect individual sessions from the list. Sessions are never opened automatically.</p></div><Label className="flex shrink-0 items-center gap-2 text-sm"><Checkbox checked={viewOnly} onCheckedChange={(checked) => setViewOnly(checked === true)} />{viewOnly ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />} View only</Label></div></div>
            {error && <div className="border-b bg-destructive/10 px-5 py-2.5 text-sm text-destructive">{error}</div>}
            <section className="flex-1 p-5">
              {remoteConnections.length === 0 ? <div className="flex min-h-[360px] items-center justify-center rounded-xl border bg-muted/10 text-center"><div><Monitor className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" /><p className="text-sm font-medium">No remote viewers connected</p><p className="mt-1 text-xs text-muted-foreground">Choose a session from the list on the left.</p></div></div> : <div className="grid auto-rows-[minmax(260px,1fr)] gap-4 sm:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3">{remoteConnections.map((remote) => <Card key={remote.sessionId} className="flex min-h-0 flex-col overflow-hidden"><CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3"><div className="min-w-0"><CardTitle className="truncate text-sm">{remote.username}</CardTitle><p className="text-xs text-muted-foreground">Session {remote.sessionId}</p></div><Button variant="ghost" size="icon" aria-label={`Disconnect ${remote.username}`} onClick={() => disconnectRemote(remote.sessionId)}><X className="h-4 w-4" /></Button></CardHeader><CardContent className="relative min-h-0 flex-1 bg-zinc-950 p-0"><RemoteViewer remote={remote} endpoint={endpoint} token={token} viewOnly={viewOnly} onDisconnect={() => disconnectRemote(remote.sessionId)} onError={setError} /></CardContent></Card>)}</div>}
            </section>
          </div>
        </main>
      </div>}

      {activePage === 'settings' && <main className="flex-1 overflow-auto"><div className="mx-auto max-w-3xl p-6"><div className="mb-6"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</p><h1 className="mt-1 text-2xl font-semibold">Connection</h1><p className="mt-1 text-sm text-muted-foreground">Manage the saved agent endpoint and authentication credential.</p></div><Card><CardHeader><CardTitle>Agent connection</CardTitle></CardHeader><CardContent className="space-y-4"><div className="space-y-2"><Label htmlFor="settings-endpoint">Endpoint</Label><Input id="settings-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} disabled={Boolean(socket)} /></div><div className="space-y-2"><Label htmlFor="settings-token">Access token</Label><Input id="settings-token" value={token} onChange={(event) => setToken(event.target.value)} type="password" disabled={Boolean(socket)} /></div><div className="flex items-center justify-between rounded-lg border p-3"><Label className="flex items-center gap-2"><Checkbox checked={rememberConnection} onCheckedChange={(checked) => setRememberConnection(checked === true)} /> Remember this connection</Label>{hasSavedConnection && <Button variant="outline" size="sm" onClick={() => void forgetConnection()}>Forget saved credential</Button>}</div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => void disconnect()} disabled={!socket}>Disconnect</Button><Button onClick={() => void connectAgent(false)} disabled={Boolean(socket) || !endpoint || !token || !credentialsReady}>{isBusy ? 'Connecting…' : 'Connect'}</Button></div></CardContent></Card></div></main>}
      {activePage === 'about' && <main className="flex flex-1 items-center justify-center p-6"><Card className="w-full max-w-2xl"><CardHeader><CardTitle>MSM Viewer</CardTitle></CardHeader><CardContent className="grid gap-3 text-sm"><div className="flex justify-between border-b pb-3"><span className="text-muted-foreground">Agent</span><span>{identity?.deviceName ?? 'Not connected'}</span></div><div className="flex justify-between border-b pb-3"><span className="text-muted-foreground">Platform</span><span>{identity?.platform ?? '—'}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Version</span><span>{identity?.agentVersion ?? '—'}</span></div></CardContent></Card></main>}
    </div>
  );
}

export default App;