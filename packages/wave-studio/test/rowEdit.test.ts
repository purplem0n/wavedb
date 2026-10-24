import { describe, expect, test } from "bun:test";
import { buildUpdateSql, parseCellInput } from "../src/rowEdit";
import type { TableDef } from "../src/api";

const table: TableDef = {
  id: 1,
  name: "items",
  columns: [
    { id: 1, name: "id", type: "integer", nullable: false },
    { id: 2, name: "name", type: "text", nullable: false },
  ],
  primaryKey: ["id"],
  autoIncrement: true,
  indexes: [],
  version: 1,
};

describe("rowEdit", () => {
  test("buildUpdateSql", () => {
    const sql = buildUpdateSql(table, ["id", "name"], [1, "a"], { name: "b" });
    expect(sql).toBe('UPDATE "items" SET "name" = \'b\' WHERE "id" = 1');
  });

  test("parseCellInput integer", () => {
    expect(parseCellInput("42", "integer", false)).toBe(42);
    expect(() => parseCellInput("x", "integer", false)).toThrow();
  });
});
