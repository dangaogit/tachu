#!/usr/bin/env bun
/**
 * P7：聚合 release gate 执行结果为单一 JSON artifact。
 *
 * 用法：bun scripts/build-gate-report.ts [--out=<path>]
 *
 * 接受形如 `--gate=<name>:<status>:<duration_ms>:<evidence>` 的重复参数，
 * 或从 stdin 读取换行分隔的同格式行。输出 `GateReport.json` 到 `--out`
 * 路径（默认 `gate-report.json`），供 GitHub workflow artifact 上传。
 */
import { writeFileSync } from "node:fs";

type GateStatus = "pass" | "fail" | "skipped";

interface GateRecord {
  name: string;
  status: GateStatus;
  durationMs: number;
  evidence: string[];
}

interface GateReport {
  generatedAt: string;
  commitSha: string | undefined;
  refName: string | undefined;
  gates: GateRecord[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    ok: boolean;
  };
}

function parseGateArg(value: string): GateRecord {
 // format: name:status:duration_ms[:evidence...]
  const parts = value.split(":");
  if (parts.length < 3) {
    throw new Error(`invalid --gate value (expected name:status:durationMs[:evidence...]): ${value}`);
  }
  const [name, statusRaw, durationRaw, ...evidence] = parts;
  if (!name) throw new Error(`invalid --gate value: empty name`);
  const status = statusRaw as GateStatus;
  if (!["pass", "fail", "skipped"].includes(status)) {
    throw new Error(`invalid status '${statusRaw}' for gate '${name}'`);
  }
  const durationMs = Number(durationRaw);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`invalid duration '${durationRaw}' for gate '${name}'`);
  }
  return { name, status, durationMs, evidence };
}

async function readStdinIfPiped(): Promise<string[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

async function main(argv: string[]): Promise<number> {
  let out = "gate-report.json";
  const gateInputs: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg.startsWith("--gate=")) {
      gateInputs.push(arg.slice("--gate=".length));
    } else if (arg === "--help") {
      console.log(
        "usage: build-gate-report.ts [--out=path] [--gate=name:status:durationMs[:evidence]]...",
      );
      return 0;
    } else {
      console.error(`[gate-report] unknown argument: ${arg}`);
      return 2;
    }
  }

  const stdinLines = await readStdinIfPiped();
  const all = [...gateInputs, ...stdinLines];
  const gates: GateRecord[] = [];
  for (const raw of all) {
    gates.push(parseGateArg(raw));
  }

  const passed = gates.filter((g) => g.status === "pass").length;
  const failed = gates.filter((g) => g.status === "fail").length;
  const skipped = gates.filter((g) => g.status === "skipped").length;

  const report: GateReport = {
    generatedAt: new Date().toISOString(),
    commitSha: process.env.GITHUB_SHA,
    refName: process.env.GITHUB_REF_NAME,
    gates,
    summary: {
      total: gates.length,
      passed,
      failed,
      skipped,
      ok: failed === 0,
    },
  };

  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    `[gate-report] wrote ${out} (gates=${gates.length} pass=${passed} fail=${failed} skipped=${skipped})`,
  );
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[gate-report] error:", err instanceof Error ? err.message : err);
      process.exit(2);
    });
}

export { main as buildGateReport };
export type { GateRecord, GateReport, GateStatus };
