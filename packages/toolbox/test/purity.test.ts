// Runtime proof of handler purity, complementing the static source scans in
// public-api.test.ts: while every Core Tool's catalog examples run, no socket
// is opened, `fetch` is never called, no filesystem function is called, no
// environment variable is read, and neither the clock nor randomness is used.
import fs from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coreToolbox, listToolboxEntries } from "../src/index.js";
import { callHandler } from "./support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Core Tool handlers are pure at runtime", () => {
  it("running every catalog example touches no network, filesystem, environment, clock, or randomness", async () => {
    const socketConnect = vi.spyOn(net.Socket.prototype, "connect");
    const fsCalls = (["readFileSync", "writeFileSync", "openSync", "readdirSync", "statSync", "existsSync", "readFile", "writeFile"] as const).map((name) => vi.spyOn(fs, name));
    const fetchSpy = vi.fn(async () => {
      throw new Error("network forbidden");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const realEnv = process.env;
    const envReads: PropertyKey[] = [];
    process.env = new Proxy(realEnv, { get: (target, key) => (envReads.push(key), Reflect.get(target, key)) });
    const now = vi.spyOn(Date, "now");
    const random = vi.spyOn(Math, "random");
    let examples = 0;
    try {
      for (const entry of listToolboxEntries(coreToolbox)) {
        for (const example of entry.examples) {
          expect((await callHandler(entry.toolRef.id, example.input)).ok, `${entry.toolRef.id}: ${example.title}`).toBe(true);
          examples += 1;
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
      process.env = realEnv;
    }
    expect(examples).toBe(8);
    expect(socketConnect).not.toHaveBeenCalled();
    for (const spy of fsCalls) expect(spy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(envReads).toEqual([]);
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });
});
