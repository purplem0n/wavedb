import { describe, expect, test, beforeEach } from "bun:test";
import { deleteSavedQuery, loadSavedQueries, upsertSavedQuery } from "../src/sqlBookmarks";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: Storage; window?: { __WAVE_API_PREFIX__?: string } }).localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  globalThis.window = { __WAVE_API_PREFIX__: "/api/test" };
});

describe("sqlBookmarks", () => {
  test("upsert and delete", () => {
    const a = upsertSavedQuery({ name: "Count", sql: "SELECT 1", description: "demo" });
    expect(loadSavedQueries()).toHaveLength(1);
    upsertSavedQuery({ id: a.id, name: "Count v2", sql: "SELECT 2" });
    expect(loadSavedQueries()[0]!.name).toBe("Count v2");
    deleteSavedQuery(a.id);
    expect(loadSavedQueries()).toHaveLength(0);
  });

  test("requires name", () => {
    expect(() => upsertSavedQuery({ name: "  ", sql: "SELECT 1" })).toThrow("Name is required");
  });
});
