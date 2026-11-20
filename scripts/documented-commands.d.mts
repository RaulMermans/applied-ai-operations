export const REQUIRED_SCRIPTS: string[];
export const REQUIRED_HELP_FRAGMENTS: string[];

export function readDocumentedCommands(root?: string): {
  scripts: string[];
  missing: string[];
  undocumented: string[];
};

export function assertDocumentedCommands(root?: string): {
  scripts: string[];
  missing: string[];
  undocumented: string[];
};
