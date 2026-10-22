import { describe, expect, test } from "bun:test";
import { tableWhereClause, validateTableFilter } from "../src/tableFilter.ts";

describe("tableFilter", () => {
  test("rejects semicolons", () => {
    expect(() => validateTableFilter("1=1; DELETE FROM users")).toThrow(/semicolon/i);
  });

  test("builds WHERE clause", () => {
    expect(tableWhereClause("id > 1")).toBe(" WHERE id > 1");
    expect(tableWhereClause("")).toBe("");
  });
});
