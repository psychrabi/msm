import type WebSocket from "@tauri-apps/plugin-websocket";
import { viewerId } from "./agent-protocol";

export const RECONNECT_DELAY_MS = 3000,
  MAX_RECONNECT_DELAY_MS = 60000,
  RECONNECT_JITTER = 0.15;

export type ViewerRuntime = { manualDisconnected: boolean; pendingRequest: boolean };
export type AgentRuntime = {
  socket: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connecting: boolean;
  manualDisconnected: boolean;
  reconnectAttempts: number;
  viewers: Map<string, ViewerRuntime>;
};

export const newAgentRuntime = (): AgentRuntime => ({
  socket: null,
  reconnectTimer: null,
  connecting: false,
  manualDisconnected: false,
  reconnectAttempts: 0,
  viewers: new Map(),
});

export const newViewerRuntime = (): ViewerRuntime => ({
  manualDisconnected: false,
  pendingRequest: false,
});

export function getRuntime(
  runtimes: Map<string, AgentRuntime>,
  id: string,
): AgentRuntime {
  let r = runtimes.get(id);
  if (!r) {
    r = newAgentRuntime();
    runtimes.set(id, r);
  }
  return r;
}

export function getViewerRuntime(
  runtime: AgentRuntime,
  sessionId: string,
  monitorIndex: number,
): ViewerRuntime {
  const id = viewerId(sessionId, monitorIndex);
  let v = runtime.viewers.get(id);
  if (!v) {
    v = newViewerRuntime();
    runtime.viewers.set(id, v);
  }
  return v;
}

export function computeReconnectDelay(attempts: number): number {
  const backoff = Math.min(
    RECONNECT_DELAY_MS * 2 ** attempts,
    MAX_RECONNECT_DELAY_MS,
  );
  return backoff * (1 - RECONNECT_JITTER + Math.random() * RECONNECT_JITTER * 2);
}
