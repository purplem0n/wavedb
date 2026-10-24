import { describe, expect, test } from "bun:test";
import { applyCompletion, sqlCompletions } from "../src/sqlComplete";
import type { TableDef } from "../src/api";

const tables: TableDef[] = [
  {
    id: 1,
    name: "users",
    columns: [
      { id: 1, name: "id", type: "integer", nullable: false },
      { id: 2, name: "email", type: "text", nullable: false },
    ],
    primaryKey: ["id"],
    autoIncrement: true,
    indexes: [],
    version: 1,
  },
];

describe("sqlCompletions", () => {
  test("suggests tables after FROM", () => {
    const sql = "SELECT * FROM us";
    const items = sqlCompletions(sql, sql.length, tables);
    expect(items.some((i) => i.kind === "table" && i.label === "users")).toBe(true);
  });

  test("suggests columns after table dot", () => {
    const sql = 'SELECT * FROM users u WHERE users.em';
    const items = sqlCompletions(sql, sql.length, tables);
    expect(items.some((i) => i.label === "email")).toBe(true);
  });

  test("applyCompletion replaces token", () => {
    const sql = "SELECT * FROM us";
    const items = sqlCompletions(sql, sql.length, tables);
    const t = items.find((i) => i.label === "users")!;
    const r = applyCompletion(sql, sql.length, t);
    expect(r.text).toContain('"users"');
  });
});
