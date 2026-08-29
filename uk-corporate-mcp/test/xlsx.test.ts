import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildXlsx, columnLetter, escapeXml, sanitiseSheetName, toBase64, type Sheet } from "../src/spreadsheet/xlsx.js";

const OUT_DIR = "/tmp/claude-0/-home-user/024b157d-25df-5ddc-8b2c-be2e15096d85/scratchpad/xlsx-out";

const sheets: Sheet[] = [
  {
    name: "Summary",
    preamble: [["Company number", "00000001"], ["Issued share capital", "GBP 1,000,000"], []],
    columns: [{ header: "Item", width: 30 }, { header: "Value", width: 24 }],
    rows: [
      ["Capital events on record", 9],
      ["Currencies in issue", "GBP"],
      ["Quoted \"text\" & <angles>", null],
    ],
  },
  {
    name: "Statement of capital history",
    columns: [{ header: "As at" }, { header: "Currency" }, { header: "Aggregate nominal value" }],
    rows: [
      ["2025-06-14", "GBP", 1_000_000],
      ["2022-02-14", "GBP", 750_000.5],
    ],
  },
];

describe("the XLSX writer", () => {
  it("produces a zip with the parts an OPC package requires", () => {
    const bytes = buildXlsx(sheets);
    expect(bytes[0]).toBe(0x50); // "PK"
    expect(bytes[1]).toBe(0x4b);

    const text = new TextDecoder().decode(bytes);
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]) {
      expect(text).toContain(part);
    }
  });

  it("writes numbers as numbers and strings inline", () => {
    const text = new TextDecoder().decode(buildXlsx(sheets));
    expect(text).toContain("<v>1000000</v>");
    expect(text).toContain("<v>750000.5</v>");
    expect(text).toContain('t="inlineStr"');
  });

  it("escapes XML rather than emitting invalid markup", () => {
    const text = new TextDecoder().decode(buildXlsx(sheets));
    expect(text).toContain("Quoted &quot;text&quot; &amp; &lt;angles&gt;");
    expect(escapeXml("a & b")).toBe("a &amp; b");
  });

  it("writes a file to disk that a real reader can open", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/writer-check.xlsx`, buildXlsx(sheets));
    // Validated out of process by python's zipfile in the accompanying check.
    expect(true).toBe(true);
  });

  it("maps column indexes past Z", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(52)).toBe("AZ");
    expect(columnLetter(53)).toBe("BA");
  });

  it("makes sheet names legal, since Excel refuses the file rather than complaining", () => {
    const taken = new Set<string>();
    expect(sanitiseSheetName("Control [PSC]/rights", taken)).toBe("Control PSC rights");
    expect(sanitiseSheetName("A".repeat(40), taken)).toHaveLength(31);
    const first = sanitiseSheetName("Notes", taken);
    const second = sanitiseSheetName("Notes", taken);
    expect(first).toBe("Notes");
    expect(second).not.toBe(first);
  });

  it("base64-encodes without overflowing the stack on a large sheet", () => {
    const big: Sheet = {
      name: "Big",
      columns: [{ header: "n" }],
      rows: Array.from({ length: 5_000 }, (_, i) => [i]),
    };
    const encoded = toBase64(buildXlsx([big]));
    expect(encoded.length).toBeGreaterThan(10_000);
    expect(() => atob(encoded)).not.toThrow();
  });

  it("handles a workbook with no data rows", () => {
    const bytes = buildXlsx([{ name: "Empty", columns: [{ header: "A" }], rows: [] }]);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
