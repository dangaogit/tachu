import { afterEach, describe, expect, test } from "bun:test";

import { loadConfig } from "../config/load-config.js";
import pkg from "../../package.json" with { type: "json" };
import { handleHealthz, setBrowserAvailability } from "./healthz.js";

function testConfig() {
  return loadConfig({});
}

afterEach(() => {
  setBrowserAvailability(() => false);
});

describe("handleHealthz", () => {
  test("默认返回 status ok、version 非空、browser.available 为 false", async () => {
    const res = handleHealthz(testConfig());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(await res.text()) as {
      status: string;
      version: string;
      uptimeSec: number;
      browser: { available: boolean };
    };
    expect(body.status).toBe("ok");
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.browser.available).toBe(false);
    expect(typeof body.uptimeSec).toBe("number");
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  test("version 与 package.json 一致（import 读取，非硬编码）", async () => {
    const res = handleHealthz(testConfig());
    const body = JSON.parse(await res.text()) as { version: string };
    expect(body.version).toBe(pkg.version);
  });

  test("setBrowserAvailability 注入后 browser.available 为 true", async () => {
    setBrowserAvailability(() => true);
    const res = handleHealthz(testConfig());
    const body = JSON.parse(await res.text()) as { browser: { available: boolean } };
    expect(body.browser.available).toBe(true);
  });
});
