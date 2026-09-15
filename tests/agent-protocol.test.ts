import { describe, expect, test } from "bun:test";
import { normalizeAgentIp } from "../src/lib/agent-protocol";

describe("normalizeAgentIp", () => {
  test("uses the installed agent's secure WebSocket endpoint for a bare IP", () => {
    expect(normalizeAgentIp("192.168.1.10")).toBe(
      "wss://192.168.1.10:40123/ws",
    );
  });

  test("preserves an explicit agent port while defaulting to secure WebSocket", () => {
    expect(normalizeAgentIp("192.168.1.10:41000")).toBe(
      "wss://192.168.1.10:41000/ws",
    );
  });

  test("uses secure WebSocket for a bare IPv6 agent address", () => {
    expect(normalizeAgentIp("2001:db8::10")).toBe(
      "wss://[2001:db8::10]:40123/ws",
    );
  });

  test("preserves an explicit port on a bracketed IPv6 agent address", () => {
    expect(normalizeAgentIp("[2001:db8::10]:41000")).toBe(
      "wss://[2001:db8::10]:41000/ws",
    );
  });

  test("keeps explicitly requested plaintext WebSocket for development", () => {
    expect(normalizeAgentIp("ws://127.0.0.1:40123")).toBe(
      "ws://127.0.0.1:40123/ws",
    );
  });
});
