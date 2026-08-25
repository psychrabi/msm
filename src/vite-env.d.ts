/// <reference types="vite/client" />

declare module '@novnc/novnc' {
  export interface RFBOptions {
    credentials?: {
      username?: string;
      password?: string;
    };
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export interface RFBEventMap {
    connect: Event;
    disconnect: CustomEvent<{ clean?: boolean; reconnect?: boolean }>;
    securityfailure: CustomEvent<{ reason?: string; status?: number }>;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    showDotCursor: boolean;
    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    disconnect(): void;
  }
}
