import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadWorkerConfig } from "../src/index.js";

describe("loadWorkerConfig", () => {
  it("applies documented defaults for an empty environment", () => {
    const config = loadWorkerConfig({});

    expect(config).toEqual({
      env: "development",
      logLevel: "info",
      workerId: "aao-worker-local",
    });
  });

  it("honors explicit overrides", () => {
    const config = loadWorkerConfig({
      AAO_ENV: "test",
      AAO_LOG_LEVEL: "debug",
      AAO_WORKER_ID: "worker-7",
    });

    expect(config).toEqual({
      env: "test",
      logLevel: "debug",
      workerId: "worker-7",
    });
  });

  it("rejects an empty worker id", () => {
    expect(() => loadWorkerConfig({ AAO_WORKER_ID: "" })).toThrow(ConfigValidationError);
  });

  it("rejects an unrecognized environment", () => {
    expect(() => loadWorkerConfig({ AAO_ENV: "staging" })).toThrow(ConfigValidationError);
  });

  it("rejects an unrecognized log level", () => {
    expect(() => loadWorkerConfig({ AAO_LOG_LEVEL: "verbose" })).toThrow(ConfigValidationError);
  });

  it("loads independently from two isolated env objects", () => {
    const a = loadWorkerConfig({ AAO_WORKER_ID: "worker-a" });
    const b = loadWorkerConfig({ AAO_WORKER_ID: "worker-b" });

    expect(a.workerId).toBe("worker-a");
    expect(b.workerId).toBe("worker-b");
  });
});
