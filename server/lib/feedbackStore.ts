import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataPath } from './appPaths.js';
import {
  CodexFeedback,
  CodexFeedbackCreateRequest,
  CodexFeedbackStatus,
  FeedbackStoreState,
} from '../types.js';

const dataDir = dataPath();
const feedbackFile = dataPath('feedback.json');
let mutationQueue: Promise<unknown> = Promise.resolve();

async function ensureStore(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(feedbackFile);
  } catch {
    const initialState: FeedbackStoreState = { feedback: {} };
    await saveState(initialState);
  }
}

async function loadState(): Promise<FeedbackStoreState> {
  await ensureStore();
  const raw = await fs.readFile(feedbackFile, 'utf8');
  return JSON.parse(raw) as FeedbackStoreState;
}

async function saveState(state: FeedbackStoreState): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const tempFile = path.join(
    dataDir,
    `.${path.basename(feedbackFile)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(tempFile, JSON.stringify(state, null, 2));
  await fs.rename(tempFile, feedbackFile);
}

async function mutateState<T>(mutator: (state: FeedbackStoreState) => T | Promise<T>): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await saveState(state);
    return result;
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function createFeedback(request: CodexFeedbackCreateRequest): Promise<CodexFeedback> {
  return mutateState((state) => {
    const createdAt = nowIso();
    const feedback: CodexFeedback = {
      id: crypto.randomUUID(),
      paperId: request.paperId,
      versionId: request.versionId,
      targetBlockId: request.targetBlockId,
      selectedText: request.selectedText,
      sourceFile: request.sourceFile,
      sourceLine: request.sourceLine,
      sourceSnippet: request.sourceSnippet,
      issue: request.issue,
      changeRequest: request.changeRequest,
      source: request.source || 'texor-web',
      taskSpeedMode: request.taskSpeedMode,
      status: 'open',
      createdAt,
      updatedAt: createdAt,
    };

    state.feedback[feedback.id] = feedback;
    return feedback;
  });
}

export async function listFeedback(options: {
  paperId?: string;
  status?: CodexFeedbackStatus;
  after?: string;
  limit?: number;
} = {}): Promise<CodexFeedback[]> {
  const state = await loadState();
  const limit = Math.max(1, Math.min(options.limit || 50, 100));
  return Object.values(state.feedback)
    .filter((entry) => !options.paperId || entry.paperId === options.paperId)
    .filter((entry) => !options.status || entry.status === options.status)
    .filter((entry) => !options.after || entry.createdAt > options.after)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, limit);
}

export async function updateFeedbackStatus(
  feedbackId: string,
  status: CodexFeedbackStatus,
): Promise<CodexFeedback | null> {
  return mutateState((state) => {
    const feedback = state.feedback[feedbackId];
    if (!feedback) {
      return null;
    }

    const updated: CodexFeedback = {
      ...feedback,
      status,
      updatedAt: nowIso(),
    };
    state.feedback[feedbackId] = updated;
    return updated;
  });
}

export async function deleteFeedbackForPapers(paperIds: string[]): Promise<number> {
  const paperIdSet = new Set(paperIds);
  return mutateState((state) => {
    let deleted = 0;
    for (const [feedbackId, feedback] of Object.entries(state.feedback)) {
      if (paperIdSet.has(feedback.paperId)) {
        delete state.feedback[feedbackId];
        deleted += 1;
      }
    }
    return deleted;
  });
}
