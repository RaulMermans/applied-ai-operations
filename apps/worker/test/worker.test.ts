import { describe, expect, it } from "vitest";
import { Worker } from "../src/worker.js";

describe("Worker", () => {
  it("constructs in the CREATED state and exposes its identity", () => {
    const worker = new Worker("worker-1");

    expect(worker.getWorkerId()).toBe("worker-1");
    expect(worker.getState()).toBe("CREATED");
  });

  it("starts into the RUNNING state", () => {
    const worker = new Worker("worker-1");
    worker.start();

    expect(worker.getState()).toBe("RUNNING");
  });

  it("stops into the STOPPED state", () => {
    const worker = new Worker("worker-1");
    worker.start();
    worker.stop();

    expect(worker.getState()).toBe("STOPPED");
  });

  it("follows the deterministic CREATED -> RUNNING -> STOPPED sequence", () => {
    const worker = new Worker("worker-1");
    const observed: string[] = [worker.getState()];

    worker.start();
    observed.push(worker.getState());
    worker.stop();
    observed.push(worker.getState());

    expect(observed).toEqual(["CREATED", "RUNNING", "STOPPED"]);
  });

  it("rejects starting twice", () => {
    const worker = new Worker("worker-1");
    worker.start();

    expect(() => worker.start()).toThrow();
  });

  it("allows stop() to be called safely more than once", () => {
    const worker = new Worker("worker-1");
    worker.start();
    worker.stop();

    expect(() => worker.stop()).not.toThrow();
    expect(worker.getState()).toBe("STOPPED");
  });

  it("allows stop() before start() without throwing", () => {
    const worker = new Worker("worker-1");

    expect(() => worker.stop()).not.toThrow();
    expect(worker.getState()).toBe("STOPPED");
  });

  it("exposes no job-processing or workflow-execution capability", () => {
    const worker = new Worker("worker-1");
    const memberNames = new Set([
      ...Object.getOwnPropertyNames(worker),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(worker) as object),
    ]);

    for (const forbidden of ["run", "execute", "poll", "process", "enqueue", "dequeue"]) {
      expect(memberNames.has(forbidden)).toBe(false);
    }
  });
});
