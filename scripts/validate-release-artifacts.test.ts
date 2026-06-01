import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { validateReleaseArtifacts } from "./validate-release-artifacts";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(path: string, content = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tachu-release-artifacts-"));
  writeJson(join(root, "package.json"), {
    workspaces: {
      catalog: {
        "playwright-core": "^1.59.1",
      },
    },
  });

  for (const pkg of ["core", "extensions", "host-defaults", "cli"]) {
    const pkgRoot = join(root, "packages", pkg);
    mkdirSync(join(pkgRoot, "dist"), { recursive: true });
    writeFile(join(pkgRoot, "dist/index.js"));
    writeFile(join(pkgRoot, "dist/index.d.ts"));
    for (const doc of ["README.md", "README_ZH.md", "CHANGELOG.md", "LICENSE"]) {
      writeFile(join(pkgRoot, doc), doc);
    }
    writeJson(join(pkgRoot, "package.json"), {
      name: `@tachu/${pkg}`,
      version: "1.0.0-rc.0",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      files: ["dist", "README.md", "README_ZH.md", "CHANGELOG.md", "LICENSE"],
      publishConfig: { access: "public" },
    });
  }

  writeFile(join(root, "packages/cli/bin/tachu.mjs"), "#!/usr/bin/env bun\n");
  chmodSync(join(root, "packages/cli/bin/tachu.mjs"), 0o755);
  const cliPkg = JSON.parse(readText(join(root, "packages/cli/package.json"))) as Record<string, unknown>;
  cliPkg.bin = { tachu: "./bin/tachu.mjs" };
  cliPkg.files = [...(cliPkg.files as string[]), "bin"];
  writeJson(join(root, "packages/cli/package.json"), cliPkg);

  mkdirSync(join(root, "packages/web-fetch-server/node_modules/playwright-core"), { recursive: true });
  writeJson(join(root, "packages/web-fetch-server/package.json"), {
    name: "@tachu/web-fetch-server",
    version: "1.0.0-rc.0",
    private: true,
  });
  writeFile(
    join(root, "packages/web-fetch-server/Dockerfile"),
    [
      "FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS runner",
      "ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/ms-playwright/chromium-1217/chrome-linux/chrome",
      "",
    ].join("\n"),
  );
  writeJson(join(root, "packages/web-fetch-server/node_modules/playwright-core/browsers.json"), {
    browsers: [{ name: "chromium", revision: "1217" }],
  });

  return root;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

describe("validateReleaseArtifacts", () => {
 test("passes a complete release fixture", () => {
    const result = validateReleaseArtifacts({
      root: createFixtureRoot(),
      requireBuiltArtifacts: true,
      requireMirroredDocs: true,
    });

    expect(result).toMatchObject({ ok: true, version: "1.0.0-rc.0", errors: [] });
  });

 test("fails when an exported file is missing", () => {
    const root = createFixtureRoot();
    const pkgPath = join(root, "packages/extensions/package.json");
    const pkg = JSON.parse(readText(pkgPath)) as Record<string, unknown>;
    pkg.exports = {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./providers/gemini": {
        types: "./dist/providers/gemini.d.ts",
        import: "./dist/providers/gemini.js",
      },
    };
    writeJson(pkgPath, pkg);

    const result = validateReleaseArtifacts({ root, requireBuiltArtifacts: true });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "@tachu/extensions declared artifact missing: dist/providers/gemini.d.ts",
    );
    expect(result.errors).toContain(
      "@tachu/extensions declared artifact missing: dist/providers/gemini.js",
    );
  });

 test("fails when Web Fetch Docker runtime drifts from Playwright catalog", () => {
    const root = createFixtureRoot();
    writeFile(
      join(root, "packages/web-fetch-server/Dockerfile"),
      [
        "FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS runner",
        "ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/ms-playwright/chromium-1140/chrome-linux/chrome",
        "",
      ].join("\n"),
    );

    const result = validateReleaseArtifacts({ root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "web-fetch Docker Playwright image v1.48.0 does not match catalog playwright-core 1.59.1",
    );
    expect(result.errors).toContain(
      "web-fetch Docker Chromium executable revision 1140 does not match playwright-core revision 1217",
    );
  });
});
