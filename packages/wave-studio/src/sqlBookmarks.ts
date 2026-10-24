import { getApiPrefix } from "./api";

export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  sql: string;
  updatedAt: number;
}

const STORAGE_PREFIX = "wave-studio-saved-sql:";

function storageKey(): string {
  return STORAGE_PREFIX + getApiPrefix();
}

export function loadSavedQueries(): SavedQuery[] {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedQuery[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q) => q && typeof q.id === "string" && typeof q.name === "string" && typeof q.sql === "string");
  } catch {
    return [];
  }
}

function persist(list: SavedQuery[]): void {
  localStorage.setItem(storageKey(), JSON.stringify(list));
}

export function upsertSavedQuery(input: { id?: string; name: string; description?: string; sql: string }): SavedQuery {
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");
  const list = loadSavedQueries();
  const now = Date.now();
  const id = input.id ?? crypto.randomUUID();
  const next: SavedQuery = {
    id,
    name,
    description: input.description?.trim() || undefined,
    sql: input.sql,
    updatedAt: now,
  };
  const idx = list.findIndex((q) => q.id === id);
  if (idx >= 0) list[idx] = next;
  else list.unshift(next);
  persist(list);
  return next;
}

export function deleteSavedQuery(id: string): void {
  persist(loadSavedQueries().filter((q) => q.id !== id));
}
