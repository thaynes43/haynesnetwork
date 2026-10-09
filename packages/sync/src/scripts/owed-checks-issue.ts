// GitHub Action adapter; no cluster access. Body files preserve the renderer's exact Markdown.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { reconcileOverdueIssue, type OverdueIssue } from '../owed-checks/issue';

const execute = promisify(execFile);
const bodyFile = process.argv[2];
const repository = process.env['GITHUB_REPOSITORY'];
if (!bodyFile || !repository) throw new Error('A report path and GITHUB_REPOSITORY are required');
const label = process.env['LABEL'] ?? 'owed-checks';
const gh = async (...args: string[]): Promise<string> => {
  const result = await execute('gh', [...args, '--repo', repository]);
  return result.stdout;
};
const markdown = await readFile(bodyFile, 'utf8');
await gh(
  'label',
  'create',
  label,
  '--color',
  'D93F0B',
  '--description',
  'Owed post-deploy checks past due (DESIGN-053)',
).catch(() => undefined); // Existing label is normal; issue API failures still abort below.
await reconcileOverdueIssue(markdown, {
  listOpen: async () =>
    JSON.parse(
      await gh(
        'issue',
        'list',
        '--label',
        label,
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'number,body',
      ),
    ) as OverdueIssue[],
  create: async () => {
    await gh(
      'issue',
      'create',
      '--title',
      'Owed checks overdue',
      '--label',
      label,
      '--body-file',
      bodyFile,
    );
  },
  edit: async (number) => {
    await gh('issue', 'edit', String(number), '--body-file', bodyFile);
  },
  comment: async (number, body) => {
    await gh('issue', 'comment', String(number), '--body', body);
  },
  close: async (number, comment) => {
    await gh('issue', 'close', String(number), '--comment', comment);
  },
});
