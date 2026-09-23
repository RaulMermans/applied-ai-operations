import { describe, expect, it } from "vitest";
import { ArtifactRefSchema } from "../src/artifact.js";

const validArtifact = {
  schemaVersion: 1 as const,
  artifactId: "artifact-0001",
  runId: "run-0001",
  kind: "report",
  name: "Company research report",
  createdAt: "2026-09-23T12:00:00Z",
  locationRef: { type: "local-file", path: "/artifacts/run-0001/report.md" },
};

describe("ArtifactRefSchema", () => {
  it("parses a valid artifact reference", () => {
    expect(ArtifactRefSchema.safeParse(validArtifact).success).toBe(true);
  });

  it("does not embed binary content, only an opaque location reference", () => {
    expect(typeof validArtifact.locationRef).toBe("object");
    expect(ArtifactRefSchema.safeParse(validArtifact).success).toBe(true);
  });

  it("rejects a missing required field", () => {
    const { createdAt: _createdAt, ...malformed } = validArtifact;
    expect(ArtifactRefSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a non-JSON-safe locationRef", () => {
    expect(ArtifactRefSchema.safeParse({ ...validArtifact, locationRef: { handle: () => 1 } }).success).toBe(false);
  });
});
