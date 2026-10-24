import { describe, expect, test } from "bun:test";
import { highlightSql } from "../src/sqlHighlight";

describe("highlightSql", () => {
  test("highlights keywords and escapes html", () => {
    const html = highlightSql("SELECT 1 -- x\n<script>");
    expect(html).toContain("sql-hl-keyword");
    expect(html).toContain("SELECT");
    expect(html).toContain("sql-hl-comment");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
  });
});
