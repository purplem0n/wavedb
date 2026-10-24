import { describe, expect, test } from "bun:test";
import { addColumnSql, dropTableSql } from "../src/schemaManage";

describe("schemaManage", () => {
  test("DDL helpers", () => {
    expect(addColumnSql("t", "note", "text", true)).toBe('ALTER TABLE "t" ADD COLUMN "note" TEXT');
    expect(dropTableSql("t")).toBe('DROP TABLE "t"');
  });
});
