import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { matchesRecord } from "./approval-matcher";

export type ApprovalMatchKind =
  | { kind: "any" }
  | { kind: "argPattern"; field: string; pattern: string }
  | { kind: "shellCommand"; pattern: string };

export interface ApprovalRecord {
  id: string;
  scope: "project" | "user";
  tool: string;
  match: ApprovalMatchKind;
  expiresAt?: number;
  sessionId?: string;
  createdAt: number;
  note?: string;
}

const projectStorePath = (cwd: string): string =>
  join(cwd, ".tachu", "approvals.jsonl");

const defaultUserStoreDir = (): string => join(homedir(), ".tachu");

const userStorePath = (userStoreDir?: string): string =>
  join(userStoreDir ?? defaultUserStoreDir(), "approvals.jsonl");

const ensureDir = async (filePath: string): Promise<void> => {
  const dir = join(filePath, "..");
  await mkdir(dir, { recursive: true });
};

const readRecords = async (filePath: string): Promise<ApprovalRecord[]> => {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const records: ApprovalRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ApprovalRecord;
      if (parsed && typeof parsed.id === "string" && typeof parsed.tool === "string") {
        records.push(parsed);
      }
    } catch {
 // skip malformed lines
    }
  }
  return records;
};

const writeRecords = async (filePath: string, records: ApprovalRecord[]): Promise<void> => {
  await ensureDir(filePath);
  const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  await writeFile(filePath, content, "utf8");
};

export class ApprovalStore {
  private readonly userStoreDir: string | undefined;
  constructor(private readonly cwd: string, options?: { userStoreDir?: string }) {
    this.userStoreDir = options?.userStoreDir;
  }

  async append(record: ApprovalRecord): Promise<void> {
    const filePath = projectStorePath(this.cwd);
    await ensureDir(filePath);
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  }

  async appendUser(record: ApprovalRecord): Promise<void> {
    const filePath = userStorePath(this.userStoreDir);
    await ensureDir(filePath);
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  }

  async find(
    tool: string,
    args: Record<string, unknown>,
    currentSessionId?: string,
  ): Promise<ApprovalRecord | null> {
    const [projectRecords, userRecords] = await Promise.all([
      readRecords(projectStorePath(this.cwd)),
      readRecords(userStorePath(this.userStoreDir)),
    ]);
    const all = [...projectRecords, ...userRecords];
    for (const record of all) {
      if (matchesRecord(record, tool, args, currentSessionId)) {
        return record;
      }
    }
    return null;
  }

  async list(): Promise<ApprovalRecord[]> {
    const [projectRecords, userRecords] = await Promise.all([
      readRecords(projectStorePath(this.cwd)),
      readRecords(userStorePath(this.userStoreDir)),
    ]);
    const seen = new Set<string>();
    const result: ApprovalRecord[] = [];
    for (const r of [...projectRecords, ...userRecords]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        result.push(r);
      }
    }
    return result;
  }

  async revoke(id: string): Promise<boolean> {
    let found = false;

    const projectPath = projectStorePath(this.cwd);
    const projectRecords = await readRecords(projectPath);
    const filteredProject = projectRecords.filter((r) => {
      if (r.id === id) {
        found = true;
        return false;
      }
      return true;
    });
    if (filteredProject.length !== projectRecords.length) {
      await writeRecords(projectPath, filteredProject);
    }

    const userPath = userStorePath(this.userStoreDir);
    const userRecords = await readRecords(userPath);
    const filteredUser = userRecords.filter((r) => {
      if (r.id === id) {
        found = true;
        return false;
      }
      return true;
    });
    if (filteredUser.length !== userRecords.length) {
      await writeRecords(userPath, filteredUser);
    }

    return found;
  }

  async clear(filter?: {
    scope?: "project" | "user";
    tool?: string;
    expiredOnly?: boolean;
  }): Promise<number> {
    const now = Date.now();
    let count = 0;

    const shouldRemove = (r: ApprovalRecord): boolean => {
      if (filter?.tool !== undefined && r.tool !== filter.tool) return false;
      if (filter?.expiredOnly === true) {
        if (r.expiresAt === undefined || r.expiresAt >= now) return false;
      }
      return true;
    };

    if (filter?.scope === undefined || filter.scope === "project") {
      const projectPath = projectStorePath(this.cwd);
      const projectRecords = await readRecords(projectPath);
      const filtered = projectRecords.filter((r) => {
        if (shouldRemove(r)) {
          count++;
          return false;
        }
        return true;
      });
      if (filtered.length !== projectRecords.length) {
        await writeRecords(projectPath, filtered);
      }
    }

    if (filter?.scope === undefined || filter.scope === "user") {
      const userPath = userStorePath(this.userStoreDir);
      const userRecords = await readRecords(userPath);
      const filtered = userRecords.filter((r) => {
        if (shouldRemove(r)) {
          count++;
          return false;
        }
        return true;
      });
      if (filtered.length !== userRecords.length) {
        await writeRecords(userPath, filtered);
      }
    }

    return count;
  }

  async promote(id: string): Promise<boolean> {
    const projectPath = projectStorePath(this.cwd);
    const projectRecords = await readRecords(projectPath);
    const idx = projectRecords.findIndex((r) => r.id === id);
    if (idx === -1) return false;

    const record = projectRecords[idx];
    if (!record) return false;

    const promoted: ApprovalRecord = { ...record, scope: "user" };
    await this.appendUser(promoted);

    const filtered = projectRecords.filter((r) => r.id !== id);
    await writeRecords(projectPath, filtered);

    return true;
  }
}

export { randomUUID };
