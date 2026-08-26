import { useEffect, useRef } from "react";
import RFB from "@novnc/novnc";
import {
  normalizeEndpoint,
  type RemoteConnection,
} from "../lib/agent-protocol";

type RfbClipboardApi = RFB & {
  clipboardPasteFrom(text: string): void;
  addEventListener(
    type: "clipboard",
    listener: (event: CustomEvent<{ text: string }>) => void,
  ): void;
};

export function RemoteViewer({
  remote,
  endpoint,
  token,
  viewOnly,
  onDisconnect,
  onError,
}: {
  remote: RemoteConnection;
  endpoint: string;
  token: string;
  viewOnly: boolean;
  onDisconnect: () => void;
  onError: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const disposingRef = useRef(false);
  const viewOnlyRef = useRef(viewOnly);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    viewOnlyRef.current = viewOnly;
  }, [viewOnly]);
  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposingRef.current = false;
    const controlEndpoint = new URL(normalizeEndpoint(endpoint));
    controlEndpoint.pathname = `/vnc/${remote.sessionId}`;
    controlEndpoint.search = `token=${encodeURIComponent(token)}`;
    controlEndpoint.protocol =
      controlEndpoint.protocol === "wss:" ? "wss:" : "ws:";
    container.replaceChildren();
    const rfb = new RFB(container, controlEndpoint.toString(), {
      credentials: { password: remote.vncPassword },
    });
    const clipboardRfb = rfb as RfbClipboardApi;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = viewOnly;
    rfb.showDotCursor = true;
    rfb.addEventListener("connect", () => onErrorRef.current(""));
    clipboardRfb.addEventListener("clipboard", (event) => {
      if (navigator.clipboard)
        void navigator.clipboard
          .writeText(event.detail.text)
          .catch(() => undefined);
    });
    rfb.addEventListener("securityfailure", (event) =>
      onErrorRef.current(
        `VNC authentication failed: ${event.detail.reason ?? "Unknown reason"}`,
      ),
    );
    rfb.addEventListener("disconnect", (event) => {
      if (!disposingRef.current && event.detail.clean)
        onDisconnectRef.current();
    });
    rfbRef.current = rfb;
    const handlePaste = (event: ClipboardEvent) => {
      if (viewOnlyRef.current || !event.clipboardData || !rfbRef.current)
        return;
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      (rfbRef.current as RfbClipboardApi).clipboardPasteFrom(text);
    };
    container.addEventListener("paste", handlePaste);
    const resizeObserver = new ResizeObserver(() => {
      if (rfbRef.current === rfb) rfb.scaleViewport = true;
    });
    resizeObserver.observe(container);
    return () => {
      disposingRef.current = true;
      container.removeEventListener("paste", handlePaste);
      resizeObserver.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
      try {
        rfb.disconnect();
      } catch {
        /* already disconnected */
      }
      container.replaceChildren();
    };
  }, [remote.agentId, remote.sessionId, remote.vncPassword, endpoint, token]);
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);
  return (
    <div ref={containerRef} className="vnc-surface h-full w-full min-h-0" />
  );
}
