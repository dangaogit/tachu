#!/usr/bin/env bun
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, normalize } from "node:path";

const PUBLIC_PACKAGES = ["core", "extensions", "host-defaults", "cli"] as const;
const PRIVATE_PACKAGES = ["web-fetch-server"] as const;
const MIRRORED_DOCS = ["README.md", "README_ZH.md", "CHANGELOG.md", "LICENSE"] as const;

export interface ReleaseArtifactValidationOptions {
  root?: string;
  requireBuiltArtifacts?: boolean;
  requireMirroredDocs?: boolean;
  checkDockerRuntime?: boolean;
}

export interface ReleaseArtifactValidationResult {
  ok: boolean;
  version?: string;
  errors: string[];
}

type JsonObject = Record<string, unknown>;

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function collectPathStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectPathStrings);
  const obj = asObject(value);
  if (!obj) return [];
  return Object.values(obj).flatMap(collectPathStrings);
}

function packagePath(root: string, pkg: string, file = "package.json"): string {
  return join(root, "packages", pkg, file);
}

function validateFileExists(errors: string[], root: string, path: string, label: string): void {
  if (!existsSync(join(root, path))) {
    errors.push(`${label} missing: ${path}`);
  }
}

function normalizePackageRelativePath(path: string): string {
  return normalize(path.replace(/^\.\//, ""));
}

function parseExactCatalogVersion(range: string | undefined): string | undefined {
  if (!range) return undefined;
  const match = range.trim().match(/^[~^]?(\d+\.\d+\.\d+)$/);
  return match?.[1];
}

function validatePublicPackage(
  root: string,
  pkg: (typeof PUBLIC_PACKAGES)[number],
  expectedVersion: string | undefined,
  opts: Required<Pick<ReleaseArtifactValidationOptions, "requireBuiltArtifacts" | "requireMirroredDocs">>,
  errors: string[],
): string | undefined {
  const pkgRoot = join(root, "packages", pkg);
  const jsonPath = join(pkgRoot, "package.json");
  const json = readJson(jsonPath);
  const name = asString(json.name) ?? `packages/${pkg}`;
  const version = asString(json.version);

  if (!version) errors.push(`${name} has no package version`);
  if (expectedVersion && version && version !== expectedVersion) {
    errors.push(`${name} version ${version} does not match lockstep ${expectedVersion}`);
  }
  if (json.private === true) errors.push(`${name} must not be private`);

  const publishConfig = asObject(json.publishConfig);
  if (publishConfig?.access !== "public") {
    errors.push(`${name} publishConfig.access must be "public"`);
  }

  const files = Array.isArray(json.files) ? json.files : [];
  for (const required of ["dist", ...MIRRORED_DOCS]) {
    if (!files.includes(required)) errors.push(`${name} files[] missing ${required}`);
  }

  const declaredPaths = [
    asString(json.main),
    asString(json.types),
    ...collectPathStrings(json.exports),
    ...collectPathStrings(json.bin),
  ].filter((path): path is string => Boolean(path));

  for (const declaredPath of new Set(declaredPaths)) {
    const rel = normalizePackageRelativePath(declaredPath);
    if (opts.requireBuiltArtifacts || rel.startsWith("bin/")) {
      validateFileExists(errors, pkgRoot, rel, `${name} declared artifact`);
    }
  }

  const bin = asObject(json.bin);
  if (bin) {
    for (const [binName, binPath] of Object.entries(bin)) {
      if (typeof binPath !== "string") continue;
      const full = join(pkgRoot, normalizePackageRelativePath(binPath));
      if (existsSync(full) && (statSync(full).mode & 0o111) === 0) {
        errors.push(`${name} bin ${binName} is not executable: ${binPath}`);
      }
    }
  }

  if (opts.requireMirroredDocs) {
    for (const doc of MIRRORED_DOCS) {
      validateFileExists(errors, pkgRoot, doc, `${name} mirrored doc`);
    }
  }

  return version;
}

function validatePrivatePackages(root: string, version: string | undefined, errors: string[]): void {
  for (const pkg of PRIVATE_PACKAGES) {
    const json = readJson(packagePath(root, pkg));
    const name = asString(json.name) ?? `packages/${pkg}`;
    if (json.private !== true) errors.push(`${name} must stay private and out of npm publish`);
    const privateVersion = asString(json.version);
    if (version && privateVersion && privateVersion !== version) {
      errors.push(`${name} version ${privateVersion} does not match workspace release ${version}`);
    }
  }
}

function validateWebFetchDockerRuntime(root: string, errors: string[]): void {
  const rootPkg = readJson(join(root, "package.json"));
  const catalog = asObject(asObject(rootPkg.workspaces)?.catalog);
  const catalogVersion = parseExactCatalogVersion(asString(catalog?.["playwright-core"]));
  if (!catalogVersion) {
    errors.push("root workspaces.catalog.playwright-core must be an exact or caret SemVer");
    return;
  }

  const dockerfilePath = packagePath(root, "web-fetch-server", "Dockerfile");
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const imageVersion = dockerfile.match(/mcr\.microsoft\.com\/playwright:v([^-\s]+)-/)?.[1];
  if (imageVersion !== catalogVersion) {
    errors.push(
      `web-fetch Docker Playwright image v${imageVersion ?? "<missing>"} does not match catalog playwright-core ${catalogVersion}`,
    );
  }

  const browsersJsonPath = packagePath(root, "web-fetch-server", "node_modules/playwright-core/browsers.json");
  if (!existsSync(browsersJsonPath)) {
    errors.push("web-fetch playwright-core browsers.json missing; run bun install before release validation");
    return;
  }
  const browsersJson = readJson(browsersJsonPath);
  const browsers = Array.isArray(browsersJson.browsers) ? browsersJson.browsers : [];
  const chromium = browsers.find(
    (entry): entry is JsonObject =>
      Boolean(entry) && typeof entry === "object" && asString((entry as JsonObject).name) === "chromium",
  );
  const revision = asString(chromium?.revision);
  const executableRevision = dockerfile.match(/PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=\/ms-playwright\/chromium-(\d+)\//)?.[1];
  if (!revision) {
    errors.push("playwright-core browsers.json does not declare a Chromium revision");
  } else if (executableRevision !== revision) {
    errors.push(
      `web-fetch Docker Chromium executable revision ${executableRevision ?? "<missing>"} does not match playwright-core revision ${revision}`,
    );
  }
}

export function validateReleaseArtifacts(
  options: ReleaseArtifactValidationOptions = {},
): ReleaseArtifactValidationResult {
  const root = options.root ?? process.cwd();
  const requireBuiltArtifacts = options.requireBuiltArtifacts ?? false;
 // P7：默认开启 mirrored docs 检查；CI 不希望与 PR 文档同步窗口期"误漂移"，
 // 显式 `--allow-doc-drift` 用于单次逃生（例如先合并文档 PR 再合并代码 PR）。
  const requireMirroredDocs = options.requireMirroredDocs ?? true;
  const checkDockerRuntime = options.checkDockerRuntime ?? true;
  const errors: string[] = [];

  let version: string | undefined;
  for (const pkg of PUBLIC_PACKAGES) {
    version = validatePublicPackage(
      root,
      pkg,
      version,
      { requireBuiltArtifacts, requireMirroredDocs },
      errors,
    ) ?? version;
  }

  validatePrivatePackages(root, version, errors);
  if (checkDockerRuntime) validateWebFetchDockerRuntime(root, errors);

  return { ok: errors.length === 0, version, errors };
}

function parseCliArgs(argv: string[]): ReleaseArtifactValidationOptions {
  const options: ReleaseArtifactValidationOptions = {};
  for (const arg of argv) {
    if (arg === "--require-built-artifacts") {
      options.requireBuiltArtifacts = true;
    } else if (arg === "--require-mirrored-docs") {
      options.requireMirroredDocs = true;
    } else if (arg === "--allow-doc-drift") {
 // P7：显式逃生闸——仅用于文档/代码 PR 异步合并的过渡窗口。
      options.requireMirroredDocs = false;
    } else if (arg === "--skip-docker-runtime") {
      options.checkDockerRuntime = false;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  try {
    const result = validateReleaseArtifacts(parseCliArgs(Bun.argv.slice(2)));
    if (!result.ok) {
      console.error("[release-artifacts] validation failed:");
      for (const error of result.errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    console.log(`[release-artifacts] ok${result.version ? ` (${result.version})` : ""}`);
  } catch (error) {
    console.error(`[release-artifacts] ${(error as Error).message}`);
    process.exit(1);
  }
}
