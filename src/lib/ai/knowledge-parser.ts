import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import WordExtractor from 'word-extractor';

// ============================================================
// Knowledge Base file parser.
//
// Converts an uploaded document into plain structured text that can be
// chunked and indexed like any other knowledge document:
//   - Excel / CSV (.xlsx, .xls, .csv)  → Markdown tables per sheet.
//   - Word (.docx)                     → structured Markdown/text via
//     mammoth, honoring headings and lists (HTML fallback).
//   - Word legacy (.doc)               → body text via word-extractor.
//   - PDF (.pdf)                       → full extracted text via pdf-parse.
//   - Plain text (.txt)                → raw utf-8 text.
//
// Pure Node (Buffers in, plain text out) — no storage dependency, so it
// is trivially testable and reusable by any route.
// ============================================================

/** Accepted file extensions, lower-case, without the dot. */
export const KNOWLEDGE_FILE_EXTENSIONS = [
  'xlsx',
  'xls',
  'csv',
  'pdf',
  'docx',
  'doc',
  'txt',
] as const;

export type KnowledgeFileExtension = (typeof KNOWLEDGE_FILE_EXTENSIONS)[number];

/** True when the file name has one of the supported extensions. */
export function hasKnowledgeFileExtension(name: string): boolean {
  return knowledgeFileExtension(name) !== null;
}

/** Lower-cased extension of `name` when supported, otherwise null. */
export function knowledgeFileExtension(
  name: string
): KnowledgeFileExtension | null {
  const dot = name.lastIndexOf('.');
  const ext = (dot >= 0 ? name.slice(dot + 1) : name).toLowerCase();
  return (KNOWLEDGE_FILE_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as KnowledgeFileExtension)
    : null;
}

export interface ParsedKnowledgeFile {
  /** Extracted, normalized document text (never empty after a successful parse). */
  text: string;
  /** Extension that was actually parsed (normalized lower-case). */
  extension: KnowledgeFileExtension;
}

type UploadedFile = Pick<File, 'name' | 'arrayBuffer'>;

/**
 * Parse an uploaded knowledge file into plain text. Throws an Error with
 * a user-friendly Spanish/English message when the file cannot be read.
 */
export async function parseKnowledgeFile(
  file: UploadedFile
): Promise<ParsedKnowledgeFile> {
  const extension = knowledgeFileExtension(file.name);
  if (!extension) {
    throw new Error(
      `Unsupported file type: ${file.name}. Supported: .xlsx, .xls, .csv, .pdf, .docx, .doc, .txt`
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  switch (extension) {
    case 'xlsx':
    case 'xls':
      return { text: excelToMarkdown(buffer, file.name), extension };
    case 'csv':
      // CSV must be decoded to a UTF-8 string first — SheetJS reads
      // raw CSV *buffers* with a legacy codepage and mangles accented
      // characters (Bogotá → BogotÃ¡). type:'string' keeps the JS text.
      return {
        text: csvToMarkdown(buffer.toString('utf8'), file.name),
        extension,
      };
    case 'docx':
      return { text: await docxToText(buffer), extension };
    case 'doc':
      return { text: await legacyDocToText(buffer), extension };
    case 'pdf':
      return { text: await pdfToText(buffer), extension };
    case 'txt':
      return {
        text: buffer
          .toString('utf8')
          .replace(/\u0000/g, '')
          .trim(),
        extension,
      };
  }
}

// ------------------------------------------------------------
// Excel / CSV → Markdown tables
// ------------------------------------------------------------

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.slice(0, 10) === iso.slice(0, 10) ? iso.slice(0, 10) : iso;
  }
  return String(value).trim().replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const maxCols = Math.max(1, ...rows.map((r) => r.length));
  const pad = (cells: string[]): string[] => {
    const row = [...cells];
    while (row.length < maxCols) row.push('');
    return row.map((c, i) => (i < maxCols ? c : ''));
  };
  const header = pad(rows[0]);
  const body = rows.slice(1).filter((r) => r.some((c) => c !== ''));
  const lines: string[] = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...body.map((r) => `| ${pad(r).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function sheetsToMarkdown(workbook: XLSX.WorkBook, fileName: string): string {
  const withSheets = workbook.SheetNames.length > 0;
  const sheets = withSheets
    ? workbook.SheetNames
    : [fileName.replace(/\.[^.]+$/, '') || 'Datos'];
  const parts: string[] = [];

  for (const sheetName of sheets) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      defval: '',
    });
    const rows: string[][] = raw
      .filter((row) => row.some((c) => String(c).trim() !== ''))
      .map((row) => row.map(cellToText));
    if (rows.length === 0) continue;
    parts.push(`## Hoja: ${sheetName}`);
    parts.push(markdownTable(rows));
  }

  const text = parts.join('\n\n');
  if (!text.trim()) {
    throw new Error(`No table data could be read from ${fileName}.`);
  }
  return text.trim();
}

function excelToMarkdown(buffer: Buffer, fileName: string): string {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return sheetsToMarkdown(workbook, fileName);
}

function csvToMarkdown(text: string, fileName: string): string {
  const workbook = XLSX.read(text, { type: 'string', cellDates: true });
  return sheetsToMarkdown(workbook, fileName);
}

// ------------------------------------------------------------
// Word (.docx) → structured Markdown / text
// ------------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(h[1-6]|p|div|tr|section|table|br)\b[^>]*>/gi, '\n')
    .replace(/<\/(h[1-6]|p|div|tr|section|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/(?:&nbsp;|&#160;)/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function docxToText(buffer: Buffer): Promise<string> {
  let text = '';
  let lastErr: unknown = null;
  // Prefer the Markdown output from mammoth: it keeps headings (#, ##)
  // and lists (-, 1.) structure instead of flattening to raw paragraphs.
  // mammoth's shipped types predate convertToMarkdown (present since
  // v1.8.0), so we type it locally.
  const markdownConverter = mammoth as unknown as {
    convertToMarkdown(input: { buffer: Buffer }): Promise<{ value?: string }>;
  };
  try {
    const result = await markdownConverter.convertToMarkdown({ buffer });
    text = (result.value ?? '').trim();
  } catch (err) {
    lastErr = err;
  }
  if (!text) {
    try {
      const result = await mammoth.convertToHtml({ buffer });
      text = htmlToText(result.value ?? '');
    } catch (err) {
      lastErr = err;
    }
  }
  if (!text) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      text = (result.value ?? '').trim();
    } catch (err) {
      lastErr = err;
    }
  }
  if (!text) {
    throw new Error(
      `No readable text could be extracted from the Word document${
        lastErr instanceof Error ? ` (${lastErr.message})` : ''
      }.`
    );
  }
  return text;
}

// ------------------------------------------------------------
// Word legacy (.doc) → body text
// ------------------------------------------------------------

async function legacyDocToText(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const document = await extractor.extract(buffer);
  const text = document
    .getBody()
    .replace(/\u0000/g, '')
    .trim();
  if (!text) {
    throw new Error(
      'No readable text could be extracted from the .doc file. Try saving it as .docx.'
    );
  }
  return text;
}

// ------------------------------------------------------------
// PDF → full text
// ------------------------------------------------------------

async function pdfToText(buffer: Buffer): Promise<string> {
  const parsed = await pdfParse(buffer);
  const text = (parsed.text ?? '').replace(/\u0000/g, '').trim();
  if (!text) {
    throw new Error(
      'No readable text could be extracted from the PDF (it may be a scanned document with no text layer).'
    );
  }
  return text;
}
