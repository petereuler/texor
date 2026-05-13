import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataPath } from './appPaths.js';
import {
  BridgeCommand,
  BridgeCommandCreateRequest,
  BridgeCommandLogEntry,
  BridgeCommandStatus,
  BridgeCommandStoreState,
  BridgeCommandUpdateRequest,
} from '../types.js';

const dataDir = dataPath();
const bridgeFile = dataPath('bridge-commands.json');
const terminalCommandTtlMs = 24 * 60 * 60_000;
const runningCommandTtlMs = 10 * 60_000;
let mutationQueue: Promise<unknown> = Promise.resolve();

async function ensureStore(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(bridgeFile);
  } catch {
    const initialState: BridgeCommandStoreState = { commands: {} };
    await saveState(initialState);
  }
}

async function loadState(): Promise<BridgeCommandStoreState> {
  await ensureStore();
  const raw = await fs.readFile(bridgeFile, 'utf8');
  try {
    return JSON.parse(raw) as BridgeCommandStoreState;
  } catch {
    const backupFile = path.join(dataDir, `bridge-commands.corrupt-${Date.now()}.json`);
    await fs.writeFile(backupFile, raw);
    const initialState: BridgeCommandStoreState = { commands: {} };
    await saveState(initialState);
    return initialState;
  }
}

async function saveState(state: BridgeCommandStoreState): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const tempFile = path.join(dataDir, `.${path.basename(bridgeFile)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempFile, JSON.stringify(state, null, 2));
  await fs.rename(tempFile, bridgeFile);
}

async function mutateState<T>(mutator: (state: BridgeCommandStoreState) => T | Promise<T>): Promise<T> {
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

function createLog(stream: BridgeCommandLogEntry['stream'], message: string): BridgeCommandLogEntry {
  return {
    id: crypto.randomUUID(),
    time: nowIso(),
    stream,
    message,
  };
}

function normalizeLogs(command: BridgeCommand): BridgeCommandLogEntry[] {
  return Array.isArray(command.logs) ? command.logs : [];
}

function phaseForStatus(command: BridgeCommand): BridgeCommand['phase'] {
  if (command.phase) {
    return command.phase;
  }
  if (command.status === 'queued') {
    return 'queued';
  }
  if (command.status === 'running') {
    return 'working';
  }
  if (command.status === 'done') {
    return 'complete';
  }
  return 'failed';
}

function normalizeCommand(command: BridgeCommand): BridgeCommand {
  return {
    ...command,
    phase: phaseForStatus(command),
    message: command.message || (command.status === 'queued' ? '等待 VSCode 接收任务' : undefined),
    logs: normalizeLogs(command),
  };
}

function isTerminal(command: BridgeCommand): boolean {
  return command.status === 'done' || command.status === 'failed';
}

function isExpired(command: BridgeCommand): boolean {
  const idleMs = Date.now() - new Date(command.updatedAt).getTime();
  return (isTerminal(command) && idleMs > terminalCommandTtlMs) || (command.status === 'running' && idleMs > runningCommandTtlMs);
}

function pruneState(state: BridgeCommandStoreState): void {
  for (const [commandId, command] of Object.entries(state.commands)) {
    if (isExpired(command)) {
      delete state.commands[commandId];
    }
  }
}

export async function createBridgeCommand(request: BridgeCommandCreateRequest): Promise<BridgeCommand> {
  return mutateState((state) => {
    pruneState(state);
    const createdAt = nowIso();
    const command: BridgeCommand = {
      id: crypto.randomUUID(),
      type: request.type,
      payload: request.payload,
      status: 'queued',
      phase: 'queued',
      message: '等待 VSCode 接收任务',
      logs: [createLog('system', 'Queued by texor browser.')],
      createdAt,
      updatedAt: createdAt,
    };

    state.commands[command.id] = command;
    return command;
  });
}

export async function listBridgeCommands(options: {
  status?: BridgeCommandStatus;
  limit?: number;
  paperId?: string;
  projectPath?: string;
} = {}): Promise<BridgeCommand[]> {
  const state = await loadState();
  pruneState(state);
  await saveState(state);
  const limit = Math.max(1, Math.min(options.limit || 20, 100));
  const requestedProjectPath = options.projectPath ? path.resolve(options.projectPath) : undefined;
  const sorted = Object.values(state.commands)
    .filter((entry) => !options.status || entry.status === options.status)
    .filter((entry) => {
      if (!options.paperId && !requestedProjectPath) {
        return true;
      }
      const payload = entry.payload;
      const paperMatches = options.paperId && 'paperId' in payload && payload.paperId === options.paperId;
      const projectMatches =
        requestedProjectPath &&
        'projectPath' in payload &&
        payload.projectPath &&
        path.resolve(payload.projectPath) === requestedProjectPath;
      return Boolean(paperMatches || projectMatches);
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const commands = options.status ? sorted.slice(0, limit) : sorted.slice(-limit);
  return commands.map(normalizeCommand);
}

export async function readBridgeCommand(commandId: string): Promise<BridgeCommand | null> {
  const state = await loadState();
  const command = state.commands[commandId];
  return command ? normalizeCommand(command) : null;
}

export async function claimBridgeCommand(commandId: string): Promise<BridgeCommand | null> {
  return mutateState((state) => {
    pruneState(state);
    const command = state.commands[commandId];
    if (!command || command.status !== 'queued') {
      return null;
    }

    const updated: BridgeCommand = {
      ...normalizeCommand(command),
      status: 'running',
      phase: 'accepted',
      message: 'VSCode 已接收任务',
      logs: [...normalizeLogs(command), createLog('system', 'VSCode extension accepted the command.')].slice(-240),
      control: undefined,
      controlRequestedAt: undefined,
      updatedAt: nowIso(),
    };
    state.commands[commandId] = updated;
    return updated;
  });
}

export async function updateBridgeCommand(
  commandId: string,
  request: BridgeCommandUpdateRequest,
): Promise<BridgeCommand | null> {
  return mutateState((state) => {
    pruneState(state);
    const command = state.commands[commandId];
    if (!command) {
      return null;
    }

    const updated: BridgeCommand = {
      ...command,
      status: request.status ?? command.status,
      phase: request.phase ?? command.phase,
      message: request.message ?? command.message,
      sessionId: request.sessionId ?? command.sessionId,
      control: request.control === null ? undefined : request.control ?? command.control,
      controlRequestedAt: request.control ? nowIso() : request.control === null ? undefined : command.controlRequestedAt,
      logs: [...normalizeLogs(command), ...(request.logs || [])].slice(-240),
      result: request.result ?? command.result,
      error: request.error ?? command.error,
      updatedAt: nowIso(),
    };
    state.commands[commandId] = updated;
    return updated;
  });
}

export async function deleteBridgeCommandsForPapers(paperIds: string[], projectRoot?: string): Promise<number> {
  const paperIdSet = new Set(paperIds);
  const resolvedProjectRoot = projectRoot ? path.resolve(projectRoot) : undefined;
  return mutateState((state) => {
    let deleted = 0;
    for (const [commandId, command] of Object.entries(state.commands)) {
      const payload = command.payload;
      const paperMatches = 'paperId' in payload && payload.paperId && paperIdSet.has(payload.paperId);
      const projectMatches =
        resolvedProjectRoot &&
        'projectPath' in payload &&
        payload.projectPath &&
        path.resolve(payload.projectPath) === resolvedProjectRoot;
      if (paperMatches || projectMatches) {
        delete state.commands[commandId];
        deleted += 1;
      }
    }
    return deleted;
  });
}
