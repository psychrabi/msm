export type Session = { sessionId: string; username: string; state: string; seatId?: string | null; display?: string | null };
export type DeviceIdentity = { deviceId: string; deviceName: string; platform: string; architecture: string; agentVersion: string };
export type RemoteSession = { sessionId: string; port: number; vncPassword: string; vncTicket: string };
export type AgentMessage =
  | { type: "hello"; identity: DeviceIdentity }
  | { type: "sessions"; sessions: Session[] }
  | { type: "remoteSession"; session: RemoteSession }
  | { type: "error"; message: string };
export type AgentStatus = "Disconnected" | "Connecting…" | "Connected" | "Reconnecting…";
export type AgentConnection = { id: string; endpoint: string; token: string; identity: DeviceIdentity | null; sessions: Session[]; status: AgentStatus; error: string; remembered: boolean };
export type SavedAgent = { endpoint: string };
export type RemoteConnection = RemoteSession & { agentId: string; username: string };
export const DEFAULT_AGENT_PORT = 40123;
export function normalizeEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) { const ws = value.replace(/^http/i, "ws").replace(/\/$/, ""); return ws.endsWith("/ws") ? ws : `${ws}/ws`; }
  if (/^wss?:\/\//i.test(value)) { const ws = value.replace(/\/$/, ""); return ws.endsWith("/ws") ? ws : `${ws}/ws`; }
  return `wss://${value.replace(/\/$/, "")}/ws`;
}
export function normalizeAgentIp(ip: string): string { const value = ip.trim(); if (!value) return ""; const host = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value; return normalizeEndpoint(`wss://${host}:${DEFAULT_AGENT_PORT}/ws`); }
export function isValidAgentIp(ip: string): boolean { const value = ip.trim(); if (!value || /[/:\s]/.test(value)) return false; const octets = value.split("."); return octets.length === 4 && octets.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255); }
export function agentId(endpoint: string) { return normalizeEndpoint(endpoint); }
export function connectionKey(agent: string, session: string) { return `${agent}::${session}`; }
export function isUnauthorizedError(error: unknown) { return /\b401\b|unauthorized|authentication failed|not authorized/i.test(error instanceof Error ? error.message : String(error)); }
