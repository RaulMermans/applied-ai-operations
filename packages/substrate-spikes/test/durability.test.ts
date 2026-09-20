import { describe, expect, it } from "vitest";
import { CheckpointError, LocalDurableSpike } from "../src/durability.js";

describe("AAO-owned local durability contract", () => {
  it("resumes a checkpoint and never repeats a completed operation", async () => {
    const durable = new LocalDurableSpike();
    let sideEffects = 0;
    await durable.start("run-1");
    await durable.executeOnce("run-1", "write-audit-artifact", () => { sideEffects += 1; });
    await durable.cancel("run-1");
    const resumed = await durable.resume("run-1");
    expect(resumed.checkpoint).toBe(1);
    await durable.executeOnce("run-1", "write-audit-artifact", () => { sideEffects += 1; });
    expect(sideEffects).toBe(1);
  });

  it("fails explicitly for a missing checkpoint", async () => {
    await expect(new LocalDurableSpike().resume("missing")).rejects.toBeInstanceOf(CheckpointError);
  });
});
