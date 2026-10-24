import { describe, expect, test } from "bun:test";
import { uiFiltersToWhere } from "../src/uiFilter";
import type { ColumnDef } from "../src/api";

const columns: ColumnDef[] = [
  { id: 1, name: "id", type: "integer", nullable: false },
  { id: 2, name: "name", type: "text", nullable: true },
];

describe("uiFiltersToWhere", () => {
  test("eq and contains", () => {
    const w = uiFiltersToWhere(
      [
        { column: "id", op: "eq", value: "5", value2: "" },
        { column: "name", op: "contains", value: "acme", value2: "" },
      ],
      columns,
    );
    expect(w).toBe('"id" = 5 AND "name" LIKE \'%acme%\' ESCAPE \'\\\'');
  });
});
