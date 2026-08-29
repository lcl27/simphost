/**
 * A minimal XLSX writer.
 *
 * Workers cannot use the usual spreadsheet libraries, so this writes the file
 * directly: an OPC package is a zip of XML parts, and entries may be *stored*
 * rather than deflated, which removes the only part that would need a
 * compression implementation. Strings are written inline, so there is no shared
 * string table to maintain either.
 *
 * The result opens in Excel, LibreOffice and Numbers, and is validated in the
 * tests by unzipping it and parsing the parts back.
 */

export type CellValue = string | number | null | undefined;

export interface Column {
  header: string;
  /** Approximate character width; drives the column width in the sheet. */
  width?: number;
}

export interface Sheet {
  name: string;
  columns: Column[];
  rows: CellValue[][];
  /** Rows written above the header, used for titles and key/value blocks. */
  preamble?: CellValue[][];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** 1 -> A, 26 -> Z, 27 -> AA. */
export function columnLetter(index: number): string {
  let n = index;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Excel rejects a sheet name containing : \ / ? * [ ], or longer than 31
 * characters, by refusing to open the file at all rather than by complaining.
 */
export function sanitiseSheetName(name: string, taken: Set<string>): string {
  let cleaned = name.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  if (taken.has(cleaned.toLowerCase())) {
    let suffix = 2;
    const stem = cleaned.slice(0, 28);
    while (taken.has(`${stem} ${suffix}`.toLowerCase())) suffix += 1;
    cleaned = `${stem} ${suffix}`;
  }
  taken.add(cleaned.toLowerCase());
  return cleaned;
}

function cellXml(reference: string, value: CellValue, styleId: number): string {
  const style = styleId > 0 ? ` s="${styleId}"` : "";
  if (value === null || value === undefined || value === "") return `<c r="${reference}"${style}/>`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

const STYLE_DEFAULT = 0;
const STYLE_BOLD = 1;
const STYLE_TITLE = 2;

function sheetXml(sheet: Sheet): string {
  const parts: string[] = [];
  let rowNumber = 0;

  const writeRow = (values: CellValue[], styleId: number) => {
    rowNumber += 1;
    const cells = values
      .map((value, index) => cellXml(`${columnLetter(index + 1)}${rowNumber}`, value, styleId))
      .join("");
    parts.push(`<row r="${rowNumber}">${cells}</row>`);
  };

  for (const row of sheet.preamble ?? []) {
    // A preamble row's first cell is a label; bolding it keeps key/value blocks
    // readable without needing merged cells.
    rowNumber += 1;
    const cells = row
      .map((value, index) => cellXml(`${columnLetter(index + 1)}${rowNumber}`, value, index === 0 ? STYLE_TITLE : STYLE_DEFAULT))
      .join("");
    parts.push(`<row r="${rowNumber}">${cells}</row>`);
  }

  if (sheet.columns.length > 0) {
    writeRow(sheet.columns.map((c) => c.header), STYLE_BOLD);
    for (const row of sheet.rows) writeRow(row, STYLE_DEFAULT);
  }

  const cols =
    sheet.columns.length > 0
      ? `<cols>${sheet.columns
          .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`)
          .join("")}</cols>`
      : "";

  // freezePane below the header so long tables stay readable when scrolled.
  const headerRow = (sheet.preamble?.length ?? 0) + 1;
  const freeze =
    sheet.columns.length > 0
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : "";

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    freeze +
    cols +
    `<sheetData>${parts.join("")}</sheetData>` +
    `</worksheet>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="3">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FF44546A"/><name val="Calibri"/></font>` +
  `</fonts>` +
  // Excel requires the first fill to be none and the second gray125; omitting
  // the second makes it treat the file as corrupt.
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `</cellXfs>` +
  `</styleSheet>`;

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

function zip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // method: stored
    localView.setUint16(10, 0, true); // mod time
    localView.setUint16(12, 0x2821, true); // mod date: 2000-01-01, fixed for reproducibility
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, entry.bytes);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dirView = new DataView(dir.buffer);
    dirView.setUint32(0, 0x02014b50, true);
    dirView.setUint16(4, 20, true); // version made by
    dirView.setUint16(6, 20, true); // version needed
    dirView.setUint16(8, 0, true);
    dirView.setUint16(10, 0, true);
    dirView.setUint16(12, 0, true);
    dirView.setUint16(14, 0x2821, true);
    dirView.setUint32(16, crc, true);
    dirView.setUint32(20, size, true);
    dirView.setUint32(24, size, true);
    dirView.setUint16(28, nameBytes.length, true);
    dirView.setUint16(30, 0, true);
    dirView.setUint16(32, 0, true);
    dirView.setUint16(34, 0, true);
    dirView.setUint16(36, 0, true);
    dirView.setUint32(38, 0, true);
    dirView.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + size;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = chunks.reduce((n, c) => n + c.length, 0) + centralSize + end.length;
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of [...chunks, ...central, end]) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const encoder = new TextEncoder();
  const taken = new Set<string>();
  const named = sheets.map((sheet) => ({ ...sheet, name: sanitiseSheetName(sheet.name, taken) }));

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    named
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    named.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    named
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", bytes: encoder.encode(contentTypes) },
    { name: "_rels/.rels", bytes: encoder.encode(rootRels) },
    { name: "xl/workbook.xml", bytes: encoder.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", bytes: encoder.encode(workbookRels) },
    { name: "xl/styles.xml", bytes: encoder.encode(STYLES_XML) },
    ...named.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, bytes: encoder.encode(sheetXml(sheet)) })),
  ];

  return zip(entries);
}

/** Chunked, because spreading a large array into String.fromCharCode overflows the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
