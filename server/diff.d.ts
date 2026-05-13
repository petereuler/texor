declare module 'diff' {
  export interface Change {
    added?: boolean;
    removed?: boolean;
    value: string;
    count?: number;
  }

  export function diffWordsWithSpace(oldText: string, newText: string): Change[];
}
