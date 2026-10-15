export const TOOLBOX_ERROR_CODES = [
  /** The manifest is not a JSON-safe value that satisfies `ToolboxManifestSchema`. */
  "TOOLBOX_MANIFEST_INVALID",
  /** A Tool definition is invalid, duplicated, or not admissible to a Toolbox. */
  "TOOLBOX_TOOL_INVALID",
  /** Manifest entries and Tool definitions do not correspond one to one. */
  "TOOLBOX_ENTRY_MISMATCH",
  /** A catalog lookup or selection named a Tool ref this Toolbox does not contain. */
  "TOOLBOX_TOOL_NOT_FOUND",
  /** A catalog query, filter, or selection is malformed or out of bounds. */
  "TOOLBOX_QUERY_INVALID",
] as const;
export type ToolboxErrorCode = (typeof TOOLBOX_ERROR_CODES)[number];

/** A bounded Toolbox definition or catalog error. It never carries handler source, Tool input, or Tool output. */
export class ToolboxError extends Error {
  readonly code: ToolboxErrorCode;
  readonly issues: readonly string[];

  constructor(code: ToolboxErrorCode, message: string, issues: readonly string[] = []) {
    super(`${code}: ${message}`);
    this.name = "ToolboxError";
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}
