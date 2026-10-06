import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import { parseKnowledgeFile } from './knowledge-parser';

// Real-dependency tests: the sibling file knowledge-parser.test.ts stubs
// pdf-parse / mammoth / tesseract. This file deliberately imports the REAL
// libraries so the actual upload path (parseKnowledgeFile → extractors) is
// exercised end-to-end, not just the routing around it.

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof bytes === 'string') {
    const enc = new TextEncoder().encode(bytes);
    return enc.buffer.slice(
      enc.byteOffset,
      enc.byteOffset + enc.byteLength
    ) as unknown as ArrayBuffer;
  }
  if (bytes instanceof Uint8Array) {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as unknown as ArrayBuffer;
  }
  return bytes;
}

function fileFrom(name: string, bytes: ArrayBuffer | Uint8Array | string) {
  return new File([toArrayBuffer(bytes)], name);
}

function writeSheet(sheets: Array<[string, unknown[][]]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

/** Minimal single-page PDF with a real xref table (loads in pdf-parse). */
function writePdf(text: string): ArrayBuffer {
  const esc = text.replace(/[()\\]/g, (c) => `\\${c}`);
  const stream = `BT /F1 24 Tf 72 720 Td (${esc}) Tj ET`;
  const objects = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj`,
    `4 0 obj<</Length ${Buffer.byteLength(stream)}>>stream\n${stream}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  const body = objects.join('\n');
  const offsets: number[] = [];
  let pos = 0;
  for (const line of body.split('\n')) {
    offsets.push(pos);
    pos += Buffer.byteLength(line) + 1;
  }
  const xref = [
    'xref',
    '0 6',
    '0000000000 65535 f ',
    ...offsets.slice(1, 6).map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer<</Size 6/Root 1 0 R>>',
    'startxref',
    String(pos),
    '%%EOF',
  ];
  const bytes = new TextEncoder().encode([body, xref.join('\n')].join('\n'));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe('parseKnowledgeFile — real xlsx', () => {
  it('extracts a real .xlsx workbook as Markdown tables', async () => {
    const buf = writeSheet([
      [
        'Pricing',
        [
          ['Product', 'Price', 'Stock'],
          ['Maquila per kg', 12.5, 400],
        ],
      ],
    ]);
    const parsed = await parseKnowledgeFile(fileFrom('precios.xlsx', buf));
    expect(parsed.extension).toBe('xlsx');
    expect(parsed.text).toContain('## Hoja: Pricing');
    expect(parsed.text).toContain('| Product | Price | Stock |');
    expect(parsed.text).toContain('| Maquila per kg | 12.5 | 400 |');
  });
});

describe('parseKnowledgeFile — real pdf-parse', () => {
  it('extracts text from a real PDF buffer', async () => {
    // ASCII-only: the hand-rolled fixture has no ToUnicode CMap, so non-ASCII
    // glyphs would decode with the default WinAnsi map. Real customer PDFs
    // embed their own encodings, which pdf-parse resolves correctly.
    const buf = writePdf('Manual de uso tipico');
    const parsed = await parseKnowledgeFile(fileFrom('manual.pdf', buf));
    expect(parsed.extension).toBe('pdf');
    expect(parsed.text).toContain('Manual de uso tipico');
  }, 15_000);

  it('honours pageJoiner across pages', async () => {
    const buf = writePdf('Pagina A');
    const p = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const doc = await p.getText({ pageJoiner: ' | ' });
      expect(doc.text).toContain('Pagina A');
    } finally {
      p.destroy();
    }
  }, 15_000);
});