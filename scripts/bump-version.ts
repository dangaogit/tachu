#!/usr/bin/env bun
//
// Tachu monorepo version bumper.
//
// Bumps every workspace package (public + private) in lockstep to a new semver,
// following the conventional release types, and prepends a CHANGELOG entry.
// Interactive by default; fully scriptable via arguments for CI / publish.sh.
//
// Usage:
//   bun scripts/bump-version.ts                 # interactive menu
//   bun scripts/bump-version.ts prerelease      # rc.13 -> rc.14 (preid tail ++)
//   bun scripts/bump-version.ts patch|minor|major
//   bun scripts/bump-version.ts premajor|preminor|prepatch [--preid=rc]
//   bun scripts/bump-version.ts release         # drop prerelease (promote to stable)
//   bun scripts/bump-version.ts 1.2.3-rc.0      # explicit version
//
// Options:
//   --preid=<id>     prerelease identifier for pre* types (default: inherit current, else "rc")
//   --note="..."     one-line summary written under the new CHANGELOG entry
//   --no-changelog   do not touch CHANGELOG.md
//   --yes, -y        skip the confirmation prompt
//   --dry-run        compute and print the plan, write nothing
//   --json           print { from, to } as JSON on the final line
//   -h, --help       show this help
//
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every workspace that carries a version and must move in lockstep.
const WORKSPACE_PACKAGES = [
  "core",
  "extensions",
  "host-defaults",
  "cli",
  "web-fetch-server",
] as const;

const RELEASE_TYPES = [
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease",
  "release",
] as const;
type ReleaseType = (typeof RELEASE_TYPES)[number];

interface Semver {
  major: number;
  minor: number;
  patch: number;
  preid?: string;
  prenum?: number;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";

const fail = (message: string): never => {
  console.error(`${RED}✗ ${message}${RESET}`);
  process.exit(1);
};

const packageJsonPath = (pkg: string): string =>
  join(ROOT, "packages", pkg, "package.json");

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Parse `x.y.z` or `x.y.z-<preid>.<num>` (the only prerelease shape we bump). */
const parseSemver = (raw: string): Semver => {
  const match = raw
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/);
  if (!match) {
    return fail(
      `unsupported version "${raw}"; expected x.y.z or x.y.z-<preid>.<n> (e.g. 1.0.0-rc.13)`,
    );
  }
  const semver: Semver = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  if (match[4] !== undefined) {
    semver.preid = match[4];
    semver.prenum = Number(match[5]);
  }
  return semver;
};

const formatSemver = (v: Semver): string => {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.preid !== undefined ? `${core}-${v.preid}.${v.prenum ?? 0}` : core;
};

/** Compute the next version for a conventional release type. */
const computeNext = (
  current: Semver,
  type: ReleaseType,
  preidOverride?: string,
): string => {
  const preid = preidOverride ?? current.preid ?? "rc";
  switch (type) {
    case "major":
      return formatSemver({ major: current.major + 1, minor: 0, patch: 0 });
    case "minor":
      return formatSemver({ major: current.major, minor: current.minor + 1, patch: 0 });
    case "patch":
      // patch on a prerelease promotes to the stable it was staging.
      return current.preid !== undefined
        ? formatSemver({ major: current.major, minor: current.minor, patch: current.patch })
        : formatSemver({ major: current.major, minor: current.minor, patch: current.patch + 1 });
    case "release":
      if (current.preid === undefined) {
        return fail(`"release" only applies to a prerelease; ${formatSemver(current)} is already stable`);
      }
      return formatSemver({ major: current.major, minor: current.minor, patch: current.patch });
    case "premajor":
      return formatSemver({ major: current.major + 1, minor: 0, patch: 0, preid, prenum: 0 });
    case "preminor":
      return formatSemver({ major: current.major, minor: current.minor + 1, patch: 0, preid, prenum: 0 });
    case "prepatch":
      return formatSemver({ major: current.major, minor: current.minor, patch: current.patch + 1, preid, prenum: 0 });
    case "prerelease":
      // The headline case: on a prerelease, keep the base and ++ the tail
      // (rc.13 -> rc.14, alpha.5 -> alpha.6); on a stable, start a fresh pre.
      return current.preid !== undefined
        ? formatSemver({
            major: current.major,
            minor: current.minor,
            patch: current.patch,
            preid: preidOverride ?? current.preid,
            prenum: (current.prenum ?? 0) + 1,
          })
        : formatSemver({ major: current.major, minor: current.minor, patch: current.patch + 1, preid, prenum: 0 });
    default:
      return fail(`unknown release type "${type}"`);
  }
};

const isValidExplicitVersion = (value: string): boolean =>
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);

interface CliArgs {
  positional?: string;
  preid?: string;
  note?: string;
  noChangelog: boolean;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = { noChangelog: false, yes: false, dryRun: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--no-changelog") args.noChangelog = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg.startsWith("--preid=")) args.preid = arg.slice("--preid=".length);
    else if (arg.startsWith("--note=")) args.note = arg.slice("--note=".length);
    else if (arg.startsWith("-")) fail(`unknown option "${arg}" (see --help)`);
    else if (args.positional === undefined) args.positional = arg;
    else fail(`unexpected extra argument "${arg}"`);
  }
  return args;
};

const HELP = `Tachu version bumper

  bun scripts/bump-version.ts [type|version] [options]

Release types: ${RELEASE_TYPES.join(" | ")}
  prerelease  rc.N -> rc.N+1 / alpha.N -> alpha.N+1 (base fixed, tail ++)
  release     drop the prerelease suffix (promote to stable)

Options:
  --preid=<id>    prerelease id for pre* types (default: inherit current, else rc)
  --note="..."    one-line CHANGELOG summary
  --no-changelog  skip CHANGELOG.md
  --yes, -y       skip confirmation
  --dry-run       print the plan, write nothing
  --json          print { from, to } JSON on the last line
`;

/** Read all workspace versions and assert they are already in lockstep. */
const readCurrentVersion = (): string => {
  const versions = new Map<string, string>();
  for (const pkg of WORKSPACE_PACKAGES) {
    const json = JSON.parse(readFileSync(packageJsonPath(pkg), "utf8")) as { version?: string };
    if (!json.version) fail(`packages/${pkg}/package.json has no version`);
    versions.set(pkg, json.version as string);
  }
  const unique = new Set(versions.values());
  if (unique.size !== 1) {
    const detail = [...versions.entries()].map(([p, v]) => `  @tachu/${p}: ${v}`).join("\n");
    return fail(`workspace versions are out of lockstep; align them first:\n${detail}`);
  }
  return [...unique][0]!;
};

const writePackageVersion = (pkg: string, from: string, to: string): void => {
  const path = packageJsonPath(pkg);
  const text = readFileSync(path, "utf8");
  const pattern = new RegExp(`("version":\\s*")${escapeRegExp(from)}(")`);
  if (!pattern.test(text)) {
    fail(`could not find version "${from}" in packages/${pkg}/package.json`);
  }
  writeFileSync(path, text.replace(pattern, `$1${to}$2`));
};

const updateChangelog = (to: string, note: string | undefined): boolean => {
  const path = join(ROOT, "CHANGELOG.md");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const date = new Date().toISOString().slice(0, 10);
  const body = note && note.trim().length > 0 ? note.trim() : "_TODO: summarize the changes in this release._";
  const entry = `## [${to}] - ${date}\n\n${body}\n\n`;
  const anchor = text.search(/^## \[/m);
  const next =
    anchor >= 0
      ? text.slice(0, anchor) + entry + text.slice(anchor)
      : `${text.trimEnd()}\n\n${entry}`;
  writeFileSync(path, next);
  return true;
};

const promptMenu = async (current: Semver, preidOverride?: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const rows = RELEASE_TYPES.filter((type) => !(type === "release" && current.preid === undefined)).map(
      (type) => ({ type, next: computeNext(current, type, preidOverride) }),
    );
    console.log(`\n${BOLD}Current version:${RESET} ${CYAN}${formatSemver(current)}${RESET}\n`);
    rows.forEach((row, index) => {
      const label = row.type.padEnd(11);
      console.log(`  ${BOLD}${index + 1}${RESET}) ${label} → ${GREEN}${row.next}${RESET}`);
    });
    const customIndex = rows.length + 1;
    console.log(`  ${BOLD}${customIndex}${RESET}) ${"custom".padEnd(11)} → enter an exact version`);
    console.log(`  ${BOLD}0${RESET}) cancel\n`);

    const answer = (await rl.question(`Select [1]: `)).trim() || "1";
    if (answer === "0") fail("cancelled");
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= rows.length) {
      return rows[choice - 1]!.next;
    }
    if (choice === customIndex) {
      const custom = (await rl.question("Exact version: ")).trim();
      if (!isValidExplicitVersion(custom)) fail(`invalid version "${custom}"`);
      return custom;
    }
    return fail(`invalid selection "${answer}"`);
  } finally {
    rl.close();
  }
};

const confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const from = readCurrentVersion();
  const current = parseSemver(from);

  let to: string;
  if (args.positional === undefined) {
    if (!process.stdin.isTTY) {
      fail("no release type given and stdin is not a TTY; pass a type/version (see --help)");
    }
    to = await promptMenu(current, args.preid);
  } else if ((RELEASE_TYPES as readonly string[]).includes(args.positional)) {
    to = computeNext(current, args.positional as ReleaseType, args.preid);
  } else if (isValidExplicitVersion(args.positional)) {
    to = args.positional;
  } else {
    return fail(`"${args.positional}" is neither a release type (${RELEASE_TYPES.join(", ")}) nor a valid version`);
  }

  if (to === from) fail(`new version equals current version (${from}); nothing to bump`);

  console.log(`\n${BOLD}Bump:${RESET} ${CYAN}${from}${RESET} → ${GREEN}${to}${RESET}`);
  console.log(`  packages: ${WORKSPACE_PACKAGES.map((p) => `@tachu/${p}`).join(", ")}`);
  console.log(`  changelog: ${args.noChangelog ? "skipped" : "CHANGELOG.md entry"}`);

  if (args.dryRun) {
    console.log(`${YELLOW}⚠ dry-run: no files written${RESET}`);
    if (args.json) console.log(JSON.stringify({ from, to, dryRun: true }));
    return;
  }

  const interactive = args.positional === undefined && process.stdin.isTTY;
  if (!args.yes && interactive) {
    const proceed = await confirm(`Apply bump ${from} → ${to}?`);
    if (!proceed) fail("cancelled");
  }

  for (const pkg of WORKSPACE_PACKAGES) {
    writePackageVersion(pkg, from, to);
  }
  console.log(`${GREEN}✓${RESET} wrote version ${to} to ${WORKSPACE_PACKAGES.length} package.json files`);

  if (!args.noChangelog) {
    const note = args.note ?? (interactive ? (await promptChangelogNote()) : undefined);
    const wrote = updateChangelog(to, note);
    console.log(
      wrote
        ? `${GREEN}✓${RESET} prepended CHANGELOG.md entry for ${to}`
        : `${YELLOW}⚠${RESET} CHANGELOG.md not found; skipped`,
    );
  }

  if (args.json) console.log(JSON.stringify({ from, to }));
};

const promptChangelogNote = async (): Promise<string | undefined> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const note = (await rl.question("CHANGELOG summary (one line, blank to fill later): ")).trim();
    return note.length > 0 ? note : undefined;
  } finally {
    rl.close();
  }
};

await main();
