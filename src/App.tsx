import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { Activity, ChevronDown, CircleHelp, Eye, EyeOff, Laptop2, Monitor, MoreHorizontal, PanelLeft, Settings2, Wifi, WifiOff } from 'lucide-react';
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
  if (/^https?:\\/\\//i.test(value)) {
    const ws = value.replace(/^http/i, 'ws').replace(/\\/$/, '');
    return ws.endsWith('/ws') ? ws : `${ws}/ws`;
  }
  if (/^wss?:\\/\\//i.test(value)) {
    const ws = value.replace(/\\/$/, '');
    return ws.endsWith('/ws') ? ws : `${ws}/ws`;
  }
  return `ws://${value.replace(/\\/$/, '')}/ws`;
}

function loadSavedEndpoint(): string | null {
  try {
    const raw = localStorage.getItem(SAVED_CONNECTION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedConnection>;
    return typeof saved.endpoint === 'string' && saved.endpoint ? normalizeEndpoint(saved.endpoint) : null;
  } catch {
    return null;
  }
}

function saveEndpoint(endpoint: string) {
  localStorage.setItem(SAVED_CONNECTION_KEY, JSON.stringify({ endpoint: normalizeEndpoint(endpoint) } satisfies SavedConnection));
}

function clearSavedEndpoint() {
  localStorage.removeItem(SAVED_CONNECTION_KEY);
}

function credentialKey(endpoint: string) {
  return `agent-token:${normalizeEndpoint(endpoint)}`;
}

async function getCredential(endpoint: string) {
  return invoke<string | null>('credential_get', { key: credentialKey(endpoint) });
}

async function setCredential(endpoint: string, token: string) {
  await invoke('credential_set', { key: credentialKey(endpoint), secret: token });
}

async function deleteCredential(endpoint: string) {
  await invoke('credential_delete', { key: credentialKey(endpoint) });
}

function isUnauthorizedError(error: unknown) {
  return /\\b401\\b|unauthorized|authentication failed|not authorized/i.test(error instanceof Error ? error.message : String(error));
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activePage, setActivePage] = useState<'monitoring' | 'settings' | 'about'>('monitoring');

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
    rfbRef.current?.disconnect();
  }, []);

  function disconnectRemote() {
    remoteStartRequestedRef.current = false;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
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

  async function startRemoteSession(sessionId: string) {
    const current = socketRef.current;
    if (!current || !sessionId || remote?.sessionId === sessionId) return;
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
    rfbRef.current?.disconnect();
    const controlEndpoint = new URL(normalizeEndpoint(endpoint));
    controlEndpoint.pathname = `/vnc/${remote.sessionId}`;
    controlEndpoint.search = `?token=${encodeURIComponent(token)}`;
    controlEndpoint.protocol = controlEndpoint.protocol === 'wss:' ? 'wss:' : 'ws:';
    const rfb = new RFB(viewerRef.current, controlEndpoint.toString(), {
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
  }, [remote, endpoint, token, viewOnly]);

  const hasSavedConnection = Boolean(loadSavedEndpoint());
  const isBusy = status === 'Connecting…' || status === 'Reconnecting…';

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen((open) => !open)} aria-label="Toggle navigation">
            <PanelLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Monitor className="h-4 w-4" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold">MSM Viewer</p>
              <p className="text-[11px] text-muted-foreground">Remote workstation management</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={status === 'Connected' ? 'default' : 'outline'} className="gap-1.5">
            {status === 'Connected' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {identity?.deviceName ?? status}
          </Badge>
          <Button variant="ghost" size="icon" aria-label="More options"><MoreHorizontal className="h-4 w-4" /></Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="hidden w-56 shrink-0 border-r bg-muted/30 md:flex md:flex-col">
            <div className="border-b p-3">
              <p className="px-2 text-xs font-medium text-muted-foreground">WORKSPACE</p>
            </div>
            <nav className="flex-1 space-y-1 p-2">
              <Button variant={activePage === 'monitoring' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setActivePage('monitoring')}>
                <Activity className="h-4 w-4" /> Monitoring
              </Button>
              <Button variant={activePage === 'settings' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setActivePage('settings')}>
                <Settings2 className="h-4 w-4" /> Connection settings
              </Button>
              <Button variant={activePage === 'about' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setActivePage('about')}>
                <CircleHelp className="h-4 w-4" /> About
              </Button>
            </nav>
            <div className="border-t p-3">
              <div className="rounded-lg border bg-background p-3 text-xs">
                <div className="mb-1 flex items-center gap-2 font-medium"><Laptop2 className="h-3.5 w-3.5" /> Agent</div>
                <p className="truncate text-muted-foreground">{identity?.deviceName ?? 'No agent connected'}</p>
              </div>
            </div>
          </aside>
        )}

        <main className="min-w-0 flex-1 overflow-auto">
          {activePage === 'monitoring' && (
            <div className="flex min-h-full flex-col">
              <div className="border-b bg-background px-5 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Monitoring</p>
                    <h1 className="mt-1 text-xl font-semibold tracking-tight">Workstations</h1>
                    <p className="mt-1 text-sm text-muted-foreground">Connect to an agent, then choose a user session to view or control.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{sessions.length} session{sessions.length === 1 ? '' : 's'}</Badge>
                    {socket && <Button variant="outline" onClick={() => void disconnect()}>Disconnect agent</Button>}
                  </div>
                </div>
              </div>

              <div className="border-b bg-muted/30 px-5 py-3">
                <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto] md:items-center">
                  <Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="ws://host:40123/ws" disabled={Boolean(socket)} aria-label="Agent endpoint" />
                  <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Agent access token" type="password" disabled={Boolean(socket)} aria-label="Agent access token" />
                  {socket ? <Button variant="outline" onClick={() => void disconnect()}>Disconnect</Button> : <Button onClick={() => void connectAgent(false)} disabled={!endpoint || !token || !credentialsReady || isBusy}>{isBusy ? 'Connecting…' : 'Connect'}</Button>}
                  <Label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Checkbox checked={rememberConnection} onCheckedChange={(checked) => {
                      const next = checked === true;
                      setRememberConnection(next);
                      reconnectEnabledRef.current = next;
                      const currentEndpoint = normalizeEndpoint(endpoint);
                      if (next && token.trim()) {
                        saveEndpoint(currentEndpoint);
                        void setCredential(currentEndpoint, token.trim()).catch((credentialError) => setError(`Unable to save credentials: ${credentialError}`));
                      } else if (!next) {
                        clearSavedEndpoint();
                        void deleteCredential(currentEndpoint).catch(() => undefined);
                      }
                    }} />
                    Remember
                  </Label>
                  {hasSavedConnection && !socket && <Button variant="ghost" size="sm" onClick={() => void forgetConnection()}>Forget</Button>}
                </div>
              </div>

              {error && <div className="border-b bg-destructive/10 px-5 py-2.5 text-sm text-destructive">{error}</div>}

              <section className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold">Sessions</h2>
                    <p className="text-xs text-muted-foreground">Each card represents one active user session.</p>
                  </div>
                  <Badge variant="outline">Default: view only</Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {sessions.map((session) => {
                    const isConnected = remote?.sessionId === session.sessionId;
                    const isSelected = selectedSession === session.sessionId;
                    return (
                      <Card key={session.sessionId} className={cn('transition-shadow', isSelected && 'ring-1 ring-ring', isConnected && 'shadow-md')}>
                        <CardHeader className="pb-3">
                          <div className="flex items-center justify-between gap-2">
                            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1.5">
                              <span className={cn('h-1.5 w-1.5 rounded-full bg-muted-foreground', session.state === 'active' && 'bg-emerald-500')} />
                              {isConnected ? 'Connected' : session.state}
                            </Badge>
                            <Button variant="ghost" size="icon" aria-label={`Options for ${session.username}`}><MoreHorizontal className="h-4 w-4" /></Button>
                          </div>
                          <CardTitle className="text-base">{session.username}</CardTitle>
                          <p className="text-xs text-muted-foreground">Session {session.sessionId}{session.seatId ? ` · Seat ${session.seatId}` : ''}</p>
                        </CardHeader>
                        <CardContent>
                          <div className="flex items-center justify-between gap-3">
                            <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Checkbox checked={viewOnly} onCheckedChange={(checked) => setViewOnly(checked === true)} />
                              {viewOnly ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                              View only
                            </Label>
                            {isConnected ? <Button variant="outline" size="sm" onClick={disconnectRemote}>Disconnect</Button> : <Button size="sm" disabled={!socket || connectingRemote} onClick={() => void startRemoteSession(session.sessionId)}>{connectingRemote && isSelected ? 'Starting…' : 'Connect'}</Button>}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                  {!sessions.length && (
                    <Card className="sm:col-span-2 xl:col-span-3 2xl:col-span-4">
                      <CardContent className="flex min-h-28 items-center justify-center text-center text-sm text-muted-foreground">
                        {socket ? 'No active user sessions were reported by the agent.' : 'Connect to an MSM agent to discover active Windows sessions.'}
                      </CardContent>
                    </Card>
                  )}
                </div>
              </section>

              <section className="min-h-[360px] flex-1 border-t bg-muted/20 p-5">
                <div className="flex h-full min-h-[340px] flex-col overflow-hidden rounded-xl border bg-background shadow-sm">
                  <div className="flex min-h-14 items-center justify-between border-b px-4 py-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Remote desktop</p>
                      <p className="mt-0.5 text-sm font-medium">{remote ? `Session ${remote.sessionId}` : 'No session connected'}</p>
                    </div>
                    {remote && <Button variant="outline" size="sm" onClick={disconnectRemote}>Disconnect</Button>}
                  </div>
                  <div className="relative min-h-0 flex-1 overflow-hidden bg-zinc-950">
                    <div ref={viewerRef} className="vnc-surface h-full w-full" />
                    {!remote && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center">
                        <div>
                          <Monitor className="mx-auto mb-3 h-8 w-8 text-zinc-600" />
                          <p className="text-sm font-medium text-zinc-400">Remote desktop</p>
                          <p className="mt-1 text-xs text-zinc-600">Connect to a session to start viewing.</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}

          {activePage === 'settings' && (
            <div className="mx-auto max-w-3xl p-6">
              <div className="mb-6">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">Connection</h1>
                <p className="mt-1 text-sm text-muted-foreground">Manage the saved agent endpoint and authentication credential.</p>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Agent connection</CardTitle>
                  <p className="text-sm text-muted-foreground">Credentials are stored using the application credential store.</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2"><Label htmlFor="settings-endpoint">Endpoint</Label><Input id="settings-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} disabled={Boolean(socket)} /></div>
                  <div className="space-y-2"><Label htmlFor="settings-token">Access token</Label><Input id="settings-token" value={token} onChange={(event) => setToken(event.target.value)} type="password" disabled={Boolean(socket)} /></div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <Label className="flex items-center gap-2"><Checkbox checked={rememberConnection} onCheckedChange={(checked) => setRememberConnection(checked === true)} /> Remember this connection</Label>
                    {hasSavedConnection && <Button variant="outline" size="sm" onClick={() => void forgetConnection()}>Forget saved credential</Button>}
                  </div>
                  <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => void disconnect()} disabled={!socket}>Disconnect</Button><Button onClick={() => void connectAgent(false)} disabled={Boolean(socket) || !endpoint || !token || !credentialsReady}>{isBusy ? 'Connecting…' : 'Connect'}</Button></div>
                </CardContent>
              </Card>
            </div>
          )}

          {activePage === 'about' && (
            <div className="mx-auto flex min-h-full max-w-2xl items-center p-6">
              <Card className="w-full">
                <CardHeader>
                  <CardTitle>MSM Viewer</CardTitle>
                  <p className="text-sm text-muted-foreground">Remote monitoring and VNC access for MSM multiseat agents.</p>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                  <div className="flex justify-between border-b pb-3"><span className="text-muted-foreground">Agent</span><span>{identity?.deviceName ?? 'Not connected'}</span></div>
                  <div className="flex justify-between border-b pb-3"><span className="text-muted-foreground">Platform</span><span>{identity?.platform ?? '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Version</span><span>{identity?.agentVersion ?? '—'}</span></div>
                </CardContent>
              </Card>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
