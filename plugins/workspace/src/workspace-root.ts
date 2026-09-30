import { resolve } from "node:path";

export function resolveSharedWorkspaceRoot(baseDir: string, sharedPath: string | undefined): string | undefined {
  const normalized = sharedPath?.trim();
  return normalized ? resolve(baseDir, normalized) : undefined;
}
