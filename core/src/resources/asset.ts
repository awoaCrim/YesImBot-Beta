import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const COMPLETE_ID = /^[a-f0-9]{32}$/;
const PREFIX_ID = /^[a-f0-9]{7,31}$/;

/** Additive bounded-read options; one-argument consumers keep the original unbounded behavior. */
export interface AssetReadOptions {
  /** Checked before allocation and again against the observed byte length. */
  readonly maxBytes?: number;
  /** Lets the owning resource layer cancel a pending read. */
  readonly signal?: AbortSignal;
}

export interface AssetStore {
  put(data: Uint8Array): Promise<string>;
  get(idOrPrefix: string, options?: AssetReadOptions): Promise<Uint8Array>;
  clear(): Promise<void>;
}

export class ChannelAssetStore implements AssetStore {
  public constructor(private readonly root: string) {}

  public async put(data: Uint8Array): Promise<string> {
    if (!(data instanceof Uint8Array)) throw new Error("Asset data must be bytes");
    const copied = data.slice();
    const id = createHash("sha256").update(copied).digest("hex").slice(0, 32);
    const path = this.path(id);
    const temporary = join(dirname(path), `.${id}.${randomUUID()}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporary, copied, { flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return id;
  }

  /** Optional bounds are checked before allocation and again against the observed length. */
  public async get(idOrPrefix: string, options: AssetReadOptions = {}): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    let id = idOrPrefix;
    if (!COMPLETE_ID.test(id)) {
      if (!PREFIX_ID.test(idOrPrefix)) throw new Error("Invalid asset id");
      let candidates: string[];
      try {
        candidates = (await readdir(this.path())).filter((name) => COMPLETE_ID.test(name) && name.startsWith(idOrPrefix));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") candidates = [];
        else throw cause;
      }
      if (candidates.length === 0) throw new Error("Asset not found");
      if (candidates.length > 1) throw new Error("Asset prefix is ambiguous");
      id = candidates[0]!;
    }
    const path = this.path(id);
    if (options.maxBytes !== undefined) {
      const entry = await stat(path);
      if (entry.size > options.maxBytes) throw new Error("Resource exceeds byte limit");
    }
    options.signal?.throwIfAborted();
    const data = new Uint8Array(await readFile(path, options.signal ? { signal: options.signal } : undefined));
    options.signal?.throwIfAborted();
    if (options.maxBytes !== undefined && data.byteLength > options.maxBytes) throw new Error("Resource exceeds byte limit");
    return data;
  }

  public async clear(): Promise<void> {
    await rm(this.path(), { recursive: true, force: true });
  }

  private path(id?: string): string {
    const directory = join(this.root, "assets");
    return id === undefined ? directory : join(directory, id);
  }
}
