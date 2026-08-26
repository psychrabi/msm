import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { Activity, CircleHelp, Eye, EyeOff, Maximize2, Minimize2, Monitor, Plus, Settings2, Wifi, WifiOff, X } from 'lucide-react';
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
type AgentStatus = 'Disconnected' | 'Connecting…' | 'Connected' | 'Reconnecting…';
type AgentConnection = {
  id: string;
  endpoint: string;
  token: string;
  identity: DeviceIdentity | null;
  sessions: Session[];
  status: AgentStatus;
  error: string;
  remembered: boolean;
};
type SavedAgent = { endpoint: string };
type RemoteConnection = RemoteSession & { agentId: string; username: string };
type RfbClipboardApi = RFB & {
  clipboardPasteFrom(text: string): void;
  addEventListener(type: 'clipboard', listener: (event: CustomEvent<{ text: string }>) => void): void;
};

const SAVED_AGENTS_KEY = 'msm.saved-agents';
const LEGACY_ENDPOINT_KEY = 'msm.saved-agent-connection';
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
function agentId(endpoint: string) { return normalizeEndpoint(endpoint); }
function loadSavedAgents(): SavedAgent[] {
  try {
    const raw = localStorage.getItem(SAVED_AGENTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((item): item is SavedAgent => Boolean(item && typeof item === 'object' && typeof (item as SavedAgent).endpoint === 'string')).map((item) => ({ endpoint: normalizeEndpoint(item.endpoint) }));
    }
    const legacy = localStorage.getItem(LEGACY_ENDPOINT_KEY);
    return legacy ? [{ endpoint: normalizeEndpoint(legacy) }] : [];
  } catch { return []; }
}
function saveSavedAgents(agents: SavedAgent[]) { localStorage.setItem(SAVED_AGENTS_KEY, JSON.stringify(agents)); }
function addSavedAgent(endpoint: string) {
  const normalized = normalizeEndpoint(endpoint);
  const agents = loadSavedAgents().filter((agent) => agent.endpoint !== normalized);
  saveSavedAgents([...agents, { endpoint: normalized }]);
}
function removeSavedAgent(endpoint: string) { saveSavedAgents(loadSavedAgents().filter((agent) => agent.endpoint !== normalizeEndpoint(endpoint))); }
function credentialKey(endpoint: string) { return `agent-token:${normalizeEndpoint(endpoint)}`; }
async function getCredential(endpoint: string) { return invoke<string | null>('credential_get', { key: credentialKey(endpoint) }); }
async function setCredential(endpoint: string, token: string) { await invoke('credential_set', { key: credentialKey(endpoint), secret: token }); }
async function deleteCredential(endpoint: string) { await invoke('credential_delete', { key: credentialKey(endpoint) }); }
function isUnauthorizedError(error: unknown) { return /\b401\b|unauthorized|authentication failed|not authorized/i.test(error instanceof Error ? error.message : String(error)); }
function connectionKey(agent: string, session: string) { return `${agent}::${session}`; }
function gridColumns(count: number) { if (count > 12) return 'grid-cols-5'; if (count > 6) return 'grid-cols-4'; return 'grid-cols-3'; }

function RemoteViewer({ remote, endpoint, token, viewOnly, onDisconnect, onError }: { remote: RemoteConnection; endpoint: string; token: string; viewOnly: boolean; onDisconnect: () => void; onError: (message: string) => void }) {
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
    const clipboardRfb = rfb as RfbClipboardApi;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = viewOnly;
    rfb.showDotCursor = true;
    rfb.addEventListener('connect', () => onErrorRef.current(''));
    clipboardRfb.addEventListener('clipboard', (event) => { if (navigator.clipboard) void navigator.clipboard.writeText(event.detail.text).catch(() => undefined); });
    rfb.addEventListener('securityfailure', (event) => onErrorRef.current(`VNC authentication failed: ${event.detail.reason ?? 'Unknown reason'}`));
    rfb.addEventListener('disconnect', (event) => { if (!disposingRef.current && event.detail.clean) onDisconnectRef.current(); });
    rfbRef.current = rfb;
    const handlePaste = (event: ClipboardEvent) => {
      if (viewOnlyRef.current || !event.clipboardData || !rfbRef.current) return;
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      (rfbRef.current as RfbClipboardApi).clipboardPasteFrom(text);
    };
    container.addEventListener('paste', handlePaste);
    const resizeObserver = new ResizeObserver(() => { if (rfbRef.current === rfb) rfb.scaleViewport = true; });
    resizeObserver.observe(container);
    return () => { disposingRef.current = true; container.removeEventListener('paste', handlePaste); resizeObserver.disconnect(); if (rfbRef.current === rfb) rfbRef.current = null; try { rfb.disconnect(); } catch { /* already disconnected */ } container.replaceChildren(); };
  }, [remote.agentId, remote.sessionId, remote.vncPassword, endpoint, token]);
  useEffect(() => { if (rfbRef.current) rfbRef.current.viewOnly = viewOnly; }, [viewOnly]);
  return <div ref={containerRef} className="vnc-surface h-full w-full min-h-0" />;
}

function App() {
  const initialSaved = loadSavedAgents();
  const [agents, setAgents] = useState<AgentConnection[]>([]);
  const [endpointInput, setEndpointInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [rememberConnection, setRememberConnection] = useState(true);
  const [remoteConnections, setRemoteConnections] = useState<RemoteConnection[]>([]);
  const [connectingSessions, setConnectingSessions] = useState<Set<string>>(new Set());
  const [activePage, setActivePage] = useState<'monitoring' | 'settings' | 'about'>('monitoring');
  const [fullscreenKey, setFullscreenKey] = useState<string | null>(null);
  const [fullscreenViewOnly, setFullscreenViewOnly] = useState(true);
  const [globalError, setGlobalError] = useState('');
  const socketsRef = useRef(new Map<string, WebSocket>());
  const reconnectTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const manualDisconnectRef = useRef(new Set<string>());
  const pendingRemoteRequestsRef = useRef(new Set<string>());
  const connectingAgentsRef = useRef(new Set<string>());
  const agentsRef = useRef<AgentConnection[]>([]);

  useEffect(() => { agentsRef.current = agents; }, [agents]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = initialSaved;
      const migratedLegacy = saved.length > 0 && !localStorage.getItem(SAVED_AGENTS_KEY);
      const loaded: AgentConnection[] = [];
      for (const item of saved) {
        try {
          let token = await getCredential(item.endpoint);
          if (!token && migratedLegacy) {
            const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
            if (legacyToken) { await setCredential(item.endpoint, legacyToken); token = legacyToken; }
          }
          loaded.push({ id: agentId(item.endpoint), endpoint: item.endpoint, token: token ?? '', identity: null, sessions: [], status: 'Disconnected', error: '', remembered: true });
        } catch (error) {
          loaded.push({ id: agentId(item.endpoint), endpoint: item.endpoint, token: '', identity: null, sessions: [], status: 'Disconnected', error: String(error), remembered: true });
        }
      }
      if (migratedLegacy) { localStorage.removeItem(LEGACY_ENDPOINT_KEY); localStorage.removeItem(LEGACY_TOKEN_KEY); }
      if (!cancelled) {
        setAgents(loaded);
        if (loaded.length) setEndpointInput(loaded[0].endpoint);
        for (const agent of loaded) if (agent.token) void connectAgent(agent.id, true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function updateAgent(id: string, patch: Partial<AgentConnection>) { setAgents((current) => current.map((agent) => agent.id === id ? { ...agent, ...patch } : agent)); }
  function clearReconnectTimer(id: string) { const timer = reconnectTimersRef.current.get(id); if (timer) clearTimeout(timer); reconnectTimersRef.current.delete(id); }
  async function disconnectAgentSocket(id: string) { const socket = socketsRef.current.get(id); socketsRef.current.delete(id); if (socket) { try { await socket.disconnect(); } catch { /* already closed */ } } }
  function scheduleReconnect(id: string) {
    const agent = agentsRef.current.find((item) => item.id === id);
    if (!agent || !agent.remembered || !agent.token || manualDisconnectRef.current.has(id) || reconnectTimersRef.current.has(id)) return;
    updateAgent(id, { status: 'Reconnecting…' });
    reconnectTimersRef.current.set(id, setTimeout(() => { reconnectTimersRef.current.delete(id); void connectAgent(id, true); }, RECONNECT_DELAY_MS));
  }
  async function refreshSessions(id: string) {
    const socket = socketsRef.current.get(id);
    if (!socket) return;
    try { await socket.send(JSON.stringify({ type: 'listSessions' })); } catch { await disconnectAgentSocket(id); scheduleReconnect(id); }
  }
  async function connectAgent(id: string, isReconnect = false) {
    const agent = agentsRef.current.find((item) => item.id === id);
    if (!agent || connectingAgentsRef.current.has(id) || socketsRef.current.has(id) || !agent.token) return;
    connectingAgentsRef.current.add(id);
    manualDisconnectRef.current.delete(id);
    updateAgent(id, { status: isReconnect ? 'Reconnecting…' : 'Connecting…', error: '' });
    try {
      const connection = await WebSocket.connect(agent.endpoint, { headers: { Authorization: `Bearer ${agent.token.trim()}` } });
      socketsRef.current.set(id, connection);
      clearReconnectTimer(id);
      if (agent.remembered) { addSavedAgent(agent.endpoint); await setCredential(agent.endpoint, agent.token.trim()); }
      connection.addListener((message) => {
        if (message.type !== 'Text') return;
        try {
          const payload = JSON.parse(message.data) as AgentMessage;
          if (payload.type === 'hello') { updateAgent(id, { identity: payload.identity, status: 'Connected', error: '' }); void refreshSessions(id); return; }
          if (payload.type === 'sessions') { updateAgent(id, { sessions: payload.sessions }); return; }
          if (payload.type === 'remoteSession') {
            const key = connectionKey(id, payload.session.sessionId);
            if (!pendingRemoteRequestsRef.current.has(key)) return;
            pendingRemoteRequestsRef.current.delete(key);
            setConnectingSessions((current) => { const next = new Set(current); next.delete(key); return next; });
            setRemoteConnections((current) => current.some((item) => item.agentId === id && item.sessionId === payload.session.sessionId) ? current : [...current, { ...payload.session, agentId: id, username: agentsRef.current.find((item) => item.id === id)?.sessions.find((session) => session.sessionId === payload.session.sessionId)?.username ?? `Session ${payload.session.sessionId}` }]);
            return;
          }
          if (payload.type === 'error') { setGlobalError(`${agentsRef.current.find((item) => item.id === id)?.identity?.deviceName ?? id}: ${payload.message}`); }
        } catch { updateAgent(id, { error: 'Received an invalid message from the agent.' }); }
      });
    } catch (error) {
      if (isUnauthorizedError(error)) {
        await deleteCredential(agent.endpoint).catch(() => undefined);
        removeSavedAgent(agent.endpoint);
        updateAgent(id, { status: 'Disconnected', token: '', remembered: false, error: 'Authentication failed (401).' });
      } else { updateAgent(id, { status: 'Disconnected', error: error instanceof Error ? error.message : String(error) }); scheduleReconnect(id); }
    } finally { connectingAgentsRef.current.delete(id); }
  }
  async function addAgent() {
    const normalized = normalizeEndpoint(endpointInput);
    const token = tokenInput.trim();
    if (!normalized || !token) { setGlobalError('Enter an agent endpoint and access token.'); return; }
    const existing = agentsRef.current.find((agent) => agent.id === agentId(normalized));
    if (existing) { updateAgent(existing.id, { token, remembered: rememberConnection, error: '' }); if (rememberConnection) { addSavedAgent(normalized); await setCredential(normalized, token); } void connectAgent(existing.id); return; }
    const next: AgentConnection = { id: agentId(normalized), endpoint: normalized, token, identity: null, sessions: [], status: 'Disconnected', error: '', remembered: rememberConnection };
    setAgents((current) => [...current, next]);
    if (rememberConnection) { addSavedAgent(normalized); await setCredential(normalized, token); }
    setEndpointInput(''); setTokenInput(''); setActivePage('monitoring');
    setTimeout(() => void connectAgent(next.id), 0);
  }
  async function disconnectAgent(id: string) {
    manualDisconnectRef.current.add(id); clearReconnectTimer(id); pendingRemoteRequestsRef.current.forEach((key) => { if (key.startsWith(`${id}::`)) pendingRemoteRequestsRef.current.delete(key); });
    setConnectingSessions((current) => { const next = new Set(current); for (const key of next) if (key.startsWith(`${id}::`)) next.delete(key); return next; });
    setRemoteConnections((current) => current.filter((item) => item.agentId !== id));
    if (fullscreenKey?.startsWith(`${id}::`)) setFullscreenKey(null);
    await disconnectAgentSocket(id); updateAgent(id, { status: 'Disconnected', identity: null, sessions: [] });
  }
  async function removeAgent(id: string) {
    const agent = agentsRef.current.find((item) => item.id === id); if (!agent) return;
    await disconnectAgent(id); await deleteCredential(agent.endpoint).catch(() => undefined); removeSavedAgent(agent.endpoint); setAgents((current) => current.filter((item) => item.id !== id));
  }
  async function startRemoteSession(agentIdValue: string, sessionId: string) {
    const socket = socketsRef.current.get(agentIdValue); const key = connectionKey(agentIdValue, sessionId);
    if (!socket || pendingRemoteRequestsRef.current.has(key) || remoteConnections.some((item) => item.agentId === agentIdValue && item.sessionId === sessionId)) return;
    pendingRemoteRequestsRef.current.add(key); setConnectingSessions((current) => new Set(current).add(key));
    try { await socket.send(JSON.stringify({ type: 'startSession', sessionId })); }
    catch { pendingRemoteRequestsRef.current.delete(key); setConnectingSessions((current) => { const next = new Set(current); next.delete(key); return next; }); await disconnectAgentSocket(agentIdValue); scheduleReconnect(agentIdValue); }
  }
  function disconnectRemote(agentIdValue: string, sessionId: string) {
    const key = connectionKey(agentIdValue, sessionId); pendingRemoteRequestsRef.current.delete(key); setConnectingSessions((current) => { const next = new Set(current); next.delete(key); return next; }); setRemoteConnections((current) => current.filter((item) => !(item.agentId === agentIdValue && item.sessionId === sessionId))); if (fullscreenKey === key) setFullscreenKey(null);
  }
  function openFullscreen(key: string) { setFullscreenViewOnly(true); setFullscreenKey(key); }
  function closeFullscreen() { setFullscreenKey(null); setFullscreenViewOnly(true); }

  useEffect(() => {
    const interval = setInterval(() => { for (const agent of agentsRef.current) if (socketsRef.current.has(agent.id)) void refreshSessions(agent.id); }, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => () => { for (const timer of reconnectTimersRef.current.values()) clearTimeout(timer); for (const socket of socketsRef.current.values()) void socket.disconnect().catch(() => undefined); }, []);

  const connectedAgentCount = agents.filter((agent) => agent.status === 'Connected').length;
  const totalSessions = agents.reduce((sum, agent) => sum + agent.sessions.length, 0);
  const connectedByKey = new Map(remoteConnections.map((remote) => [connectionKey(remote.agentId, remote.sessionId), remote]));
  const fullscreenRemote = fullscreenKey ? connectedByKey.get(fullscreenKey) : undefined;
  const fullscreenAgent = fullscreenRemote ? agents.find((agent) => agent.id === fullscreenRemote.agentId) : undefined;
  const hasSavedAgents = loadSavedAgents().length > 0;

  return <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
    <header className="relative flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground"><Monitor className="h-4 w-4" /></div><div className="leading-tight"><p className="text-sm font-semibold">MSM Viewer</p><p className="text-[11px] text-muted-foreground">Remote workstation management</p></div></div>
      <nav className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1"><Button variant={activePage === 'monitoring' ? 'secondary' : 'ghost'} size="sm" onClick={() => setActivePage('monitoring')}><Activity className="h-4 w-4" /> Monitoring</Button><Button variant={activePage === 'settings' ? 'secondary' : 'ghost'} size="sm" onClick={() => setActivePage('settings')}><Settings2 className="h-4 w-4" /> Settings</Button><Button variant={activePage === 'about' ? 'secondary' : 'ghost'} size="sm" onClick={() => setActivePage('about')}><CircleHelp className="h-4 w-4" /> About</Button></nav>
      <Badge variant={connectedAgentCount ? 'default' : 'outline'} className="gap-1.5">{connectedAgentCount ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{connectedAgentCount} agent{connectedAgentCount === 1 ? '' : 's'} connected</Badge>
    </header>

    {activePage === 'monitoring' && <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/20">
        <div className="border-b p-4"><div className="flex items-center justify-between"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</p><p className="mt-1 font-semibold">{agents.length} configured</p></div><Badge variant="outline">{totalSessions}</Badge></div></div>
        <div className="flex-1 overflow-y-auto p-2">
          {agents.map((agent) => <div key={agent.id} className="mb-3 rounded-lg border bg-background p-3">
            <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{agent.identity?.deviceName ?? agent.endpoint}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{agent.endpoint}</p></div><div className="flex items-center gap-1.5" title={agent.status}><span className={cn('h-2 w-2 rounded-full', agent.status === 'Connected' ? 'bg-emerald-500' : 'bg-muted-foreground')} />{agent.status === 'Connecting…' || agent.status === 'Reconnecting…' ? <Activity className="h-3.5 w-3.5" /> : agent.status === 'Connected' ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />}</div></div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span>{agent.sessions.length} session{agent.sessions.length === 1 ? '' : 's'}</span><span>{agent.status}</span></div>
            <div className="mt-2 flex gap-1"><Button className="flex-1" size="sm" variant="outline" disabled={agent.status === 'Connected' || agent.status === 'Connecting…' || agent.status === 'Reconnecting…' || !agent.token} onClick={() => void connectAgent(agent.id)}>{agent.status === 'Reconnecting…' ? 'Reconnecting…' : 'Connect'}</Button><Button size="sm" variant="ghost" disabled={!socketsRef.current.has(agent.id)} onClick={() => void disconnectAgent(agent.id)}>Disconnect</Button><Button size="sm" variant="ghost" onClick={() => void removeAgent(agent.id)}><X className="h-4 w-4" /></Button></div>
            {agent.error && <p className="mt-2 text-xs text-destructive">{agent.error}</p>}
            {agent.sessions.map((session) => { const key = connectionKey(agent.id, session.sessionId); const connected = connectedByKey.has(key); const connecting = connectingSessions.has(key); return <div key={key} className="mt-2 flex items-center justify-between rounded-md border px-2 py-1.5"><div className="min-w-0"><p className="truncate text-xs font-medium">{session.username}</p><p className="text-[10px] text-muted-foreground">Session {session.sessionId}</p></div><div className="flex items-center gap-1.5"><span className={cn('h-1.5 w-1.5 rounded-full', session.state === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground')} />{connecting ? <Activity className="h-3 w-3" /> : connected ? <Wifi className="h-3 w-3 text-emerald-500" /> : <WifiOff className="h-3 w-3 text-muted-foreground" />}</div></div>; })}
          </div>)}
          {!agents.length && <div className="p-4 text-center text-sm text-muted-foreground">Add an MSM agent in Settings.</div>}
        </div>
        <div className="border-t p-3"><Button className="w-full" variant="outline" onClick={() => setActivePage('settings')}><Plus className="h-4 w-4" /> Add agent</Button></div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto"><div className="flex min-h-full flex-col"><div className="border-b px-5 py-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Monitoring</p><h1 className="mt-1 text-xl font-semibold">Remote viewers</h1><p className="mt-1 text-sm text-muted-foreground">{agents.length} agent{agents.length === 1 ? '' : 's'} · {totalSessions} sessions. Connect individual sessions from their viewer cards.</p></div>{globalError && <div className="border-b bg-destructive/10 px-5 py-2.5 text-sm text-destructive">{globalError}</div>}<section className="flex-1 p-5">{totalSessions === 0 ? <div className="flex min-h-[360px] items-center justify-center rounded-xl border bg-muted/10 text-center"><div><Monitor className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" /><p className="text-sm font-medium">No remote sessions available</p><p className="mt-1 text-xs text-muted-foreground">Connect an MSM agent to see its active sessions.</p></div></div> : <div className={cn('grid auto-rows-min gap-4', gridColumns(totalSessions))}>{agents.flatMap((agent) => agent.sessions.map((session) => ({ agent, session }))).map(({ agent, session }) => { const key = connectionKey(agent.id, session.sessionId); const remote = connectedByKey.get(key); const connecting = connectingSessions.has(key); const isFullscreen = fullscreenKey === key; return <Card key={key} className={cn('flex min-h-0 flex-col overflow-hidden', isFullscreen && 'fixed inset-0 z-50 m-0 rounded-none border-0')}><CardHeader className="flex-row items-center justify-between space-y-0 border-b px-3 py-2"><div className="min-w-0"><CardTitle className="truncate text-sm">{session.username}</CardTitle><p className="truncate text-[11px] text-muted-foreground">{agent.identity?.deviceName ?? agent.endpoint} · Session {session.sessionId}</p></div><div className="flex items-center gap-1">{remote && <Button variant="ghost" size="icon" aria-label={`Fullscreen ${session.username}`} onClick={() => openFullscreen(key)}>{isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button>}{remote && <Button variant="ghost" size="icon" aria-label={`Disconnect ${session.username}`} onClick={() => disconnectRemote(agent.id, session.sessionId)}><X className="h-4 w-4" /></Button>}</div></CardHeader><CardContent className={cn('relative min-h-0 bg-black p-0 viewer-viewport', isFullscreen && 'rounded-none viewer-fullscreen')}>{remote ? <RemoteViewer remote={remote} endpoint={agent.endpoint} token={agent.token} viewOnly={isFullscreen ? fullscreenViewOnly : true} onDisconnect={() => disconnectRemote(agent.id, session.sessionId)} onError={setGlobalError} /> : <div className="flex h-full w-full items-center justify-center bg-black"><Button size="sm" disabled={agent.status !== 'Connected' || connecting} onClick={() => void startRemoteSession(agent.id, session.sessionId)}>{connecting ? 'Connecting…' : 'Connect'}</Button></div>}</CardContent>{isFullscreen && remote && <div className="absolute bottom-0 left-0 right-0 z-[60] flex items-center justify-between border-t bg-background/95 px-4 py-3 backdrop-blur"><div className="text-sm"><span className="font-medium">{session.username}</span><span className="ml-2 text-muted-foreground">{agent.identity?.deviceName ?? agent.endpoint} · Session {session.sessionId}</span></div><div className="flex items-center gap-3"><Label className="flex items-center gap-2 text-sm"><Checkbox checked={fullscreenViewOnly} onCheckedChange={(checked: boolean | 'indeterminate') => setFullscreenViewOnly(checked === true)} />{fullscreenViewOnly ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />} View only</Label><Button variant="outline" size="sm" onClick={closeFullscreen}><Minimize2 className="h-4 w-4" /> Exit fullscreen</Button><Button variant="outline" size="sm" onClick={() => disconnectRemote(agent.id, session.sessionId)}><X className="h-4 w-4" /> Disconnect</Button></div></div>}</Card>; })}</div>}</section></div></main>
    </div>}

    {activePage === 'settings' && <main className="flex-1 overflow-auto"><div className="mx-auto max-w-4xl p-6"><div className="mb-6"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</p><h1 className="mt-1 text-2xl font-semibold">Agents</h1><p className="mt-1 text-sm text-muted-foreground">Add multiple MSM agents. Each endpoint keeps its own credential and connection.</p></div><div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]"><Card><CardHeader><CardTitle>Add agent</CardTitle></CardHeader><CardContent className="space-y-4"><div className="space-y-2"><Label htmlFor="agent-endpoint">Endpoint</Label><Input id="agent-endpoint" placeholder="ws://192.168.1.10:40123/ws" value={endpointInput} onChange={(event) => setEndpointInput(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="agent-token">Access token</Label><Input id="agent-token" type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} /></div><Label className="flex items-center gap-2"><Checkbox checked={rememberConnection} onCheckedChange={(checked: boolean | 'indeterminate') => setRememberConnection(checked === true)} /> Remember this agent</Label><Button className="w-full" onClick={() => void addAgent()} disabled={!endpointInput.trim() || !tokenInput.trim()}><Plus className="h-4 w-4" /> Add and connect</Button></CardContent></Card><Card><CardHeader><CardTitle>Configured agents</CardTitle></CardHeader><CardContent className="space-y-2">{agents.length ? agents.map((agent) => <div key={agent.id} className="rounded-lg border p-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{agent.identity?.deviceName ?? agent.endpoint}</p><p className="truncate text-xs text-muted-foreground">{agent.endpoint}</p></div><Badge variant={agent.status === 'Connected' ? 'default' : 'outline'}>{agent.status}</Badge></div><div className="mt-3 flex gap-2"><Button size="sm" variant="outline" disabled={agent.status === 'Connected' || !agent.token} onClick={() => void connectAgent(agent.id)}>Connect</Button><Button size="sm" variant="outline" disabled={agent.status !== 'Connected'} onClick={() => void disconnectAgent(agent.id)}>Disconnect</Button><Button size="sm" variant="ghost" onClick={() => void removeAgent(agent.id)}>Forget</Button></div></div>) : <p className="py-8 text-center text-sm text-muted-foreground">No agents configured.</p>}{hasSavedAgents && <p className="pt-2 text-xs text-muted-foreground">Remembered endpoints are restored from the native credential store on startup.</p>}</CardContent></Card></div></div></main>}
    {activePage === 'about' && <main className="flex flex-1 items-center justify-center p-6"><Card className="w-full max-w-2xl"><CardHeader><CardTitle>MSM Viewer</CardTitle></CardHeader><CardContent className="grid gap-3 text-sm"><div className="flex justify-between border-b pb-3"><span className="text-muted-foreground">Agents</span><span>{agents.length}</span></div><div className="flex justify-between border-b pb-3"><span className="text-muted-foreground">Connected</span><span>{connectedAgentCount}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Remote viewers</span><span>{remoteConnections.length}</span></div></CardContent></Card></main>}
  </div>;
}

export default App;
