import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  DOCUMENT_EXTRACT_TEXT_TOOL_REF,
  DOCUMENT_LIMITS,
  createDocumentTools,
  type DocumentSourceProvider,
  type ExtractDocumentOutput,
} from "../src/index.js";
import {
  _getActivePdfWorkerCountForTest,
  _resetWorkerAdmissionForTest,
  _setWorkerFactoryForTest,
  parseDocumentBytes,
  type PdfWorkerFactory,
  type WorkerFactoryOptions,
  type WorkerLike,
} from "../src/parser.js";
import { buildSimplePdf } from "./document-tools.test.js";

const SECRET = "SECRET_DO_NOT_PERSIST_GOVERNANCE_TOKEN_42";

function createFakeWorker() {
  const messageListeners: ((msg: unknown) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];
  const exitListeners: ((code: number) => void)[] = [];
  let terminated = false;

  const worker: WorkerLike = {
    on(event: "message" | "error" | "exit", listener: unknown) {
      if (event === "message") messageListeners.push(listener as (msg: unknown) => void);
      if (event === "error") errorListeners.push(listener as (err: Error) => void);
      if (event === "exit") exitListeners.push(listener as (code: number) => void);
      return worker;
    },
    async terminate() {
      terminated = true;
      return 0;
    },
  };

  return {
    worker,
    emitMessage: (msg: unknown) => {
      for (const l of messageListeners) l(msg);
    },
    emitError: (err: Error) => {
      for (const l of errorListeners) l(err);
    },
    emitExit: (code: number) => {
      for (const l of exitListeners) l(code);
    },
    isTerminated: () => terminated,
  };
}

describe("Worker Resource Governance & Concurrency (Sprint 23D)", () => {
  beforeEach(() => {
    _resetWorkerAdmissionForTest();
  });

  afterEach(() => {
    _resetWorkerAdmissionForTest();
  });

  it("single PDF extraction succeeds and releases worker permit", async () => {
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
    const pdfBytes = buildSimplePdf(["Page 1 single extraction."]);

    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: "single.pdf",
        mimeType: "application/pdf",
        bytes: pdfBytes,
      }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.single",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "doc.single" },
    });

    expect(result.ok).toBe(true);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("concurrency saturation: 2 simultaneous workers admitted; 3rd refused with DOCUMENT_PARSER_BUSY before worker creation", async () => {
    const pdfBytes = buildSimplePdf(["Content"]);
    let workerSpawnCount = 0;

    let releaseWorker1!: () => void;
    const worker1Gate = new Promise<void>((r) => { releaseWorker1 = r; });

    let releaseWorker2!: () => void;
    const worker2Gate = new Promise<void>((r) => { releaseWorker2 = r; });

    let onWorker1Started!: () => void;
    const worker1Started = new Promise<void>((r) => { onWorker1Started = r; });

    let onWorker2Started!: () => void;
    const worker2Started = new Promise<void>((r) => { onWorker2Started = r; });

    const barrierFactory: PdfWorkerFactory = () => {
      workerSpawnCount++;
      const currentWorkerIndex = workerSpawnCount;
      const fake = createFakeWorker();

      // Defer simulated completion until gate is opened
      void (async () => {
        if (currentWorkerIndex === 1) {
          onWorker1Started();
          await worker1Gate;
        } else if (currentWorkerIndex === 2) {
          onWorker2Started();
          await worker2Gate;
        }
        const text = `Worker ${currentWorkerIndex} content.`;
        fake.emitMessage({
          ok: true,
          pages: [{ pageNumber: 1, text, charCount: text.length }],
          pagesTotal: 1,
          pagesExtracted: 1,
          charactersExtracted: text.length,
          partialReasons: [],
          isPartial: false,
        });
      })();

      return fake.worker;
    };

    _setWorkerFactoryForTest(barrierFactory);

    const provider: DocumentSourceProvider = {
      read: async () => ({
        status: "succeeded",
        filename: "barrier.pdf",
        mimeType: "application/pdf",
        bytes: pdfBytes,
      }),
    };

    const tools = createDocumentTools({ provider });

    // Launch worker 1 and worker 2
    const promise1 = tools.extractText.handler.execute({
      toolExecutionId: "exec.1",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "doc.1" },
    });

    const promise2 = tools.extractText.handler.execute({
      toolExecutionId: "exec.2",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "doc.2" },
    });

    // Wait until both workers have spawned and are running concurrently
    await Promise.all([worker1Started, worker2Started]);
    expect(_getActivePdfWorkerCountForTest()).toBe(2);
    expect(workerSpawnCount).toBe(2);

    // Now launch worker 3: capacity is full!
    const result3 = await tools.extractText.handler.execute({
      toolExecutionId: "exec.3",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "doc.3" },
    });

    // Must be rejected immediately with DOCUMENT_PARSER_BUSY
    expect(result3.ok).toBe(false);
    if (!result3.ok) {
      expect(result3.code).toBe("DOCUMENT_PARSER_BUSY");
      expect(result3.retryable).toBeUndefined(); // Non-retryable
    }

    // Crucial: ZERO 3rd worker was created!
    expect(workerSpawnCount).toBe(2);
    expect(_getActivePdfWorkerCountForTest()).toBe(2);

    // Release worker 1
    releaseWorker1();
    const result1 = await promise1;
    expect(result1.ok).toBe(true);

    // Permit from worker 1 released: active count is now 1
    expect(_getActivePdfWorkerCountForTest()).toBe(1);

    // Now retry request 3: capacity is now available!
    let onWorker3Started!: () => void;
    const worker3Started = new Promise<void>((r) => { onWorker3Started = r; });
    let releaseWorker3!: () => void;
    const worker3Gate = new Promise<void>((r) => { releaseWorker3 = r; });

    // Temporarily replace factory for worker 3
    _setWorkerFactoryForTest(() => {
      workerSpawnCount++;
      const fake = createFakeWorker();
      void (async () => {
        onWorker3Started();
        await worker3Gate;
        const text = "Worker 3 retried content.";
        fake.emitMessage({
          ok: true,
          pages: [{ pageNumber: 1, text, charCount: text.length }],
          pagesTotal: 1,
          pagesExtracted: 1,
          charactersExtracted: text.length,
          partialReasons: [],
          isPartial: false,
        });
      })();
      return fake.worker;
    });

    const promise3Retry = tools.extractText.handler.execute({
      toolExecutionId: "exec.3.retry",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "doc.3" },
    });

    await worker3Started;
    expect(workerSpawnCount).toBe(3);
    expect(_getActivePdfWorkerCountForTest()).toBe(2);

    // Release worker 2 and worker 3
    releaseWorker2();
    releaseWorker3();

    const [result2, result3Retried] = await Promise.all([promise2, promise3Retry]);
    expect(result2.ok).toBe(true);
    expect(result3Retried.ok).toBe(true);

    // All workers released
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("capacity applies across independent Framework application instances", async () => {
    let releaseWorker1!: () => void;
    const worker1Gate = new Promise<void>((r) => { releaseWorker1 = r; });
    let onWorker1Started!: () => void;
    const worker1Started = new Promise<void>((r) => { onWorker1Started = r; });

    let releaseWorker2!: () => void;
    const worker2Gate = new Promise<void>((r) => { releaseWorker2 = r; });
    let onWorker2Started!: () => void;
    const worker2Started = new Promise<void>((r) => { onWorker2Started = r; });

    let spawnIndex = 0;
    _setWorkerFactoryForTest(() => {
      spawnIndex++;
      const idx = spawnIndex;
      const fake = createFakeWorker();
      void (async () => {
        if (idx === 1) { onWorker1Started(); await worker1Gate; }
        if (idx === 2) { onWorker2Started(); await worker2Gate; }
        const text = `App ${idx} text.`;
        fake.emitMessage({
          ok: true,
          pages: [{ pageNumber: 1, text, charCount: text.length }],
          pagesTotal: 1,
          pagesExtracted: 1,
          charactersExtracted: text.length,
          partialReasons: [],
          isPartial: false,
        });
      })();
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["Content"]);
    const providerA: DocumentSourceProvider = {
      read: async () => ({ status: "succeeded", filename: "appA.pdf", mimeType: "application/pdf", bytes: pdfBytes }),
    };
    const providerB: DocumentSourceProvider = {
      read: async () => ({ status: "succeeded", filename: "appB.pdf", mimeType: "application/pdf", bytes: pdfBytes }),
    };
    const providerC: DocumentSourceProvider = {
      read: async () => ({ status: "succeeded", filename: "appC.pdf", mimeType: "application/pdf", bytes: pdfBytes }),
    };

    const appA = createDocumentTools({ provider: providerA });
    const appB = createDocumentTools({ provider: providerB });
    const appC = createDocumentTools({ provider: providerC });

    // App A and App B spawn 1 worker each
    const promiseA = appA.extractText.handler.execute({
      toolExecutionId: "exec.appA",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "refA" },
    });
    const promiseB = appB.extractText.handler.execute({
      toolExecutionId: "exec.appB",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "refB" },
    });

    await Promise.all([worker1Started, worker2Started]);
    expect(_getActivePdfWorkerCountForTest()).toBe(2);

    // App C tries to extract: process-wide capacity is exhausted!
    const resultC = await appC.extractText.handler.execute({
      toolExecutionId: "exec.appC",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "refC" },
    });

    expect(resultC.ok).toBe(false);
    if (!resultC.ok) {
      expect(resultC.code).toBe("DOCUMENT_PARSER_BUSY");
    }

    releaseWorker1();
    releaseWorker2();

    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("plain-text extraction is completely unaffected by PDF capacity saturation", async () => {
    let releaseWorker1!: () => void;
    const worker1Gate = new Promise<void>((r) => { releaseWorker1 = r; });
    let releaseWorker2!: () => void;
    const worker2Gate = new Promise<void>((r) => { releaseWorker2 = r; });

    let onWorker1Started!: () => void;
    const worker1Started = new Promise<void>((r) => { onWorker1Started = r; });
    let onWorker2Started!: () => void;
    const worker2Started = new Promise<void>((r) => { onWorker2Started = r; });

    let startedCount = 0;

    _setWorkerFactoryForTest(() => {
      startedCount++;
      const idx = startedCount;
      const fake = createFakeWorker();
      void (async () => {
        if (idx === 1) { onWorker1Started(); await worker1Gate; }
        if (idx === 2) { onWorker2Started(); await worker2Gate; }
        const text = "PDF text.";
        fake.emitMessage({
          ok: true,
          pages: [{ pageNumber: 1, text, charCount: text.length }],
          pagesTotal: 1,
          pagesExtracted: 1,
          charactersExtracted: text.length,
          partialReasons: [],
          isPartial: false,
        });
      })();
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["PDF"]);
    const textBytes = new TextEncoder().encode("Immediate plain text without worker.");

    const provider: DocumentSourceProvider = {
      read: async (req) => {
        if (req.documentRef.endsWith(".txt")) {
          return { status: "succeeded", filename: "doc.txt", mimeType: "text/plain", bytes: textBytes };
        }
        return { status: "succeeded", filename: "doc.pdf", mimeType: "application/pdf", bytes: pdfBytes };
      },
    };

    const tools = createDocumentTools({ provider });

    // Fill PDF capacity to limit (2 active workers)
    const p1 = tools.extractText.handler.execute({ toolExecutionId: "p1", tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF, input: { documentRef: "1.pdf" } });
    const p2 = tools.extractText.handler.execute({ toolExecutionId: "p2", tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF, input: { documentRef: "2.pdf" } });

    await Promise.all([worker1Started, worker2Started]);
    expect(_getActivePdfWorkerCountForTest()).toBe(2);

    // Plain text request arrives while PDF workers are active: MUST SUCCEED IMMEDIATELY!
    const textResult = await tools.extractText.handler.execute({
      toolExecutionId: "exec.plain",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "doc.txt" },
    });

    expect(textResult.ok).toBe(true);
    if (textResult.ok) {
      const out = textResult.output as unknown as ExtractDocumentOutput;
      expect(out.data.pages[0]!.text).toBe("Immediate plain text without worker.");
    }

    // Clean up
    releaseWorker1();
    releaseWorker2();
    await Promise.all([p1, p2]);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("worker creation throwing releases permit and returns DOCUMENT_PARSE_FAILED without leaking capacity", async () => {
    _setWorkerFactoryForTest(() => {
      throw new Error(`Worker initialization failed: ${SECRET}`);
    });

    const pdfBytes = buildSimplePdf(["Throws on creation"]);
    const provider: DocumentSourceProvider = {
      read: async () => ({ status: "succeeded", filename: "throw.pdf", mimeType: "application/pdf", bytes: pdfBytes }),
    };

    const tools = createDocumentTools({ provider });
    const result = await tools.extractText.handler.execute({
      toolExecutionId: "exec.throw-create",
      tool: DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      input: { documentRef: "doc.throw" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DOCUMENT_PARSE_FAILED");
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("worker error event releases permit and normalizes to DOCUMENT_PARSE_FAILED", async () => {
    _setWorkerFactoryForTest(() => {
      const fake = createFakeWorker();
      queueMicrotask(() => {
        fake.emitError(new Error(`Worker internal runtime error: ${SECRET}`));
      });
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["Error event"]);
    const result = await parseDocumentBytes(pdfBytes, "application/pdf");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DOCUMENT_PARSE_FAILED");
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("worker abnormal exit releases permit and normalizes to DOCUMENT_PARSE_FAILED", async () => {
    _setWorkerFactoryForTest(() => {
      const fake = createFakeWorker();
      queueMicrotask(() => {
        fake.emitExit(1); // Abnormal exit
      });
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["Abnormal exit"]);
    const result = await parseDocumentBytes(pdfBytes, "application/pdf");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DOCUMENT_PARSE_FAILED");
    }
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("worker unexpected exit with code 0 without message normalizes to DOCUMENT_PARSE_FAILED", async () => {
    _setWorkerFactoryForTest(() => {
      const fake = createFakeWorker();
      queueMicrotask(() => {
        fake.emitExit(0); // Exit code 0 but no result posted
      });
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["Silent exit"]);
    const result = await parseDocumentBytes(pdfBytes, "application/pdf");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DOCUMENT_PARSE_FAILED");
    }
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("worker is spawned with configured V8 resourceLimits", async () => {
    let capturedOptions: WorkerFactoryOptions | null = null;

    _setWorkerFactoryForTest((options) => {
      capturedOptions = options;
      const fake = createFakeWorker();
      queueMicrotask(() => {
        fake.emitMessage({
          ok: true,
          pages: [{ pageNumber: 1, text: "Checked.", charCount: 8 }],
          pagesTotal: 1,
          pagesExtracted: 1,
          charactersExtracted: 8,
          partialReasons: [],
          isPartial: false,
        });
      });
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["Resource limits check"]);
    const result = await parseDocumentBytes(pdfBytes, "application/pdf");

    expect(result.ok).toBe(true);
    expect(capturedOptions).not.toBeNull();
    if (capturedOptions !== null) {
      const opts: WorkerFactoryOptions = capturedOptions;
      expect(opts.resourceLimits).toEqual(DOCUMENT_LIMITS.workerResourceLimits);
      expect(opts.resourceLimits.maxOldGenerationSizeMb).toBe(128);
      expect(opts.resourceLimits.maxYoungGenerationSizeMb).toBe(32);
      expect(opts.resourceLimits.stackSizeMb).toBe(4);
    }
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("worker memory limit failure (ERR_WORKER_OUT_OF_MEMORY) normalizes safely to DOCUMENT_PARSE_FAILED", async () => {
    _setWorkerFactoryForTest(() => {
      const fake = createFakeWorker();
      queueMicrotask(() => {
        const oomErr = Object.assign(new Error("Worker terminated due to reaching memory limit: JS heap out of memory"), {
          code: "ERR_WORKER_OUT_OF_MEMORY",
        });
        fake.emitError(oomErr);
      });
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["OOM scenario"]);
    const result = await parseDocumentBytes(pdfBytes, "application/pdf");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DOCUMENT_PARSE_FAILED");
    }
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("active cancellation: caller aborts while worker executes; worker terminated, permit released, next request succeeds", async () => {
    let onWorkerStarted!: () => void;
    const workerStarted = new Promise<void>((r) => { onWorkerStarted = r; });
    let createdFake: ReturnType<typeof createFakeWorker> | null = null;

    _setWorkerFactoryForTest(() => {
      const fake = createFakeWorker();
      createdFake = fake;
      queueMicrotask(() => {
        onWorkerStarted();
      });
      return fake.worker;
    });

    const controller = new AbortController();
    const pdfBytes = buildSimplePdf(["Active cancellation"]);

    const parsePromise = parseDocumentBytes(pdfBytes, "application/pdf", { signal: controller.signal });

    // Wait until worker is actively executing
    await workerStarted;
    expect(_getActivePdfWorkerCountForTest()).toBe(1);
    expect(createdFake!.isTerminated()).toBe(false);

    // Abort active parse
    controller.abort();

    const result = await parsePromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CANCELLED");
    }
    expect(createdFake!.isTerminated()).toBe(true);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);

    // Subsequent request succeeds
    _setWorkerFactoryForTest(null); // restore real worker
    const subsequentResult = await parseDocumentBytes(pdfBytes, "application/pdf");
    expect(subsequentResult.ok).toBe(true);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("timeout: worker times out; worker terminated, permit released, next request succeeds", async () => {
    let createdFake: ReturnType<typeof createFakeWorker> | null = null;

    _setWorkerFactoryForTest(() => {
      const fake = createFakeWorker();
      createdFake = fake;
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["Timeout scenario"]);

    // Set a very short timeout of 10ms for test
    const result = await parseDocumentBytes(pdfBytes, "application/pdf", { timeoutMs: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DOCUMENT_PARSE_FAILED");
    }
    expect(createdFake!.isTerminated()).toBe(true);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);

    // Subsequent request succeeds
    _setWorkerFactoryForTest(null);
    const subsequentResult = await parseDocumentBytes(pdfBytes, "application/pdf");
    expect(subsequentResult.ok).toBe(true);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("cancellation and timeout race settles exactly once and releases permit cleanly", async () => {
    let terminateCallCount = 0;
    const controller = new AbortController();

    _setWorkerFactoryForTest(() => {
      const fake = createFakeWorker();
      const origTerminate = fake.worker.terminate.bind(fake.worker);
      fake.worker.terminate = async () => {
        terminateCallCount++;
        return origTerminate();
      };
      // Fire abort immediately on next tick while timeout also triggers
      queueMicrotask(() => {
        controller.abort();
      });
      return fake.worker;
    });

    const pdfBytes = buildSimplePdf(["Race scenario"]);
    const result = await parseDocumentBytes(pdfBytes, "application/pdf", { signal: controller.signal, timeoutMs: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["CANCELLED", "DOCUMENT_PARSE_FAILED"]).toContain(result.code);
    }
    expect(terminateCallCount).toBe(1);
    expect(_getActivePdfWorkerCountForTest()).toBe(0);
  });

  it("trusted timeoutMs override bounds check: clamps invalid values to safe defaults without throwing", async () => {
    const pdfBytes = buildSimplePdf(["Timeout bounds check"]);

    // Negative, zero, NaN, float values fall back to safe default
    const scenarios = [-100, 0, NaN, Infinity, -Infinity, 1.5];
    for (const invalidTimeout of scenarios) {
      const result = await parseDocumentBytes(pdfBytes, "application/pdf", { timeoutMs: invalidTimeout });
      expect(result.ok).toBe(true);
      expect(_getActivePdfWorkerCountForTest()).toBe(0);
    }
  });

  it("worker result validation: rejects malformed worker messages and releases capacity", async () => {
    const malformedMessages = [
      null,
      undefined,
      "not an object",
      12345,
      [],
      // ok: false with unexpected error code
      { ok: false, code: "SOME_RANDOM_CODE" },
      { ok: false, code: 999 },
      // ok: true with missing/invalid pages
      { ok: true, pages: null, pagesTotal: 1, pagesExtracted: 1, charactersExtracted: 0, partialReasons: [], isPartial: false },
      { ok: true, pages: [], pagesTotal: 0, pagesExtracted: 0, charactersExtracted: 0, partialReasons: [], isPartial: false },
      // ok: true with invalid pageNumber (starts at 2)
      { ok: true, pages: [{ pageNumber: 2, text: "A", charCount: 1 }], pagesTotal: 1, pagesExtracted: 1, charactersExtracted: 1, partialReasons: [], isPartial: false },
      // ok: true with non-contiguous page numbers ([1, 3])
      {
        ok: true,
        pages: [
          { pageNumber: 1, text: "A", charCount: 1 },
          { pageNumber: 3, text: "B", charCount: 1 },
        ],
        pagesTotal: 2,
        pagesExtracted: 2,
        charactersExtracted: 2,
        partialReasons: [],
        isPartial: false,
      },
      // ok: true with charCount mismatch
      { ok: true, pages: [{ pageNumber: 1, text: "Hello", charCount: 999 }], pagesTotal: 1, pagesExtracted: 1, charactersExtracted: 5, partialReasons: [], isPartial: false },
      // ok: true with pagesTotal < pages.length
      { ok: true, pages: [{ pageNumber: 1, text: "Hello", charCount: 5 }], pagesTotal: 0, pagesExtracted: 1, charactersExtracted: 5, partialReasons: [], isPartial: false },
      // ok: true with charactersExtracted mismatch
      { ok: true, pages: [{ pageNumber: 1, text: "Hello", charCount: 5 }], pagesTotal: 1, pagesExtracted: 1, charactersExtracted: 999, partialReasons: [], isPartial: false },
      // ok: true with isPartial mismatch
      { ok: true, pages: [{ pageNumber: 1, text: "Hello", charCount: 5 }], pagesTotal: 1, pagesExtracted: 1, charactersExtracted: 5, partialReasons: ["SOME_REASON"], isPartial: false },
      // ok: true with partialReasons not string array
      { ok: true, pages: [{ pageNumber: 1, text: "Hello", charCount: 5 }], pagesTotal: 1, pagesExtracted: 1, charactersExtracted: 5, partialReasons: [123], isPartial: true },
    ];

    const pdfBytes = buildSimplePdf(["Validation check"]);

    for (const badMsg of malformedMessages) {
      _setWorkerFactoryForTest(() => {
        const fake = createFakeWorker();
        queueMicrotask(() => {
          fake.emitMessage(badMsg);
        });
        return fake.worker;
      });

      const res = await parseDocumentBytes(pdfBytes, "application/pdf");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("DOCUMENT_PARSE_FAILED");
      }
      expect(_getActivePdfWorkerCountForTest()).toBe(0);
    }
  });

  it("redacts secret tokens from worker exceptions, errors, and messages", async () => {
    const scenarios: PdfWorkerFactory[] = [
      // Error in worker message
      () => {
        const fake = createFakeWorker();
        queueMicrotask(() => {
          fake.emitMessage({ ok: false, code: `DOCUMENT_PARSE_FAILED_${SECRET}` });
        });
        return fake.worker;
      },
      // Error in worker error event
      () => {
        const fake = createFakeWorker();
        queueMicrotask(() => {
          fake.emitError(new Error(`Fatal worker error containing ${SECRET} in stack trace`));
        });
        return fake.worker;
      },
      // Constructor throw
      () => {
        throw new Error(`Failed to instantiate worker with secret: ${SECRET}`);
      },
    ];

    const pdfBytes = buildSimplePdf(["Privacy check"]);

    for (const factory of scenarios) {
      _setWorkerFactoryForTest(factory);
      const res = await parseDocumentBytes(pdfBytes, "application/pdf");
      expect(res.ok).toBe(false);
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("Error:");
      expect(serialized).not.toContain("stack");
      expect(serialized).not.toContain("/Users/");
      expect(_getActivePdfWorkerCountForTest()).toBe(0);
    }
  });
});
