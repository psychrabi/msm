import { useEffect, useRef, useState } from 'react';
import WebSocket from '@tauri-apps/plugin-websocket';
import RFB from '@novnc/novnc/lib/rfb.js';
import './styles.css';

type Session = { sessionId: string; username: string; state: string; seatId?: string | null; display?: string | null };
type DeviceIdentity = { deviceId: string; deviceName: string; platform: string; architecture: string; agentVersion: string };
type RemoteSession = { sessionId: string; port: number; vncPassword: string };
type AgentMessage =
  | { type: 'hello'; identity: DeviceIdentity }
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'remoteSession'; session: RemoteSession }
  | { type: 'error'; message: string };

function App() {
  const [endpoint, setEndpoint] = useState('ws://127.0.0.1:40123/ws');
  const [token, setToken] = useState('');
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [status, setStatus] = useState('Disconnected');
  const [error, setError] = useState('');
  const [remote, setRemote] = useState<RemoteSession | null>(null);
  const [connectingRemote, setConnectingRemote] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);

  useEffect(() => () => {
    void socket?.disconnect();
    rfbRef.current?.disconnect();
  }, [socket]);

  async function connect() {
    setError('');
    setStatus('Connecting…');
    try {
      const connection = await WebSocket.connect(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      connection.addListener((message) => {
        if (message.type !== 'Text') return;
        try {
          const payload = JSON.parse(message.data) as AgentMessage;
          if (payload.type === 'hello') {
            setIdentity(payload.identity);
            setStatus('Connected');
            void connection.send(JSON.stringify({ type: 'listSessions' }));
          } else if (payload.type === 'sessions') {
            setSessions(payload.sessions);
            setSelectedSession((current) => current ?? payload.sessions[0]?.sessionId ?? null);
          } else if (payload.type === 'remoteSession') {
            setRemote(payload.session);
            setConnectingRemote(false);
          } else if (payload.type === 'error') {
            setConnectingRemote(false);
            setError(payload.message);
          }
        } catch {
          setError('Received an invalid message from the agent.');
        }
      });
      setSocket(connection);
    } catch (connectError) {
      setStatus('Disconnected');
      setError(connectError instanceof Error ? connectError.message : String(connectError));
    }
  }

  async function disconnect() {
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    await socket?.disconnect();
    setSocket(null);
    setIdentity(null);
    setSessions([]);
    setSelectedSession(null);
    setRemote(null);
    setStatus('Disconnected');
  }

  function startRemoteSession() {
    if (!socket || !selectedSession) return;
    setError('');
    setConnectingRemote(true);
    void socket.send(JSON.stringify({ type: 'startSession', sessionId: selectedSession }));
  }

  useEffect(() => {
    if (!remote || !viewerRef.current) return;
    rfbRef.current?.disconnect();
    viewerRef.current.replaceChildren();
    const controlEndpoint = new URL(endpoint);
    controlEndpoint.pathname = `/vnc/${remote.sessionId}`;
    controlEndpoint.search = `?token=${encodeURIComponent(token)}`;
    const rfb = new RFB(viewerRef.current, controlEndpoint.toString(), { credentials: { password: remote.vncPassword } });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = false;
    rfb.showDotCursor = true;
    rfb.addEventListener('connect', () => setError(''));
    rfb.addEventListener('disconnect', () => setError('Remote desktop disconnected.'));
    rfb.addEventListener('securityfailure', (event) => setError(`VNC authentication failed: ${event.detail.reason}`));
    rfbRef.current = rfb;
    return () => rfb.disconnect();
  }, [remote, endpoint, token]);

  const selected = sessions.find((session) => session.sessionId === selectedSession);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><div className="eyebrow">MSM · WINDOWS</div><h1>Remote Monitor &amp; Control</h1></div>
        <div className="device-status"><span className={`status-dot ${status === 'Connected' ? 'online' : ''}`} />{identity ? `${identity.deviceName} · ${status}` : status}</div>
      </header>
      <section className="connection-bar">
        <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="ws://host:40123/ws" />
        <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Agent access token" type="password" />
        {socket ? <button className="secondary-button" type="button" onClick={() => void disconnect()}>Disconnect</button> : <button className="connect-button" type="button" onClick={() => void connect()} disabled={!endpoint || !token}>Connect</button>}
      </section>
      {error && <div className="error-banner">{error}</div>}
      <section className="workspace">
        <aside className="sidebar">
          <div className="section-heading"><span>Windows sessions</span><span className="count">{sessions.length}</span></div>
          <div className="seat-list">
            {sessions.map((session) => (
              <button className={`seat-card ${selectedSession === session.sessionId ? 'selected' : ''}`} key={session.sessionId} type="button" onClick={() => { setSelectedSession(session.sessionId); setRemote(null); }}>
                <span className={`status-dot ${session.state === 'active' ? 'active' : 'locked'}`} />
                <span className="seat-copy"><strong>{session.username}</strong><span>Session {session.sessionId}{session.seatId ? ` · ${session.seatId}` : ''}</span></span>
                <span className="seat-state">{session.state}</span>
              </button>
            ))}
            {!sessions.length && <div className="empty-state">Connect to a Windows MSM agent to discover its logged-in user sessions.</div>}
          </div>
        </aside>
        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <div><span className="label">Selected session</span><strong>{selected ? `${selected.username} · Session ${selected.sessionId}` : 'None'}</strong></div>
            <button className="connect-button" type="button" disabled={!selected || connectingRemote || !socket} onClick={startRemoteSession}>{connectingRemote ? 'Starting…' : remote ? 'Reconnect desktop' : 'Start remote session'}</button>
          </div>
          <div className={`viewer-surface ${remote ? 'active' : ''}`} ref={viewerRef}>
            {!remote && <div className="viewer-placeholder"><div className="placeholder-icon">▣</div><h2>{selected ? `Ready for ${selected.username}` : 'Remote desktop'}</h2><p>Select a Windows session and start a remote session.</p></div>}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
