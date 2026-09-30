import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "koishi";

const FILE_VERSION = 1 as const;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface WillingnessAuthorState {
  confirmedScore: number;
  lastMessageAt: number | null;
  lastDecayAt: number | null;
}

export interface WillingnessReservation {
  id: string;
  authorId: string;
  amount: number;
  createdAt: number;
  sourceEventIds: string[];
}

export interface WillingnessBotState {
  authors: Record<string, WillingnessAuthorState>;
  reservations: Record<string, WillingnessReservation>;
}

export interface WillingnessFileV1 {
  version: 1;
  updatedAt: number;
  bots: Record<string, WillingnessBotState>;
}

export interface WillingnessStore {
  init(): Promise<void>;
  readBot(selfId: string): WillingnessBotState;
  mutateBot<T>(selfId: string, mutate: (bot: WillingnessBotState) => T): Promise<T>;
}

export interface WillingnessStoreFileOps {
  mkdir(path: string): Promise<unknown>;
  readFile(path: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

const DEFAULT_FILE_OPS: WillingnessStoreFileOps = {
  mkdir: (path) => mkdir(path, { recursive: true }),
  readFile: (path) => readFile(path, "utf8"),
  rename,
  rm: (path) => rm(path, { force: true }),
  writeFile: (path, content) => writeFile(path, content, { encoding: "utf8", flag: "wx" }),
};

export function createMemoryWillingnessStore(): WillingnessStore {
  return createStore(undefined, undefined, DEFAULT_FILE_OPS);
}

export function createDurableWillingnessStore(
  filePath: string,
  logger: Pick<Logger, "warn">,
  fileOps: WillingnessStoreFileOps = DEFAULT_FILE_OPS,
): WillingnessStore {
  return createStore(filePath, logger, fileOps);
}

function createStore(filePath: string | undefined, logger: Pick<Logger, "warn"> | undefined, fileOps: WillingnessStoreFileOps): WillingnessStore {
  let snapshot = emptyFile();
  let tail: Promise<void> = Promise.resolve();
  let initTask: Promise<void> | undefined;
  let warned = false;

  const warnOnce = (cause: unknown) => {
    if (warned) return;
    warned = true;
    logger?.warn("will_policy.willingness_store_invalid", {
      path: filePath,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  };

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const init = (): Promise<void> => {
    if (initTask) return initTask;
    initTask = serialize(async () => {
      if (!filePath) return;
      try {
        snapshot = parseFile(await fileOps.readFile(filePath));
      } catch (cause) {
        if (isMissingFile(cause)) {
          snapshot = emptyFile();
          return;
        }
        snapshot = emptyFile();
        warnOnce(cause);
      }
    });
    return initTask;
  };

  return {
    init,
    readBot(selfId) {
      assertSafeIdentifier(selfId, "selfId");
      return cloneBot(snapshot.bots[selfId] ?? emptyBot());
    },
    async mutateBot(selfId, mutate) {
      assertSafeIdentifier(selfId, "selfId");
      await init();
      return serialize(async () => {
        const next = cloneFile(snapshot);
        const bot = cloneBot(next.bots[selfId] ?? emptyBot());
        const result = mutate(bot);
        next.bots[selfId] = bot;
        next.updatedAt = Date.now();
        validateFile(next);
        if (filePath) await publish(filePath, next, fileOps);
        snapshot = next;
        return result;
      });
    },
  };
}

async function publish(filePath: string, snapshot: WillingnessFileV1, fileOps: WillingnessStoreFileOps): Promise<void> {
  await fileOps.mkdir(dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fileOps.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
    await fileOps.rename(temporary, filePath);
  } finally {
    await fileOps.rm(temporary).catch(() => undefined);
  }
}

function parseFile(content: string): WillingnessFileV1 {
  const value = JSON.parse(content) as unknown;
  validateFile(value);
  return cloneFile(value);
}

function validateFile(value: unknown): asserts value is WillingnessFileV1 {
  if (!isRecord(value) || value.version !== FILE_VERSION || !isTimestamp(value.updatedAt) || !isRecord(value.bots)) {
    throw new Error("Invalid willingness state file header");
  }
  for (const [selfId, rawBot] of Object.entries(value.bots)) {
    assertSafeIdentifier(selfId, "selfId");
    if (!isRecord(rawBot) || !isRecord(rawBot.authors) || !isRecord(rawBot.reservations)) throw new Error("Invalid willingness bot state");
    for (const [authorId, rawAuthor] of Object.entries(rawBot.authors)) {
      assertSafeIdentifier(authorId, "authorId");
      if (!isAuthorState(rawAuthor)) throw new Error("Invalid willingness author state");
    }
    const reservedAuthors = new Set<string>();
    for (const [reservationId, rawReservation] of Object.entries(rawBot.reservations)) {
      assertSafeIdentifier(reservationId, "reservationId");
      if (
        !isRecord(rawReservation) ||
        rawReservation.id !== reservationId ||
        typeof rawReservation.authorId !== "string" ||
        !isScore(rawReservation.amount) ||
        !isTimestamp(rawReservation.createdAt) ||
        !Array.isArray(rawReservation.sourceEventIds) ||
        rawReservation.sourceEventIds.length === 0 ||
        rawReservation.sourceEventIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw new Error("Invalid willingness reservation state");
      }
      assertSafeIdentifier(rawReservation.authorId, "reservation authorId");
      if (!Object.hasOwn(rawBot.authors, rawReservation.authorId) || reservedAuthors.has(rawReservation.authorId)) {
        throw new Error("Invalid willingness reservation ownership");
      }
      reservedAuthors.add(rawReservation.authorId);
    }
  }
}

function emptyFile(): WillingnessFileV1 {
  return { version: FILE_VERSION, updatedAt: 0, bots: {} };
}

function emptyBot(): WillingnessBotState {
  return { authors: {}, reservations: {} };
}

function cloneFile(value: WillingnessFileV1): WillingnessFileV1 {
  return {
    version: FILE_VERSION,
    updatedAt: value.updatedAt,
    bots: Object.fromEntries(Object.entries(value.bots).map(([selfId, bot]) => [selfId, cloneBot(bot)])),
  };
}

function cloneBot(value: WillingnessBotState): WillingnessBotState {
  return {
    authors: Object.fromEntries(Object.entries(value.authors).map(([authorId, author]) => [authorId, { ...author }])),
    reservations: Object.fromEntries(
      Object.entries(value.reservations).map(([reservationId, reservation]) => [
        reservationId,
        { ...reservation, sourceEventIds: [...reservation.sourceEventIds] },
      ]),
    ),
  };
}

function assertSafeIdentifier(value: string, field: string): void {
  if (value.length === 0 || UNSAFE_KEYS.has(value)) throw new Error(`Invalid ${field}`);
}

function isAuthorState(value: unknown): value is WillingnessAuthorState {
  if (!isRecord(value) || !isScore(value.confirmedScore) || !isNullableTimestamp(value.lastMessageAt) || !isNullableTimestamp(value.lastDecayAt)) {
    return false;
  }
  if ((value.lastMessageAt === null) !== (value.lastDecayAt === null)) return false;
  return value.lastMessageAt === null || value.lastDecayAt! >= value.lastMessageAt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(cause: unknown): boolean {
  return isRecord(cause) && cause.code === "ENOENT";
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}
