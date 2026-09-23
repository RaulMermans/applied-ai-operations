import { z } from "zod";
import { ArtifactIdSchema, JsonObjectSchema, NodeIdSchema, RunIdSchema, identifierSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";

/**
 * An Artifact is an intentional output produced or consumed by AAO execution
 * (a report, draft, dataset, document, analysis, or generated file). Binary
 * content is never stored inside this contract; `locationRef` is an opaque
 * JSON-safe pointer (e.g. `{"type":"local-file","path":"..."}`) so storage
 * technology (filesystem, S3, database blob, or anything else) stays
 * replaceable and undecided.
 *
 * `kind` is intentionally an open identifier rather than a closed enum — the
 * set of artifact kinds is expected to grow with capability packs and is not
 * a frozen lifecycle contract like `RunStatus`/`NodeStatus`.
 */
export const ArtifactRefSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    artifactId: ArtifactIdSchema,
    runId: RunIdSchema.optional(),
    nodeId: NodeIdSchema.optional(),
    kind: identifierSchema,
    name: z.string().min(1).optional(),
    createdAt: isoTimestampSchema,
    locationRef: JsonObjectSchema,
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
