// `word-extractor` (legacy binary .doc parser) ships no type declarations.
// We use a small subset: `.extract(buffer)` -> document -> `getBody()`.
declare module 'word-extractor' {
  interface WordExtractorDocument {
    /** Full body text of the .doc document. */
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): Record<string, string>;
    getFooters(): Record<string, string>;
    getTextboxes(): string;
  }

  class WordExtractor {
    /**
     * Extract a legacy binary .doc file from a Buffer, a local path, or a
     * readable stream. Resolves with the parsed document.
     */
    extract(
      data: Buffer | string | ReadableStream,
      options?: Record<string, unknown>
    ): Promise<WordExtractorDocument>;
  }

  export default WordExtractor;
}
