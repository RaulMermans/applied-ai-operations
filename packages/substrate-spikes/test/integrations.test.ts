import { describe, expect, it } from "vitest";
import { FakeCRMAdapterA, FakeCRMAdapterB, findQualifiedAccounts } from "../src/integrations.js";

describe("canonical CRM capability", () => {
  it("keeps workflow behavior provider-independent", async () => {
    const adapterA = new FakeCRMAdapterA([{ account_id: "a-1", display_name: "Acme", quality_score: 90 }]);
    const adapterB = new FakeCRMAdapterB([{ id: "b-1", company: { name: "Acme" }, metrics: { score: 90 } }]);
    await expect(findQualifiedAccounts(adapterA, "acme")).resolves.toEqual(["Acme"]);
    await expect(findQualifiedAccounts(adapterB, "acme")).resolves.toEqual(["Acme"]);
  });
});
