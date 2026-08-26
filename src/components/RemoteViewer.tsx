import { useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import { normalizeEndpoint, type RemoteConnection } from "../lib/agent-protocol";

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
  const [loadingModule, setLoadingModule] = useState(true);
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
    let disposed = false;
    let rfb: RFB | null = null;
    const controlEndpoint = new URL(normalizeEndpoint(endpoint));
    controlEndpoint.pathname = `/vnc/${remote.sessionId}`;
    controlEndpoint.search = `token=${encodeURIComponent(token)}`;
    controlEndpoint.protocol =
      controlEndpoint.protocol === "wss:" ? "wss:" : "ws:";
    container.replaceChildren();
    setLoadingModule(true);

    const handlePaste = (event: ClipboardEvent) => {
      if (viewOnlyRef.current || !event.clipboardData || !rfbRef.current)
        return;
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      (rfbRef.current as RfbClipboardApi).clipboardPasteFrom(text);
    };
    container.addEventListener("paste", handlePaste);
    // Batch rescale requests so dragging the window doesn't queue one
    // rescale per resize event.
    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (rfbRef.current === rfb && rfb) rfb.scaleViewport = true;
      });
    });
    resizeObserver.observe(container);

    // noVNC is large and only needed once a viewer actually opens;
    // load it on demand so app startup stays fast.
    void (async () => {
      try {
        const { default: RFBClass } = await import("@novnc/novnc");
        if (disposed) return;
        rfb = new RFBClass(container, controlEndpoint.toString(), {
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
      } catch {
        if (!disposed)
          onErrorRef.current("Failed to load the VNC viewer component.");
      } finally {
        if (!disposed) setLoadingModule(false);
      }
    })();

    return () => {
      disposed = true;
      disposingRef.current = true;
      container.removeEventListener("paste", handlePaste);
      resizeObserver.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (rfbRef.current === rfb) rfbRef.current = null;
      if (rfb) {
        try {
          rfb.disconnect();
        } catch {
          /* already disconnected */
        }
      }
      container.replaceChildren();
    };
  }, [remote.agentId, remote.sessionId, remote.vncPassword, endpoint, token]);
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);
  return (
    <div className="relative h-full w-full min-h-0">
      {/* noVNC owns this node's children exclusively — never render
          React children into it or they will fight over the DOM. */}
      <div ref={containerRef} className="vnc-surface absolute inset-0" />
      {loadingModule && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black">
          <p className="text-xs text-muted-foreground">Loading viewer…</p>
        </div>
      )}
    </div>
  );
}
