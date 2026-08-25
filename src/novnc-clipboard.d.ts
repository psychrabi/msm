import type RFB from '@novnc/novnc';

declare module '@novnc/novnc' {
  interface RFB {
    clipboardPasteFrom(text: string): void;
    addEventListener(
      type: 'clipboard',
      listener: (event: CustomEvent<{ text: string }>) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }
}

export type MsmClipboardRfb = RFB;
