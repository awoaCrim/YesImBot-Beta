import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const actionSchema = z.object({
  key: z.string(),
  kind: z.enum(["post", "interaction"]),
  day: z.string(),
  at: z.number(),
  status: z.enum(["pending", "sent", "uncertain"]),
  target: z.string(),
  id: z.string().optional(),
});
const watchSchema = z.object({
  seen: z.array(z.string()),
  ownCommentIds: z.array(z.string()),
  ownPost: z.boolean(),
  touchedAt: z.number(),
});
const activitySchema = z
  .object({
    id: z.string().transform((value) => value.slice(0, 80)),
    at: z.number().finite().nonnegative(),
    kind: z.string().transform((value) => value.slice(0, 48)),
    outcome: z.enum(["ok", "failed", "blocked"]),
    postId: z
      .string()
      .transform((value) => value.slice(0, 80))
      .optional(),
    title: z
      .string()
      .transform((value) => value.slice(0, 200))
      .optional(),
    source: z
      .string()
      .transform((value) => value.slice(0, 200))
      .optional(),
    count: z.number().int().nonnegative().optional(),
    errorCode: z
      .string()
      .transform((value) => value.slice(0, 80))
      .optional(),
  })
  .strip();
const stateSchema = z.object({
  version: z.literal(1),
  accountId: z.string(),
  paused: z.string().nullable(),
  actions: z.array(actionSchema),
  activities: z
    .array(activitySchema)
    .default([])
    .transform((items) => items.slice(-300)),
  watched: z.record(watchSchema),
  pendingVisits: z.array(z.string()),
  lastBrowseAt: z.number(),
});
export type AccountState = z.infer<typeof stateSchema>;
export type Activity = z.infer<typeof activitySchema>;

export type ActionKind = "post" | "interaction";

export class AccountStore {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private failed = false;
  private constructor(
    private readonly dir: string,
    private readonly lock: FileHandle,
    private state: AccountState,
  ) {}

  static async open(dir: string, accountId: string): Promise<AccountStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = await open(join(dir, "owner.lock"), "wx", 0o600);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      let state: AccountState;
      try {
        state = stateSchema.parse(JSON.parse(await readFile(join(dir, "state.json"), "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid_account_state");
        state = { version: 1, accountId, paused: null, actions: [], activities: [], watched: {}, pendingVisits: [], lastBrowseAt: 0 };
      }
      if (state.accountId !== accountId) throw new Error("account_state_mismatch");
      if (state.actions.some((action) => action.status === "pending")) {
        state.paused = "uncertain_delivery";
        for (const action of state.actions) if (action.status === "pending") action.status = "uncertain";
        state.activities.push({ id: randomUUID(), at: Date.now(), kind: "pause", outcome: "ok", errorCode: "uncertain_delivery" });
      }
      const store = new AccountStore(dir, lock, state);
      await store.update(() => {});
      return store;
    } catch (error) {
      await lock.close();
      await unlink(join(dir, "owner.lock"));
      throw error;
    }
  }

  snapshot(): AccountState {
    return { ...structuredClone(this.state), ...(this.failed ? { paused: "state_write_failed" } : {}) };
  }

  update(change: (state: AccountState) => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error("account_store_closed"));
    const next = this.tail.then(async () => {
      if (this.failed) throw new Error("account_state_write_failed");
      const state = this.snapshot();
      change(state);
      state.activities = state.activities.slice(-300).map((activity) => activitySchema.parse(activity));
      const temporary = join(this.dir, `state-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(state));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, join(this.dir, "state.json"));
        const directory = await open(this.dir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        this.state = state;
      } catch {
        this.failed = true;
        await unlink(temporary).catch(() => {});
        throw new Error("account_state_write_failed");
      }
    });
    this.tail = next.catch(() => {});
    return next;
  }

  recordActivity(activity: Omit<Activity, "id" | "at">, now = Date.now()): Promise<void> {
    const entry = activitySchema.parse({ ...activity, id: randomUUID(), at: now });
    return this.update((state) => {
      state.activities.push(entry);
    });
  }

  reserve(key: string, kind: ActionKind, limit: number, now: number, target = ""): Promise<void> {
    return this.update((state) => {
      if (state.paused) throw new Error("account_paused");
      if (state.actions.some((action) => action.key === key)) throw new Error("duplicate_action");
      const day = dayKey(now);
      if (state.actions.filter((action) => action.day === day && action.kind === kind).length >= limit) throw new Error("daily_limit");
      state.actions = [...state.actions.filter((action) => action.day !== day).slice(-2000), ...state.actions.filter((action) => action.day === day)];
      state.actions.push({ key, kind, day, at: now, status: "pending", target });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.lock.close();
    await unlink(join(this.dir, "owner.lock"));
  }
}

export function dayKey(now: number): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
