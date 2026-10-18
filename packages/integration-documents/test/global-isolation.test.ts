import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_EXTRACT_TEXT_TOOL_REF,
  computeDocumentFingerprint,
  computeDocumentId,
  createDocumentTools,
  type DocumentSourceProvider,
  type ExtractDocumentOutput,
} from "../src/index.js";
import { buildSimplePdf } from "./document-tools.test.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

describe("Global Environment Isolation (Sprint 23C)", () => {
  it("imports and extracts PDF in a fresh Node 20 process without modifying host globals or process.env", () => {
    const distPath = join(here, "..", "dist", "index.js");
    if (!existsSync(distPath)) {
      execFileSync("pnpm", ["--filter", "@aao/integration-documents", "build"], {
        cwd: join(here, "..", "..", ".."),
        stdio: "inherit",
      });
    }

    // Run an isolated sub-process with pure Node 20 to ensure zero test-runner contamination
    const runnerScript = `
import assert from "node:assert";

// 1. Capture pristine baseline
const descBeforeImport = Object.getOwnPropertyDescriptor(globalThis, "Iterator");
const keysBeforeImport = new Set(Object.getOwnPropertyNames(globalThis));
const symbolsBeforeImport = new Set(Object.getOwnPropertySymbols(globalThis));
const envBeforeImport = { ...process.env };

assert.strictEqual(descBeforeImport, undefined, "globalThis.Iterator must be absent in clean Node 20 baseline");

// 2. Import @aao/integration-documents
const { createDocumentTools, computeDocumentFingerprint, computeDocumentId } = await import(${JSON.stringify(
      distPath
    )});

// 3. Verify globals after import
const descAfterImport = Object.getOwnPropertyDescriptor(globalThis, "Iterator");
const keysAfterImport = Object.getOwnPropertyNames(globalThis);
const newKeysAfterImport = keysAfterImport.filter((k) => !keysBeforeImport.has(k));
const newSymbolsAfterImport = Object.getOwnPropertySymbols(globalThis).filter((s) => !symbolsBeforeImport.has(s));

assert.strictEqual(descAfterImport, undefined, "globalThis.Iterator must remain absent after import");
assert.deepStrictEqual(newKeysAfterImport, [], "No new globalThis keys permitted on import");
assert.deepStrictEqual(newSymbolsAfterImport, [], "No new globalThis symbols permitted on import");
assert.deepStrictEqual({ ...process.env }, envBeforeImport, "process.env must not change on import");

// 4. Build valid PDF fixture
function buildPdf(texts) {
  const objects = [];
  const add = (c) => { objects.push(c); return objects.length; };
  const fontObj = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const contentObjs = texts.map((t) => {
    const stream = "BT\\n/F1 12 Tf\\n50 750 Td\\n(" + t + ") Tj\\nET";
    return add("<< /Length " + stream.length + " >>\\nstream\\n" + stream + "\\nendstream");
  });
  const pagesObjNum = objects.length + texts.length + 1;
  const pageObjs = texts.map((_, i) =>
    add("<< /Type /Page /Parent " + pagesObjNum + " 0 R /MediaBox [0 0 612 792] /Contents " + contentObjs[i] + " 0 R /Resources << /Font << /F1 " + fontObj + " 0 R >> >> >>")
  );
  const pagesObj = add("<< /Type /Pages /Kids [" + pageObjs.map((n) => n + " 0 R").join(" ") + "] /Count " + texts.length + " >>");
  const catalogObj = add("<< /Type /Catalog /Pages " + pagesObj + " 0 R >>");
  let out = "%PDF-1.4\\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += (i + 1) + " 0 obj\\n" + objects[i] + "\\nendobj\\n";
  }
  const startxref = out.length;
  out += "xref\\n0 " + (objects.length + 1) + "\\n0000000000 65535 f \\n";
  for (let i = 1; i <= objects.length; i++) {
    out += String(offsets[i]).padStart(10, "0") + " 00000 n \\n";
  }
  out += "trailer\\n<< /Size " + (objects.length + 1) + " /Root " + catalogObj + " 0 R >>\\nstartxref\\n" + startxref + "\\n%%EOF";
  return new TextEncoder().encode(out);
}

const pdfBytes = buildPdf(["Page 1 verified content.", "Page 2 verified content."]);
const tools = createDocumentTools({
  provider: {
    read: async () => ({
      status: "succeeded",
      filename: "verified.pdf",
      mimeType: "application/pdf",
      bytes: pdfBytes,
    }),
  },
});

const result = await tools.extractText.handler.execute({
  toolExecutionId: "exec.fresh-check",
  tool: { id: "document.extract_text", version: "1.0.0" },
  input: { documentRef: "ref-fresh" },
});

assert.strictEqual(result.ok, true, "PDF extraction must succeed");
assert.strictEqual(result.output.data.pages.length, 2, "Must extract exactly 2 pages");
assert.strictEqual(result.output.data.pages[0].text, "Page 1 verified content.");
assert.strictEqual(result.output.data.pages[1].text, "Page 2 verified content.");

// 5. Verify globals after parsing
const descAfterParse = Object.getOwnPropertyDescriptor(globalThis, "Iterator");
const keysAfterParse = Object.getOwnPropertyNames(globalThis);
const newKeysAfterParse = keysAfterParse.filter((k) => !keysBeforeImport.has(k));
const newSymbolsAfterParse = Object.getOwnPropertySymbols(globalThis).filter((s) => !symbolsBeforeImport.has(s));

assert.strictEqual(descAfterParse, undefined, "globalThis.Iterator must remain absent after PDF extraction");
assert.deepStrictEqual(newKeysAfterParse, [], "No new globalThis keys permitted after parsing");
assert.deepStrictEqual(newSymbolsAfterParse, [], "No new globalThis symbols permitted after parsing");
assert.deepStrictEqual({ ...process.env }, envBeforeImport, "process.env must not change after parsing");

console.log("FRESH_PROCESS_ISOLATION_OK");
`;

    const output = execFileSync(process.execPath, ["--input-type=module", "-e", runnerScript], {
      encoding: "utf8",
      cwd: join(here, ".."),
    });

    expect(output).toContain("FRESH_PROCESS_ISOLATION_OK");
  });

  it("static boundary: production document integration modules never assign to host-global properties", () => {
    // Scan all .ts files in packages/integration-documents/src
    const files = readdirSync(srcDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
      .map((file) => ({ name: file, path: join(srcDir, file) }));

    expect(files.length).toBeGreaterThanOrEqual(6);

    // Forbidden global mutation patterns:
    // globalThis.xxx = ...
    // global.xxx = ...
    // Object.defineProperty(globalThis, ...)
    // Object.defineProperty(global, ...)
    const globalAssignmentPattern = /\b(globalThis|global)\.[a-zA-Z0-9_$]+\s*=[^=]/;
    const definePropertyPattern = /\bObject\.defineProperty\s*\(\s*(globalThis|global)\s*,/;

    for (const { name, path } of files) {
      const content = readFileSync(path, "utf8");

      // pdf-worker.ts is the ONLY allowlisted location for isolated worker bootstrap compatibility shim.
      // It executes strictly inside an isolated worker thread (checked via !isMainThread && parentPort).
      if (name === "pdf-worker.ts") {
        // Must contain guard preventing execution in main host thread
        expect(content).toContain("!isMainThread && parentPort");
        expect(content).toContain("globalThis.Iterator");
        continue;
      }

      // Every other production source file must NEVER assign to globals
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Ignore single-line or multi-line comments
        const stripped = line.replace(/\/\/.*$/, "").trim();
        if (stripped.length === 0) continue;

        expect(
          globalAssignmentPattern.test(stripped),
          `Module ${name}:${i + 1} must not assign to global properties: "${stripped}"`
        ).toBe(false);

        expect(
          definePropertyPattern.test(stripped),
          `Module ${name}:${i + 1} must not call Object.defineProperty on globals: "${stripped}"`
        ).toBe(false);
      }
    }
  });

  it("concurrent document extractions across independent tool instances remain fully isolated and deterministic", async () => {
    const pdf1Bytes = buildSimplePdf(["App 1 Page A factual report.", "App 1 Page B factual report."]);
    const pdf2Bytes = buildSimplePdf(["App 2 Page X distinct report.", "App 2 Page Y distinct report."]);

    const fp1 = computeDocumentFingerprint(pdf1Bytes);
    const id1 = computeDocumentId(fp1);
    const fp2 = computeDocumentFingerprint(pdf2Bytes);
    const id2 = computeDocumentId(fp2);

    const provider1: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: "app1.pdf",
        mimeType: "application/pdf",
        bytes: pdf1Bytes,
      }),
    };

    const provider2: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: "app2.pdf",
        mimeType: "application/pdf",
        bytes: pdf2Bytes,
      }),
    };

    const app1Tools = createDocumentTools({ provider: provider1 });
    const app2Tools = createDocumentTools({ provider: provider2 });

    // Execute concurrently across 6 parallel tasks
    const tasks = [
      app1Tools.extractText.handler.execute({
        toolExecutionId: "exec.app1.1",
        tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
        input: { documentRef: "ref-1" },
      }),
      app2Tools.extractText.handler.execute({
        toolExecutionId: "exec.app2.1",
        tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
        input: { documentRef: "ref-2" },
      }),
      app1Tools.extractText.handler.execute({
        toolExecutionId: "exec.app1.2",
        tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
        input: { documentRef: "ref-1" },
      }),
      app2Tools.extractText.handler.execute({
        toolExecutionId: "exec.app2.2",
        tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
        input: { documentRef: "ref-2" },
      }),
    ];

    const results = await Promise.all(tasks);

    const [r1, r2, r3, r4] = results;
    expect(r1?.ok).toBe(true);
    expect(r2?.ok).toBe(true);
    expect(r3?.ok).toBe(true);
    expect(r4?.ok).toBe(true);
    if (!r1?.ok || !r2?.ok || !r3?.ok || !r4?.ok) return;

    const out1_1 = r1.output as unknown as ExtractDocumentOutput;
    const out2_1 = r2.output as unknown as ExtractDocumentOutput;
    const out1_2 = r3.output as unknown as ExtractDocumentOutput;
    const out2_2 = r4.output as unknown as ExtractDocumentOutput;

    // App 1 outputs are identical and match pdf1 identity
    expect(out1_1.data.documentFingerprint).toBe(fp1);
    expect(out1_1.data.documentId).toBe(id1);
    expect(out1_1.data.pages[0]!.text).toBe("App 1 Page A factual report.");
    expect(out1_2.data.documentFingerprint).toBe(fp1);
    expect(out1_2.data.documentId).toBe(id1);

    // App 2 outputs are identical and match pdf2 identity
    expect(out2_1.data.documentFingerprint).toBe(fp2);
    expect(out2_1.data.documentId).toBe(id2);
    expect(out2_1.data.pages[0]!.text).toBe("App 2 Page X distinct report.");
    expect(out2_2.data.documentFingerprint).toBe(fp2);
    expect(out2_2.data.documentId).toBe(id2);

    // Zero cross-application leakage
    expect(out1_1.data.documentId).not.toBe(out2_1.data.documentId);
    expect(out1_1.data.pages[0]!.text).not.toBe(out2_1.data.pages[0]!.text);
  });

  it("redacts secret tokens and prevents path disclosure when parsing malformed PDF containing secrets", async () => {
    const SECRET = "SECRET_DO_NOT_PERSIST_AUTH_BEARER_98765";
    const corruptedPdfWithSecret = new TextEncoder().encode(`%PDF-1.4\ncorrupt header and stream: ${SECRET}\n%%EOF`);

    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: `contract-${SECRET}.pdf`,
        mimeType: "application/pdf",
        bytes: corruptedPdfWithSecret,
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.secret-check",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "secret-doc-ref" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Normalized error code
    expect(result.code).toBe("DOCUMENT_PARSE_FAILED");

    // Must not leak secret token, raw stack trace, or host paths
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("Error:");
    expect(serialized).not.toContain("at ");
    expect(serialized).not.toContain("/Users/");
  });

  it("evidence identity and offsets remain strictly stable across extractions", async () => {
    const pages = [
      "The board of directors approved the quarterly budget on October 18, 2026.",
      "Executive summary: operational expenditure decreased by 12% across departments.",
    ];
    const pdfBytes = buildSimplePdf(pages);

    const fp = computeDocumentFingerprint(pdfBytes);
    const docId = computeDocumentId(fp);

    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: "audit.pdf",
        mimeType: "application/pdf",
        bytes: pdfBytes,
      }),
    };

    const tools = createDocumentTools({ provider });
    const res1 = await tools.extractText.handler.execute({
      toolExecutionId: "exec.stability.1",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "audit-1" },
    });
    const res2 = await tools.extractText.handler.execute({
      toolExecutionId: "exec.stability.2",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "audit-2" },
    });

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    if (!res1.ok || !res2.ok) return;

    const out1 = res1.output as unknown as ExtractDocumentOutput;
    const out2 = res2.output as unknown as ExtractDocumentOutput;

    expect(out1.data.documentFingerprint).toBe(fp);
    expect(out2.data.documentFingerprint).toBe(fp);
    expect(out1.data.documentId).toBe(docId);
    expect(out2.data.documentId).toBe(docId);

    // Exact UTF-16 character counts and offsets match
    expect(out1.data.pages).toEqual(out2.data.pages);
    expect(out1.data.pages[0]!.charCount).toBe(pages[0]!.length);
    expect(out1.data.pages[1]!.charCount).toBe(pages[1]!.length);
  });
});
