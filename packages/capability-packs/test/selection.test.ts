import { describe, expect, it } from "vitest";
import {
  validateCompanyPackSelection,
  CapabilityPackError,
  type CompanyPackSelectionV1Input,
} from "../src/index.js";

describe("Company Pack Selection V1", () => {
  it("validates a valid pack selection and freezes it", () => {
    const valid: CompanyPackSelectionV1Input = {
      schemaVersion: 1,
      companyId: "northstar-commerce",
      packRefs: [
        { id: "aao.company-research", version: "1.0.0" },
        { id: "aao.document-intelligence", version: "1.0.0" },
        { id: "aao.operational-request", version: "1.0.0" },
      ],
    };

    const validated = validateCompanyPackSelection(valid);
    expect(validated.companyId).toBe("northstar-commerce");
    expect(validated.packRefs).toHaveLength(3);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.packRefs)).toBe(true);
  });

  it("parses valid JSON string input", () => {
    const jsonStr = JSON.stringify({
      schemaVersion: 1,
      companyId: "arbor-consulting",
      packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
    });

    const validated = validateCompanyPackSelection(jsonStr);
    expect(validated.companyId).toBe("arbor-consulting");
    expect(validated.packRefs).toHaveLength(1);
  });

  it("rejects non-JSON or primitive input", () => {
    expect(() => validateCompanyPackSelection("not valid json")).toThrow(CapabilityPackError);
    expect(() => validateCompanyPackSelection(null)).toThrow(CapabilityPackError);
    expect(() => validateCompanyPackSelection(123)).toThrow(CapabilityPackError);
  });

  it("rejects invalid schemaVersion", () => {
    const invalid = {
      schemaVersion: 2,
      companyId: "northstar-commerce",
      packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
    };
    expect(() => validateCompanyPackSelection(invalid)).toThrow(CapabilityPackError);
    expect(() => validateCompanyPackSelection(invalid)).toThrow(/Unsupported selection schemaVersion 2/);
  });

  it("rejects empty packRefs array", () => {
    const invalid = {
      schemaVersion: 1,
      companyId: "northstar-commerce",
      packRefs: [],
    };
    expect(() => validateCompanyPackSelection(invalid)).toThrow(CapabilityPackError);
    expect(() => validateCompanyPackSelection(invalid)).toThrow(/at least one pack reference/);
  });

  it("rejects duplicate pack references in selection", () => {
    const invalid = {
      schemaVersion: 1,
      companyId: "northstar-commerce",
      packRefs: [
        { id: "aao.company-research", version: "1.0.0" },
        { id: "aao.company-research", version: "1.0.0" },
      ],
    };
    expect(() => validateCompanyPackSelection(invalid)).toThrow(CapabilityPackError);
    expect(() => validateCompanyPackSelection(invalid)).toThrow(/duplicate pack references/);
  });

  it("rejects prototype pollution keys", () => {
    const polluted = '{"schemaVersion":1,"companyId":"test","__proto__":{"bad":true},"packRefs":[{"id":"aao.test","version":"1.0.0"}]}';
    expect(() => validateCompanyPackSelection(polluted)).toThrow(CapabilityPackError);
    expect(() => validateCompanyPackSelection(polluted)).toThrow(/prototype-pollution/);
  });
});
