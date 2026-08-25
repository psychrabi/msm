type SeatState = 'active' | 'locked' | 'offline';

type Seat = {
  id: string;
  user: string;
  state: SeatState;
};

const seats: Seat[] = [
  { id: 'seat-01', user: 'Alice', state: 'active' },
  { id: 'seat-02', user: 'Bob', state: 'active' },
  { id: 'seat-03', user: 'Carol', state: 'locked' },
];

function App() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">MSM</div>
          <h1>Remote Monitor &amp; Control</h1>
        </div>
        <div className="device-status">
          <span className="status-dot online" />
          WS-1042 · Online
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="section-heading">
            <span>Seats</span>
            <span className="count">{seats.length}</span>
          </div>

          <div className="seat-list">
            {seats.map((seat) => (
              <button className="seat-card" key={seat.id} type="button">
                <span className={`status-dot ${seat.state}`} />
                <span className="seat-copy">
                  <strong>{seat.id}</strong>
                  <span>{seat.user}</span>
                </span>
                <span className="seat-state">{seat.state}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <div>
              <span className="label">Selected session</span>
              <strong>seat-01 · Alice</strong>
            </div>
            <button className="connect-button" type="button">
              Connect
            </button>
          </div>

          <div className="viewer-placeholder">
            <div className="placeholder-icon">▣</div>
            <h2>Remote desktop</h2>
            <p>Select a seat and connect to its desktop session.</p>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
