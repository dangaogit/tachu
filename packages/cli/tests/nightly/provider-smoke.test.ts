import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/commands/run";

interface NightlyFixtures {
  providers: Record<string, { prompt: string }>;
  memoryBackends: string[];
}

const provider = process.env.TACHU_NIGHTLY_PROVIDER;
const memory = process.env.TACHU_NIGHTLY_MEMORY;
const run = provider && memory ? test : test.skip;

const fixturePath = join(import.meta.dir, "..", "fixtures", "nightly", "providers.json");

const configContent = `
const config = {
  models: {
    capabilityMapping: {
      "high-reasoning": { provider: "mock", model: "mock-chat" },
      "fast-cheap": { provider: "mock", model: "mock-chat" },
      "intent": { provider: "mock", model: "mock-chat" },
      "planning": { provider: "mock", model: "mock-chat" },
      "validation": { provider: "mock", model: "mock-chat" }
    },
    providerFallbackOrder: ["mock"]
  },
  memory: {
    persistence: "fs",
    persistDir: ".tachu/memory",
    archivePath: ".tachu/archive/nightly.jsonl"
  },
  observability: { enabled: false, maskSensitiveData: true }
};
export default config;
`;

run("CLI fixture replay smoke completes and persists memory", async () => {
  const fixtures = JSON.parse(await readFile(fixturePath, "utf8")) as NightlyFixtures;
  expect(Object.keys(fixtures.providers)).toContain(provider);
  expect(fixtures.memoryBackends).toContain(memory);

  const root = await mkdtemp(join(tmpdir(), "tachu-nightly-"));
  try {
    await mkdir(join(root, ".tachu", "sessions"), { recursive: true });
    await mkdir(join(root, ".tachu", "rules"), { recursive: true });
    await mkdir(join(root, ".tachu", "skills"), { recursive: true });
    await mkdir(join(root, ".tachu", "tools"), { recursive: true });
    await mkdir(join(root, ".tachu", "agents"), { recursive: true });
    await writeFile(join(root, "tachu.config.ts"), configContent, "utf8");

    const prompt = `${fixtures.providers[provider!]!.prompt} (${memory})`;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origCwd = process.cwd();
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    const prevInk = process.env.TACHU_INK;
    const prevSuppressMock = process.env.TACHU_SUPPRESS_MOCK_WARNING;
    process.chdir(root);
    process.env.TACHU_INK = "0";
    process.env.TACHU_SUPPRESS_MOCK_WARNING = "1";
    process.stdout.write = (chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    };
    try {
      await (runCommand as unknown as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
        args: {
          prompt,
          session: `nightly-${provider}-${memory}`,
          resume: false,
          model: "mock-chat",
          provider: "mock",
          "api-base": "",
          "api-key": "",
          organization: "",
          input: "",
          json: false,
          "text-to-image": false,
          "save-image": "",
          output: "json",
          "no-validation": true,
          "plan-mode": false,
          verbose: false,
          debug: false,
          "no-color": true,
          markdown: false,
          ink: false,
          timeout: "",
        },
      });
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
      process.chdir(origCwd);
      if (prevInk === undefined) delete process.env.TACHU_INK;
      else process.env.TACHU_INK = prevInk;
      if (prevSuppressMock === undefined) delete process.env.TACHU_SUPPRESS_MOCK_WARNING;
      else process.env.TACHU_SUPPRESS_MOCK_WARNING = prevSuppressMock;
    }

    expect(stderr.join("")).not.toContain("错误");
    expect(stdout.join("").length).toBeGreaterThan(0);
    expect(existsSync(join(root, ".tachu", "memory"))).toBe(true);
    const memoryFiles = await readdir(join(root, ".tachu", "memory"));
    expect(memoryFiles.some((file) => file.endsWith(".jsonl"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
