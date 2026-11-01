/** Public read snapshots survive navigation and reload. Every page still
 * revalidates with the server before treating the snapshot as current state. */
interface Snapshot<T> { savedAt: number; value: T; invalidated?: boolean }
const memory = new Map<string, Snapshot<unknown>>();
const pending = new Map<string, Promise<unknown>>();
const generations = new Map<string, number>();
let epoch = 0;
const MAX_AGE = 24 * 60 * 60_000;
const MAX_ENTRIES = 48;
function prefix() {
  const base = (import.meta.env.VITE_API_BASE || ".").replace(/\/$/, "");
  return `openfars:read-cache:v1:${new URL(`${base}/api/`, window.location.href).href}:`;
}
function scoped(key: string) { return prefix() + key; }
const secret = /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|token)$|_(?:API_KEY|TOKEN|PASSWORD)$/i;

export function readCachedResource<T>(key: string): T | undefined {
  const name = scoped(key);
  try {
    let entry = memory.get(name);
    if (!entry) {
      const saved = JSON.parse(sessionStorage.getItem(name) ?? "null");
      if (!saved || !Number.isFinite(saved.savedAt) || saved.value === undefined) return undefined;
      entry = saved;
      memory.set(name, entry!);
    }
    if (Date.now() - entry!.savedAt > MAX_AGE || entry!.savedAt > Date.now() + 60_000) {
      memory.delete(name); sessionStorage.removeItem(name); return undefined;
    }
    return entry!.value as T;
  } catch { return memory.get(name)?.value as T | undefined; }
}

export function cacheResource<T>(key: string, value: T, persist = true): T {
  const name = scoped(key);
  const entry = { savedAt: Date.now(), value: persist ? structuredClone(value) : value };
  memory.delete(name); memory.set(name, entry);
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value!;
    memory.delete(oldest);
    try { sessionStorage.removeItem(oldest); } catch { /* Memory remains usable. */ }
  }
  if (!persist) return value;
  try {
    const json = JSON.stringify(entry, (field, item) => secret.test(field) ? undefined : item);
    if (json.length < 1_500_000) sessionStorage.setItem(name, json);
    else sessionStorage.removeItem(name);
  } catch { /* Disabled or full storage must not block the live interface. */ }
  return value;
}

/** Concurrent readers share one request. Invalidation starts a new generation,
 * so an older request cannot put pre-mutation data back into the cache. */
export function loadResource<T>(key: string, load: () => Promise<T>, freshFor = 0): Promise<T> {
  const name = scoped(key);
  const cached = readCachedResource<T>(key);
  const entry = memory.get(name);
  if (cached !== undefined && freshFor > 0 && !entry?.invalidated && Date.now() - entry!.savedAt < freshFor)
    return Promise.resolve(cached);
  const current = pending.get(name);
  if (current) return current as Promise<T>;
  const generation = generations.get(name) ?? 0;
  const startedAtEpoch = epoch;
  const result = Promise.resolve().then(load).then(value => {
    if (epoch === startedAtEpoch && (generations.get(name) ?? 0) === generation) cacheResource(key, value);
    return value;
  }).finally(() => { if (pending.get(name) === result) pending.delete(name); });
  pending.set(name, result);
  return result;
}

export function invalidateResource(key: string): void {
  const name = scoped(key);
  generations.set(name, (generations.get(name) ?? 0) + 1);
  pending.delete(name);
  const entry = memory.get(name);
  if (entry) entry.invalidated = true;
  try { sessionStorage.removeItem(name); } catch { /* Keep the display snapshot. */ }
}

export function clearResourceCache(persisted = true): void {
  epoch += 1;
  memory.clear(); pending.clear(); generations.clear();
  if (persisted) try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix())) sessionStorage.removeItem(key);
  } catch { /* Storage is optional. */ }
}

/** Deleted records must disappear from immediate display snapshots as well. */
export function removeCachedResource(key: string): void {
  invalidateResource(key);
  memory.delete(scoped(key));
}
