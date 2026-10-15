// Regenerates the committed Core Toolbox catalog from compiled output
// (run after `pnpm build`). The only inputs are the canonical Core Toolbox
// manifest and its actual Tool definitions, through describeToolbox. The
// drift test (test/generated-catalog.test.ts) fails if the committed files
// differ from what this writes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { renderToolboxCatalogJson, renderToolboxCatalogMarkdown } from '../dist/catalog-doc.js';
import { coreToolbox, describeToolbox } from '../dist/index.js';

const repositoryRoot = join(fileURLToPath(new URL('..', import.meta.url)), '..', '..');
const description = describeToolbox(coreToolbox);
writeFileSync(join(repositoryRoot, 'docs', 'generated', 'toolbox-core.json'), renderToolboxCatalogJson(description));
writeFileSync(join(repositoryRoot, 'docs', 'toolbox', 'core-tools.md'), renderToolboxCatalogMarkdown(description));
process.stdout.write(`wrote docs/generated/toolbox-core.json and docs/toolbox/core-tools.md (${description.tools.length} Tools, ${description.toolbox.fingerprint.slice(0, 12)})\n`);
