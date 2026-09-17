import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseKnowledgeFile,
  knowledgeFileExtension,
  hasKnowledgeFileExtension,
  KNOWLEDGE_FILE_EXTENSIONS,
} from './knowledge-parser';

const h = vi.hoisted(() => ({
  convertToMarkdown: vi.fn(),
  convertToHtml: vi.fn(),
  extractRawText: vi.fn(),
  pdfParse: vi.fn(),
  docBody: '',
}));

vi.mock('mammoth', () => ({
  default: {
    convertToMarkdown: h.convertToMarkdown,
    convertToHtml: h.convertToHtml,
    extractRawText: h.extractRawText,
  },
}));

vi.mock('pdf-parse', () => ({ default: h.pdfParse }));

vi.mock('word-extractor', () => {
  class WordExtractorMock {
    extract() {
      return Promise.resolve({ getBody: () => h.docBody });
    }
  }
  return { default: WordExtractorMock };
});

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof bytes === 'string') {
    const enc = new TextEncoder().encode(bytes);
    const ab = new ArrayBuffer(enc.byteLength);
    new Uint8Array(ab).set(enc);
    return ab;
  }
  if (bytes instanceof Uint8Array) {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return ab;
  }
  return bytes;
}

function fileFrom(
  name: string,
  bytes: ArrayBuffer | Uint8Array | string
): Pick<File, 'name' | 'arrayBuffer'> {
  const ab = toArrayBuffer(bytes);
  if (typeof File !== 'undefined') return new File([ab], name);
  return { name, arrayBuffer: () => Promise.resolve(ab) };
}

describe('knowledgeFileExtension / hasKnowledgeFileExtension', () => {
  it('recognizes supported extensions case-insensitively', () => {
    for (const ext of [...KNOWLEDGE_FILE_EXTENSIONS, 'XLSX', 'Csv']) {
      expect(knowledgeFileExtension(`report.${ext}`)).not.toBeNull();
      expect(hasKnowledgeFileExtension(`report.${ext}`)).toBe(true);
    }
  });

  it('returns null for unsupported, hidden, or extension-less names', () => {
    expect(knowledgeFileExtension('photo.png')).toBeNull();
    expect(knowledgeFileExtension('.gitignore')).toBeNull();
    expect(knowledgeFileExtension('README')).toBeNull();
    expect(hasKnowledgeFileExtension('evil.exe')).toBe(false);
  });
});

describe('parseKnowledgeFile — Excel / CSV', () => {
  it('extracts an .xlsx workbook as Markdown tables', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Product', 'Price', 'Stock'],
        ['Maquila per kg', 12.5, 400],
        ['Tolva 3 m³', 850, 12],
      ]),
      'Pricing'
    );
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const parsed = await parseKnowledgeFile(fileFrom('precios.xlsx', buf));
    expect(parsed.extension).toBe('xlsx');
    expect(parsed.text).toContain('## Hoja: Pricing');
    expect(parsed.text).toContain('| Product | Price | Stock |');
    expect(parsed.text).toContain('| Maquila per kg | 12.5 | 400 |');
  });

  it('extracts a CSV as a Markdown table with the first row as header', async () => {
    const csv = 'City,Population\nBogotá,8000000\nMedellín,2500000\n';
    const parsed = await parseKnowledgeFile(fileFrom('cities.csv', csv));
    expect(parsed.extension).toBe('csv');
    expect(parsed.text).toContain('| City | Population |');
    expect(parsed.text).toContain('| Bogotá | 8000000 |');
  });

  it('escapes pipe characters inside cells', async () => {
    const csv = 'a|b,c\nx,y\n';
    const parsed = await parseKnowledgeFile(fileFrom('t.csv', csv));
    expect(parsed.text).toContain('| a\\|b | c |');
  });

  it('throws when the workbook contains no table rows', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['   ']]),
      'Empty'
    );
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await expect(parseKnowledgeFile(fileFrom('x.xlsx', buf))).rejects.toThrow(
      /no table data/i
    );
  });
});

describe('parseKnowledgeFile — Word (.docx)', () => {
  it('uses mammoth Markdown output when available', async () => {
    h.convertToMarkdown.mockResolvedValue({
      value: '# Título\n\nLista: **A**, *B*.\n',
    });
    const parsed = await parseKnowledgeFile(
      fileFrom('doc.docx', new Uint8Array([0, 0]))
    );
    expect(h.convertToMarkdown).toHaveBeenCalled();
    expect(parsed.extension).toBe('docx');
    expect(parsed.text).toContain('# Título');
  });

  it('falls back to HTML → plain text when Markdown conversion fails', async () => {
    h.convertToMarkdown.mockRejectedValueOnce(new Error('no md'));
    h.convertToHtml.mockResolvedValueOnce({
      value:
        '<h1>Contrato</h1><p>Cláusula uno.</p><ul><li>ítem A</li><li>ítem B</li></ul>',
    });
    const parsed = await parseKnowledgeFile(
      fileFrom('doc.docx', new Uint8Array([0, 0]))
    );
    expect(parsed.text).toContain('Contrato');
    expect(parsed.text).toContain('Cláusula uno.');
    expect(parsed.text).toContain('- ítem A');
  });

  it('falls back to raw text extraction when HTML also fails', async () => {
    h.convertToMarkdown.mockRejectedValue(new Error('no md'));
    h.convertToHtml.mockRejectedValue(new Error('no html'));
    h.extractRawText.mockResolvedValue({ value: 'Solo texto plano.' });
    const parsed = await parseKnowledgeFile(
      fileFrom('doc.docx', new Uint8Array([0, 0]))
    );
    expect(h.extractRawText).toHaveBeenCalled();
    expect(parsed.text).toBe('Solo texto plano.');
  });

  it('throws when no text can be extracted at all', async () => {
    h.convertToMarkdown.mockRejectedValue(new Error('no md'));
    h.convertToHtml.mockRejectedValue(new Error('no html'));
    h.extractRawText.mockResolvedValue({ value: '' });
    await expect(
      parseKnowledgeFile(fileFrom('doc.docx', new Uint8Array([0, 0])))
    ).rejects.toThrow(/no readable text/i);
  });
});

describe('parseKnowledgeFile — legacy .doc', () => {
  it('extracts the body text', async () => {
    h.docBody = 'Contrato v1: condiciones de pago.\n';
    const parsed = await parseKnowledgeFile(
      fileFrom('contrato.doc', new Uint8Array([1]))
    );
    expect(parsed.extension).toBe('doc');
    expect(parsed.text).toBe('Contrato v1: condiciones de pago.');
  });

  it('throws when the body is empty', async () => {
    h.docBody = '';
    await expect(
      parseKnowledgeFile(fileFrom('vacio.doc', new Uint8Array([1])))
    ).rejects.toThrow(/no readable text/i);
  });
});

describe('parseKnowledgeFile — PDF', () => {
  it('extracts the full text', async () => {
    h.pdfParse.mockResolvedValue({ text: 'Manual de uso\nPágina dos.' });
    const parsed = await parseKnowledgeFile(
      fileFrom('manual.pdf', new Uint8Array([1, 2]))
    );
    expect(parsed.extension).toBe('pdf');
    expect(parsed.text).toContain('Página dos.');
  });

  it('throws when the PDF has no text layer (scanned)', async () => {
    h.pdfParse.mockResolvedValue({ text: '\n   ' });
    await expect(
      parseKnowledgeFile(fileFrom('scan.pdf', new Uint8Array([1])))
    ).rejects.toThrow(/no readable text/i);
  });
});

describe('parseKnowledgeFile — plain text', () => {
  it('returns the raw utf-8 text trimmed', async () => {
    const parsed = await parseKnowledgeFile(
      fileFrom('notas.txt', 'Hola\nmundo\n')
    );
    expect(parsed.extension).toBe('txt');
    expect(parsed.text).toBe('Hola\nmundo');
  });
});

describe('parseKnowledgeFile — unsupported files', () => {
  it('throws with a friendly message for other extensions', async () => {
    await expect(
      parseKnowledgeFile(fileFrom('malware.exe', new Uint8Array([1])))
    ).rejects.toThrow(/unsupported file type/i);
  });
});
