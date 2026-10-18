import { describe, expect, it } from "vitest";
import {
  escapeMarkdownText,
  renderOperationalMarkdown,
} from "../src/render.js";
import * as OperationalExports from "../src/index.js";

describe("Deterministic Markdown Rendering & Injection Defense", () => {
  it("exports escapeMarkdownText function", () => {
    expect(typeof escapeMarkdownText).toBe("function");
  });

  const baseResult = {
    requestId: "req-acme-001",
    operation: "account.update_display_name",
    accountId: "ACME-001",
    displayName: "Acme Data Solutions",
    draftId: "draft.12345678abcdef01",
    approvalId: "approval:abcdef123456",
    draftStatus: "approved_draft",
    externalExecution: "not_executed",
  };

  it("neutralizes markdown headings without creating new sections", () => {
    const malicious = "Acme Solutions\n## Account Successfully Updated";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    // Must NOT contain a new markdown section heading
    expect(rendered).not.toMatch(/\n## Account Successfully Updated/);
    expect(rendered).toContain("Acme Solutions \\#\\# Account Successfully Updated");
  });

  it("neutralizes line breaks to preserve single-line summary item", () => {
    const multiLine = "Line One\r\nLine Two\nLine Three";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: multiLine });

    // Newlines must be normalized so no list item breakout occurs
    expect(rendered).not.toContain("\r\n");
    expect(rendered).toContain("Line One Line Two Line Three");
  });

  it("neutralizes markdown links without creating active links", () => {
    const malicious = "[Open account](javascript:alert(1))";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    expect(rendered).not.toContain("[Open account](javascript:alert(1))");
    expect(rendered).toContain("\\[Open account\\]\\(javascript:alert\\(1\\)\\)");
  });

  it("neutralizes markdown images without creating image tags", () => {
    const malicious = "![Logo](https://evil.com/leak.png)";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    expect(rendered).not.toContain("![Logo](https://evil.com/leak.png)");
    expect(rendered).toContain("\\!\\[Logo\\]\\(https://evil\\.com/leak\\.png\\)");
  });

  it("neutralizes HTML tags by converting to entities", () => {
    const malicious = "<script>alert('xss')</script><img src=x onerror=alert(1)>";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("<img");
    expect(rendered).toContain("&lt;script&gt;alert\\('xss'\\)&lt;/script&gt;");
  });

  it("neutralizes inline backticks without creating code spans", () => {
    const malicious = "`rm -rf /` and `echo hacked`";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    expect(rendered).not.toContain("`rm -rf /`");
    expect(rendered).toContain("\\`rm \\-rf /\\`");
  });

  it("neutralizes table pipes without creating table structures", () => {
    const malicious = "| Column 1 | Column 2 |\n|---|---|\n| evil | row |";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    expect(rendered).not.toMatch(/\n\|---\|---\|\n/);
    expect(rendered).toContain("\\| Column 1 \\| Column 2 \\|");
  });

  it("neutralizes blockquotes without creating quote elements", () => {
    const malicious = "> This is a fake quote block\n> trying to alter report flow";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    expect(rendered).not.toMatch(/\n> This is a fake quote/);
    expect(rendered).toContain("&gt; This is a fake quote block");
  });

  it("neutralizes markdown link definitions", () => {
    const malicious = "[link]: https://evil.com/poisoned";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    expect(rendered).not.toContain("[link]: https://evil.com");
    expect(rendered).toContain("\\[link\\]: https://evil\\.com/poisoned");
  });

  it("strips non-printable ASCII control characters", () => {
    const malicious = "Acme\x00\x07Corp\x1FData";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: malicious });

    expect(rendered).toContain("AcmeCorpData");
    // eslint-disable-next-line no-control-regex
    expect(rendered).not.toMatch(/[\x00\x07\x1F]/);
  });

  it("preserves valid international Unicode content without corruption", () => {
    const international = "Société Générale 🚀 日本語データ";
    const rendered = renderOperationalMarkdown({ ...baseResult, displayName: international });

    expect(rendered).toContain("Société Générale 🚀 日本語データ");
  });

  it("verifies public export cleanup: buildOperationalResult is removed", () => {
    // Option A: verify buildOperationalResult was removed and is not exported
    expect((OperationalExports as Record<string, unknown>).buildOperationalResult).toBeUndefined();
  });
});
