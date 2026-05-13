import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitCommit, GitContext } from '../types.js';

const execFileAsync = promisify(execFile);

async function runGit(rootPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', rootPath, ...args], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export async function readGitContext(rootPath: string): Promise<GitContext> {
  try {
    const insideRepo = await runGit(rootPath, ['rev-parse', '--is-inside-work-tree']);
    if (insideRepo !== 'true') {
      return { isRepo: false, commits: [] };
    }

    const [branch, head, rawLog] = await Promise.all([
      runGit(rootPath, ['branch', '--show-current']),
      runGit(rootPath, ['rev-parse', '--short', 'HEAD']),
      runGit(rootPath, ['log', '-5', '--pretty=format:%h|%ad|%s', '--date=short']),
    ]);

    const commits: GitCommit[] = rawLog
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, date, subject] = line.split('|');
        return { hash, date, subject };
      });

    return {
      isRepo: true,
      branch,
      head,
      commits,
    };
  } catch {
    return { isRepo: false, commits: [] };
  }
}

