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
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    const ws = value.replace(/^http/i, "ws").replace(/\/$/, "");
    return ws.endsWith("/ws") ? ws : `${ws}/ws`;
  }
  if (/^wss?:\/\//i.test(value)) {
    const ws = value.replace(/\/$/, "");
    return ws.endsWith("/ws") ? ws : `${ws}/ws`;
  }
  return `ws://${value.replace(/\/$/, "")}/ws`;
}
export function normalizeAgentIp(address: string): string {
  const value = address.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || /^wss?:\/\//i.test(value)) return normalizeEndpoint(value);
  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    if (closing < 0) return "";
    const host = value.slice(1, closing);
    const suffix = value.slice(closing + 1);
    return normalizeEndpoint(`ws://[${host}]${suffix || `:${DEFAULT_AGENT_PORT}`}/ws`);
  }
  if ((value.match(/:/g) ?? []).length > 1) {
    return normalizeEndpoint(`ws://[${value}]:${DEFAULT_AGENT_PORT}/ws`);
  }
  if (value.includes(":")) return normalizeEndpoint(`ws://${value}/ws`);
  return normalizeEndpoint(`ws://${value}:${DEFAULT_AGENT_PORT}/ws`);
}
export function isValidAgentIp(address: string): boolean {
  const value = address.trim();
  if (!value || /\s/.test(value)) return false;
  if (/^https?:\/\//i.test(value) || /^wss?:\/\//i.test(value)) {
    try { return Boolean(new URL(value).hostname); } catch { return false; }
  }
  if (value.includes("/")) return false;
  if (value.startsWith("[")) return /^\[[0-9a-f:]+\](?::\d{1,5})?$/i.test(value);
  if ((value.match(/:/g) ?? []).length > 1) return /^[0-9a-f:]+$/i.test(value) && value.includes("::");
  const match = value.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) return false;
  if (match[2] && Number(match[2]) > 65535) return false;
  const host = match[1];
  const ipv4 = host.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d+$/.test(part) && Number(part) <= 255)) return true;
  if (host.length > 253) return false;
  return host === "localhost" || host.split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
}
export function agentId(endpoint: string) { return normalizeEndpoint(endpoint); }
export function connectionKey(agent: string, session: string) { return `${agent}::${session}`; }
export function isUnauthorizedError(error: unknown) { return /\b401\b|unauthorized|authentication failed|not authorized/i.test(error instanceof Error ? error.message : String(error)); }
