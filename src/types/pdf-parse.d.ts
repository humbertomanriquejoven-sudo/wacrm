// `pdf-parse` (npm 1.1.1) ships no type declarations. We use a small
// subset: parse a PDF Buffer and read `.text` from the result.
declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    text: string;
    version: string;
  }

  /** Parse a PDF from a Buffer (also accepts a file path string). */
  export default function pdfParse(
    data: Buffer,
    options?: Record<string, unknown>
  ): Promise<PdfParseResult>;
}
