/**
 * Deterministically escapes dynamic text values for safe Markdown rendering.
 *
 * 1. Strips non-printable ASCII control characters.
 * 2. Normalizes line breaks to single spaces so dynamic text cannot break out of inline spans or create block elements.
 * 3. Escapes HTML-sensitive characters (&, <, >) to entities (&amp;, &lt;, &gt;).
 * 4. Escapes Markdown syntax characters (\, `, *, _, {, }, [, ], (, ), #, +, -, ., !, |, >, ~).
 * 5. Preserves valid Unicode content without corruption.
 */
export function escapeMarkdownText(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  // 1. Strip non-printable ASCII control characters
  // eslint-disable-next-line no-control-regex
  let text = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // 2. Normalize newlines to spaces
  text = text.replace(/\r\n|\r|\n/g, " ");

  // 3. Escape backslashes first
  text = text.replace(/\\/g, "\\\\");

  // 4. Escape HTML entities
  text = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 5. Escape Markdown formatting characters
  text = text.replace(/[`*_{}[\]()#+\-.!|~]/g, "\\$&");

  return text;
}

/**
 * Escapes values intended for inline code spans (`...`), preventing code span breakout and line breaks.
 */
export function escapeCodeSpan(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/`/g, "'");
}

export function renderOperationalMarkdown(result: {
  requestId: string;
  operation: string;
  accountId: string;
  displayName: string;
  draftId: string;
  approvalId: string;
  draftStatus: string;
  externalExecution: string;
}): string {
  const safeRequestId = escapeCodeSpan(result.requestId);
  const safeOperation = escapeCodeSpan(result.operation);
  const safeAccountId = escapeCodeSpan(result.accountId);
  const safeDisplayName = escapeMarkdownText(result.displayName);
  const safeDraftId = escapeCodeSpan(result.draftId);
  const safeApprovalId = escapeCodeSpan(result.approvalId);
  const safeDraftStatus = escapeCodeSpan(result.draftStatus);
  const safeExternalExecution = escapeCodeSpan(result.externalExecution);

  return [
    "# Operational Request Result: Governed Draft Execution",
    "",
    "## Summary",
    `- **Request ID:** \`${safeRequestId}\``,
    `- **Operation:** \`${safeOperation}\``,
    `- **Target Account:** \`${safeAccountId}\``,
    `- **Approved Display Name:** ${safeDisplayName}`,
    `- **Draft ID:** \`${safeDraftId}\``,
    `- **Approval Record:** \`${safeApprovalId}\``,
    `- **Draft Status:** \`${safeDraftStatus}\``,
    `- **External Execution:** \`${safeExternalExecution}\``,
    "",
    "> [!NOTE]",
    "> **The draft was prepared. The external account was not modified.**",
    "> Any future CRM, ERP or third-party mutation remains explicitly outside this governed draft boundary.",
    "",
  ].join("\n");
}
