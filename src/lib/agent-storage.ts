import { invoke } from "@tauri-apps/api/core";
import { normalizeEndpoint, type SavedAgent } from "./agent-protocol";

const SAVED_AGENTS_KEY = "msm.saved-agents";
const LEGACY_ENDPOINT_KEY = "msm.saved-agent-connection";
const LEGACY_TOKEN_KEY = "msm.saved-agent-token";

export { LEGACY_ENDPOINT_KEY, LEGACY_TOKEN_KEY };

function loadSavedAgents(): SavedAgent[] {
  try {
    const raw = localStorage.getItem(SAVED_AGENTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed))
        return parsed
          .filter((item): item is SavedAgent =>
            Boolean(
              item &&
              typeof item === "object" &&
              typeof (item as SavedAgent).endpoint === "string",
            ),
          )
          .map((item) => ({ endpoint: normalizeEndpoint(item.endpoint) }));
    }
    const legacy = localStorage.getItem(LEGACY_ENDPOINT_KEY);
    return legacy ? [{ endpoint: normalizeEndpoint(legacy) }] : [];
  } catch {
    return [];
  }
}

/** Cached read: localStorage should not be hit on every render. */
let savedAgentsCache: SavedAgent[] | null = null;
export function getSavedAgents(): SavedAgent[] {
  if (!savedAgentsCache) savedAgentsCache = loadSavedAgents();
  return savedAgentsCache;
}
export function hasSavedAgents(): boolean {
  return getSavedAgents().length > 0;
}

function saveSavedAgents(agents: SavedAgent[]) {
  localStorage.setItem(SAVED_AGENTS_KEY, JSON.stringify(agents));
  savedAgentsCache = agents;
}
export function addSavedAgent(endpoint: string) {
  const normalized = normalizeEndpoint(endpoint);
  saveSavedAgents([
    ...getSavedAgents().filter((agent) => agent.endpoint !== normalized),
    { endpoint: normalized },
  ]);
}
export function removeSavedAgent(endpoint: string) {
  saveSavedAgents(
    getSavedAgents().filter(
      (agent) => agent.endpoint !== normalizeEndpoint(endpoint),
    ),
  );
}
export function clearLegacySavedConnection() {
  localStorage.removeItem(LEGACY_ENDPOINT_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  savedAgentsCache = null;
}

function credentialKey(endpoint: string) {
  return `agent-token:${normalizeEndpoint(endpoint)}`;
}
export async function getCredential(endpoint: string) {
  return invoke<string | null>("credential_get", {
    key: credentialKey(endpoint),
  });
}
export async function setCredential(endpoint: string, token: string) {
  await invoke("credential_set", {
    key: credentialKey(endpoint),
    secret: token,
  });
}
export async function deleteCredential(endpoint: string) {
  await invoke("credential_delete", { key: credentialKey(endpoint) });
}
