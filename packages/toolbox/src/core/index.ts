import { defineToolbox, type Toolbox } from "../contract.js";
import { recordsCountBy, recordsDedupe, recordsProject, recordsSort } from "./records.js";
import { textChunk, textNormalize } from "./text.js";

/**
 * The AAO Core Toolbox (`aao.core@1.0.0`): six generic, deterministic,
 * provider- and company-neutral `read_only` Tools for supplied text and
 * JSON records. None reaches a network, filesystem, environment variable,
 * clock, model, or credential, and none needs Approval. Importing it
 * registers nothing: a host selects Tools with `selectToolboxTools` and
 * passes them to `createAAO`.
 */
export const coreToolbox: Toolbox = defineToolbox({
  manifest: {
    id: "aao.core",
    version: "1.0.0",
    name: "AAO Core Toolbox",
    description: "Generic, deterministic, side-effect-free Tools for normalizing and chunking supplied text and for deduplicating, projecting, sorting, and counting supplied JSON records. Provider- and company-neutral; every Tool runs through the normal governed Tool Runtime.",
    entries: [
      {
        toolRef: { id: "text.normalize", version: "1.0.0" },
        category: "text",
        tags: ["cleanup", "line-endings", "normalize", "unicode", "whitespace"],
        whenToUse: [
          "Text from mixed sources needs consistent LF line endings and trimmed outer whitespace before comparison, chunking, or storage.",
          "A step needs a specific Unicode normalization form (NFC, NFD, NFKC, NFKD), named explicitly.",
          "Runs of blank lines or trailing spaces should be capped or removed deterministically.",
        ],
        whenNotToUse: [
          "You need to rewrite, summarize, translate, spell-check, or change the wording or case of text.",
          "You need to sanitize HTML or strip markup: this Tool does not parse markup.",
          "Exact original bytes must be preserved, for example for signatures or hashing of the source.",
        ],
        examples: [
          { title: "Clean pasted text", input: { text: "  First line\r\nSecond line  \r\n\r\n\r\n\r\nThird line\n", trimTrailingWhitespace: true, maxConsecutiveBlankLines: 1 } },
          { title: "Compose accented characters", input: { text: "Café", unicodeNormalization: "NFC" }, notes: "Only the named form is applied; nothing else changes." },
        ],
      },
      {
        toolRef: { id: "text.chunk", version: "1.0.0" },
        category: "text",
        tags: ["chunk", "offsets", "overlap", "split", "window"],
        whenToUse: [
          "Long supplied text must be split into bounded pieces for downstream steps with size limits.",
          "Downstream steps need exact UTF-16 start and end offsets back into the source text.",
          "Neighbouring chunks should share a fixed overlap of characters.",
        ],
        whenNotToUse: [
          "You need semantic, sentence-aware, heading-aware, or tokenizer-based chunking.",
          "You need to fetch, read, or parse a document: supply the text yourself.",
          "The text is already short enough for the next step.",
        ],
        examples: [
          { title: "Chunk with overlap", input: { text: "AAO keeps workflows governed and bounded.", maxChars: 16, overlapChars: 4 } },
          { title: "Continue a partial result", input: { text: "abcdefghij", maxChars: 4, maxChunks: 2, startOffset: 8 }, notes: "Pass the previous meta.nextOffset as startOffset." },
        ],
      },
      {
        toolRef: { id: "records.dedupe", version: "1.0.0" },
        category: "records",
        tags: ["dedupe", "duplicates", "exact-match", "keys", "unique"],
        whenToUse: [
          "Records may repeat and duplicates are defined by exact equality of chosen top-level fields.",
          "You need the first (or last) record of each duplicate group, in original order.",
        ],
        whenNotToUse: [
          "Duplicates are near matches, differently spelled names, or need entity resolution: this Tool never does fuzzy or semantic matching.",
          "Duplicates are defined by nested fields or computed values.",
        ],
        examples: [{ title: "Remove repeated accounts by id", input: { records: [{ id: "a-1", name: "Acme" }, { id: "a-2", name: "Globex" }, { id: "a-1", name: "Acme Inc" }], keys: ["id"] } }],
      },
      {
        toolRef: { id: "records.project", version: "1.0.0" },
        category: "records",
        tags: ["fields", "project", "select", "subset"],
        whenToUse: [
          "Later steps need only some top-level fields of each record.",
          "Fields a later step must not see should be dropped explicitly.",
        ],
        whenNotToUse: [
          "You need nested paths, renamed or computed fields, or filtering of records.",
          "You need a null placeholder for missing fields: missing fields are omitted.",
        ],
        examples: [{ title: "Keep id and name", input: { records: [{ id: "a-1", name: "Acme", owner: "user.alice" }], fields: ["id", "name"] } }],
      },
      {
        toolRef: { id: "records.sort", version: "1.0.0" },
        category: "records",
        tags: ["order", "rank", "sort", "stable"],
        whenToUse: [
          "Records need a stable, deterministic order by up to three scalar fields.",
          "The order must not depend on locale, environment, or input key order.",
        ],
        whenNotToUse: [
          "You need locale-aware or natural (human) string collation.",
          "Sort values are objects or arrays, or live in nested fields.",
        ],
        examples: [{ title: "Highest score first, then by name", input: { records: [{ name: "b", score: 2 }, { name: "a", score: 2 }, { name: "c", score: 5 }], keys: [{ field: "score", direction: "desc" }, { field: "name" }] } }],
      },
      {
        toolRef: { id: "records.count_by", version: "1.0.0" },
        category: "records",
        tags: ["count", "distribution", "group", "histogram"],
        whenToUse: [
          "You need how many records share each value of one status or category field.",
          "Missing, null, and differently typed values must be counted separately.",
        ],
        whenNotToUse: [
          "You need sums, averages, or other statistics.",
          "You need to group by several fields, nested fields, or computed values.",
        ],
        examples: [{ title: "Count tickets by status", input: { records: [{ status: "open" }, { status: "closed" }, { status: "open" }, { status: null }, {}], field: "status" } }],
      },
    ],
  },
  tools: [textNormalize, textChunk, recordsDedupe, recordsProject, recordsSort, recordsCountBy],
});
