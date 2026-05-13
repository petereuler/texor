import path from 'node:path';

export const appRoot = path.resolve(process.env.TEXOR_APP_ROOT || process.cwd());
export const dataRoot = path.resolve(process.env.TEXOR_DATA_DIR || path.join(appRoot, '.texor-data'));

export function appPath(...segments: string[]): string {
  return path.join(appRoot, ...segments);
}

export function dataPath(...segments: string[]): string {
  return path.join(dataRoot, ...segments);
}
