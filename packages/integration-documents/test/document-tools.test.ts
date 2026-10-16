import { describe, expect, it } from "vitest";
import {
  DOCUMENT_EXTRACT_TEXT_TOOL_REF,
  DOCUMENT_LIMITS,
  computeDocumentFingerprint,
  computeDocumentId,
  createDocumentTools,
  type DocumentSourceProvider,
  type DocumentSourceReadResponse,
  type ExtractDocumentOutput,
} from "../src/index.js";

/** Helper that constructs valid PDF 1.4 bytes with exact xref offsets. */
export function buildSimplePdf(pageTexts: readonly string[]): Uint8Array {
  const objects: string[] = [];
  const addObject = (content: string) => {
    objects.push(content);
    return objects.length;
  };

  const fontObj = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const contentObjNums: number[] = [];

  for (const text of pageTexts) {
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const stream = `BT\n/F1 12 Tf\n50 750 Td\n(${escaped}) Tj\nET`;
    contentObjNums.push(addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  }

  const pagesObjNum = objects.length + pageTexts.length + 1;
  const pageObjNums: number[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    pageObjNums.push(
      addObject(
        `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNums[i]} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`
      )
    );
  }

  const pagesObj = addObject(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`);
  const catalogObj = addObject(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${startxref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const SECRET_TOKEN = "SECRET_PROVIDER_CREDENTIAL_XYZ_999";

describe("document.extract_text Tool", () => {
  it("extracts a valid multi-page PDF into canonical pages with deterministic identity", async () => {
    const pdfBytes = buildSimplePdf(["First page factual content.", "Second page factual content."]);
    const expectedFingerprint = computeDocumentFingerprint(pdfBytes);
    const expectedDocId = computeDocumentId(expectedFingerprint);

    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: "test.pdf",
        mimeType: "application/pdf",
        bytes: pdfBytes,
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.1",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "doc-ref-1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as unknown as ExtractDocumentOutput;
    expect(output.status).toBe("success");
    expect(output.data.documentFingerprint).toBe(expectedFingerprint);
    expect(output.data.documentId).toBe(expectedDocId);
    expect(output.data.filename).toBe("test.pdf");
    expect(output.data.mimeType).toBe("application/pdf");
    expect(output.data.pages.length).toBe(2);

    expect(output.data.pages[0]).toEqual({
      pageNumber: 1,
      text: "First page factual content.",
      charCount: 27,
    });
    expect(output.data.pages[1]).toEqual({
      pageNumber: 2,
      text: "Second page factual content.",
      charCount: 28,
    });

    expect(output.meta.bytesRead).toBe(pdfBytes.length);
    expect(output.meta.pagesTotal).toBe(2);
    expect(output.meta.pagesExtracted).toBe(2);
    expect(output.meta.charactersExtracted).toBe(55);
    expect(output.meta.partialReasons).toEqual([]);

    // Raw bytes never enter output
    expect(JSON.stringify(output)).not.toContain("Uint8Array");
  });

  it("extracts a plain text document as page 1 with canonical normalization", async () => {
    const textBytes = new TextEncoder().encode("Hello world!\r\nLine two with CRLF.\0");
    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: "note.txt",
        mimeType: "text/plain",
        bytes: textBytes,
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.2",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "ref-text" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as unknown as ExtractDocumentOutput;
    expect(output.status).toBe("success");
    expect(output.data.pages.length).toBe(1);
    expect(output.data.pages[0]!.pageNumber).toBe(1);
    expect(output.data.pages[0]!.text).toBe("Hello world!\nLine two with CRLF.");
    expect(output.data.pages[0]!.charCount).toBe("Hello world!\nLine two with CRLF.".length);
  });

  it("normalizes provider failure reasons into bounded uppercase codes", async () => {
    const scenarios: Array<{
      reason: "not_found" | "unavailable" | "too_large" | "unsupported_type";
      expectedCode: string;
      retryable?: boolean;
    }> = [
      { reason: "not_found", expectedCode: "DOCUMENT_NOT_FOUND" },
      { reason: "unavailable", expectedCode: "DOCUMENT_SOURCE_UNAVAILABLE", retryable: true },
      { reason: "too_large", expectedCode: "DOCUMENT_TOO_LARGE" },
      { reason: "unsupported_type", expectedCode: "DOCUMENT_TYPE_UNSUPPORTED" },
    ];

    for (const { reason, expectedCode, retryable } of scenarios) {
      const provider: DocumentSourceProvider = {
        read: async () => ({ status: "failed", reason }),
      };
      const tools = createDocumentTools({ provider });
      const result = await tools.extractText.handler.execute({
        toolExecutionId: `exec.${reason}`,
        tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
        input: { documentRef: "doc-123" },
      });

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe(expectedCode);
      expect(result.retryable).toBe(retryable);
    }
  });

  it("catches thrown provider exceptions and redacts secret tokens", async () => {
    const provider: DocumentSourceProvider = {
      read: async () => {
        throw new Error(`Fatal error connecting to backend: ${SECRET_TOKEN}`);
      },
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.throw",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "ref-secret" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DOCUMENT_SOURCE_ERROR");
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  it("rejects oversized bytes exceeding DOCUMENT_LIMITS.maxDocumentBytes before parser invocation", async () => {
    // 10 MiB + 1 byte
    const oversizedBytes = new Uint8Array(DOCUMENT_LIMITS.maxDocumentBytes + 1);
    let parserInvoked = false;

    const provider: DocumentSourceProvider = {
      read: async () => {
        parserInvoked = true;
        return {
          status: "succeeded",
          mimeType: "application/pdf",
          bytes: oversizedBytes,
        };
      },
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.oversized",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "oversized-doc" },
    });

    expect(parserInvoked).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DOCUMENT_TOO_LARGE");
  });

  it("fails explicitly when document MIME type is unsupported (e.g. DOCX)", async () => {
    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.docx",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "word-doc" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DOCUMENT_TYPE_UNSUPPORTED");
  });

  it("handles malformed PDF bytes safely without leaking parser stack", async () => {
    const malformedBytes = new TextEncoder().encode("NOT A REAL PDF FILE AT ALL");
    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        mimeType: "application/pdf",
        bytes: malformedBytes,
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.malformed",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "bad-pdf" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DOCUMENT_PARSE_FAILED");
  });

  it("returns DOCUMENT_NO_EXTRACTABLE_TEXT for empty text documents or PDFs with no text", async () => {
    // Empty text/plain
    const emptyProvider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        mimeType: "text/plain",
        bytes: new Uint8Array(0),
      }),
    };

    const tools = createDocumentTools({ provider: emptyProvider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.empty",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "empty-doc" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DOCUMENT_NO_EXTRACTABLE_TEXT");
  });

  it("surfaces partial extraction when document exceeds page limits", async () => {
    // Generate 105 pages
    const pages = Array.from({ length: 105 }, (_, i) => `Page ${i + 1} content.`);
    const pdfBytes = buildSimplePdf(pages);

    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        mimeType: "application/pdf",
        bytes: pdfBytes,
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.many-pages",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "many-pages" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as unknown as ExtractDocumentOutput;
    expect(output.status).toBe("partial");
    expect(output.meta.pagesTotal).toBe(105);
    expect(output.meta.pagesExtracted).toBe(100);
    expect(output.meta.partialReasons).toContain("PAGE_LIMIT_EXCEEDED");
    expect(output.data.pages.length).toBe(100);
  });

  it("surfaces partial extraction when single page exceeds maxCharsPerPage", async () => {
    // A single text page exceeding 50,000 characters
    const largeText = "A".repeat(50_005);
    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(largeText),
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.large-page",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "large-page" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as unknown as ExtractDocumentOutput;
    expect(output.status).toBe("partial");
    expect(output.meta.partialReasons).toContain("PAGE_CHAR_LIMIT_EXCEEDED");
    expect(output.data.pages[0]!.charCount).toBe(50_000);
  });

  it("propagates cancellation signal and returns CANCELLED", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("content"),
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.abort",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "aborted-ref" },
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CANCELLED");
  });

  it("ignores host provider attempts to dictate documentId or documentFingerprint", async () => {
    const pdfBytes = buildSimplePdf(["Genuine content"]);
    const expectedFingerprint = computeDocumentFingerprint(pdfBytes);
    const expectedDocId = computeDocumentId(expectedFingerprint);

    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: "test.pdf",
        mimeType: "application/pdf",
        bytes: pdfBytes,
        // Forged properties attached by malicious/broken provider
        documentId: "doc.forged_id",
        documentFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
      } as unknown as DocumentSourceReadResponse),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.forged",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "forged-meta" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as unknown as ExtractDocumentOutput;
    expect(output.data.documentFingerprint).toBe(expectedFingerprint);
    expect(output.data.documentId).toBe(expectedDocId);
  });
});
