import { invoke } from "@tauri-apps/api/core";

// Tauri WebView clipboard access can be permission-sensitive. Route the
// browser Clipboard API through the native Windows clipboard commands so the
// noVNC clipboard event and the user's desktop clipboard share the same store.
const nativeClipboard = navigator.clipboard;

if (nativeClipboard) {
  const originalWriteText = nativeClipboard.writeText.bind(nativeClipboard);
  const originalReadText = nativeClipboard.readText.bind(nativeClipboard);

  try {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: (text: string) => invoke("clipboard_set", { text }),
    });
    Object.defineProperty(navigator.clipboard, "readText", {
      configurable: true,
      value: () => invoke<string>("clipboard_get"),
    });
  } catch {
    // Fall back to the WebView implementation if the Clipboard API is not
    // configurable in the current runtime.
    void originalWriteText;
    void originalReadText;
  }
}
