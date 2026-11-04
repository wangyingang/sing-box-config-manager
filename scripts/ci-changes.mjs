import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

// Default to full checks unless a complete diff proves every changed path is Markdown.
function detect() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    return { runTests: true, reason: 'Manual run' };
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let base, head, comparison;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
    comparison = '...';
  } else if (process.env.GITHUB_EVENT_NAME === 'push') {
    base = event.before;
    head = event.after;
    comparison = '..';
  } else {
    return { runTests: true, reason: 'Unsupported event' };
  }
  for (const sha of [base, head]) {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha)) {
      throw new Error('Missing or invalid comparison commit');
    }
  }
  // Disabling rename detection includes BOTH old and new paths (e.g. code.js -> notes.md).
  // NUL delimiters preserve filenames containing spaces, tabs or newlines.
  const diff = execFileSync('git', ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z',
    `${base}${comparison}${head}`, '--'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const paths = diff.split('\0').filter(Boolean);
  const docsOnly = paths.length > 0 && paths.every(path => path.endsWith('.md'));
  return { runTests: !docsOnly, reason: docsOnly ? 'Only Markdown changed' : 'Non-Markdown or empty diff',
    changedPaths: paths.length };
}

let decision;
try {
  decision = detect();
} catch {
  decision = { runTests: true, reason: 'Change detection failed; running full checks' };
}
console.log(JSON.stringify(decision));
appendFileSync(process.env.GITHUB_OUTPUT, `run_tests=${decision.runTests}\n`);
