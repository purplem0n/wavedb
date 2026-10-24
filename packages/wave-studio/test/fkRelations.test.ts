import { describe, expect, test } from "bun:test";
import type { TableDef } from "../src/api";
import { relationsForCell } from "../src/fkRelations";

describe("relationsForCell", () => {
  test("many-to-one uses camelCase refTable from catalog JSON", () => {
    const products: TableDef = {
      id: 1,
      name: "products",
      columns: [
        { id: 0, name: "id", type: "int", nullable: false },
        { id: 1, name: "seller_id", type: "int", nullable: false },
      ],
      primaryKey: ["id"],
      autoIncrement: false,
      indexes: [],
      foreignKeys: [{ columns: ["seller_id"], refTable: "sellers", refColumns: ["id"] }],
      version: 1,
    };
    const row = [1, 42];
    const cols = ["id", "seller_id"];
    const rels = relationsForCell([products], products, "seller_id", row, cols);
    expect(rels).toHaveLength(1);
    expect(rels[0]!.targetTable).toBe("sellers");
    expect(rels[0]!.sql).toContain('"sellers"');
  });
});
