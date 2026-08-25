import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type AppInfo = {
  version: string;
  platform: string;
  arch: string;
};

type SeatState = 'active' | 'locked' | 'offline';

type Seat = {
  id: string;
  user: string;
  state: SeatState;
};

function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [selectedSeat, setSelectedSeat] = useState('seat-01');
  const [sessions, setSessions] = useState<Seat[]>([]);

  useEffect(() => {
    void Promise.all([
      invoke<AppInfo>('app_info'),
      invoke<Seat[]>('list_sessions'),
    ]).then(([info, discoveredSessions]) => {
      setAppInfo(info);
      setSessions(discoveredSessions);
    });
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">MSM</div>
          <h1>Remote Monitor &amp; Control</h1>
        </div>
        <div className="device-status">
          <span className="status-dot online" />
          Local agent · {appInfo ? `${appInfo.platform}/${appInfo.arch}` : 'starting'}
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="section-heading">
            <span>Seats</span>
            <span className="count">{sessions.length}</span>
          </div>

          {sessions.length === 0 ? (
            <div className="empty-state">
              Session discovery is not enabled yet for this operating system.
            </div>
          ) : (
            <div className="seat-list">
              {sessions.map((seat) => (
                <button
                  className={`seat-card ${selectedSeat === seat.id ? 'selected' : ''}`}
                  key={seat.id}
                  type="button"
                  onClick={() => setSelectedSeat(seat.id)}
                >
                  <span className={`status-dot ${seat.state}`} />
                  <span className="seat-copy">
                    <strong>{seat.id}</strong>
                    <span>{seat.user}</span>
                  </span>
                  <span className="seat-state">{seat.state}</span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <div>
              <span className="label">Selected session</span>
              <strong>{selectedSeat}</strong>
            </div>
            <button className="connect-button" type="button" disabled>
              Connect
            </button>
          </div>

          <div className="viewer-placeholder">
            <div className="placeholder-icon">▣</div>
            <h2>Remote desktop</h2>
            <p>VNC/RFB transport will attach to the selected desktop session.</p>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
