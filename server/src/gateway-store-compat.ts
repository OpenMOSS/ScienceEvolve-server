import { GatewayStore } from "./agent-runtime.js";

/** Align an injected legacy runtime store with the Web gateway API. */
export function ensureGatewayReasoningDiscovery(store: GatewayStore): GatewayStore {
  if (typeof store.scheduleReasoningDiscovery === "function") return store;

  const state = Object.getOwnPropertyDescriptors(store);
  const root: unknown = state.root?.value;
  if (typeof root !== "string") throw new Error("Unsupported legacy GatewayStore: missing storage root");

  const current = new GatewayStore(root, {
    fetch: state.fetchImpl?.value,
    resolveHostname: state.resolveHostname?.value,
    testTimeoutMs: state.timeoutMs?.value,
    adapterSmokeProbe: state.adapterSmokeProbe?.value
  });
  // Existing HTTP handlers and the research orchestrator share this object.
  // Retain their identity, credentials path, pending mutations and probe policy;
  // initialize only the state introduced by the current gateway implementation.
  for (const key of Reflect.ownKeys(current)) {
    if (!Object.hasOwn(store, key)) {
      Object.defineProperty(store, key, Object.getOwnPropertyDescriptor(current, key)!);
    }
  }
  Object.setPrototypeOf(store, GatewayStore.prototype);
  return store;
}
