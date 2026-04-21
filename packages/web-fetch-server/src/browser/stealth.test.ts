import { describe, expect, test, beforeEach } from "bun:test";
import {
  getStealthChromium,
  getStealthChromiumSingletonForTest,
  resetStealthChromiumSingletonForTest,
  resolveStealth,
  type StealthChromiumLauncher,
} from "./stealth";

beforeEach(() => {
  resetStealthChromiumSingletonForTest();
});

describe("resolveStealth", () => {
  test("request true overrides service false", () => {
    expect(resolveStealth(false, true)).toBe(true);
    expect(resolveStealth(true, true)).toBe(true);
  });

  test("request false overrides service true", () => {
    expect(resolveStealth(true, false)).toBe(false);
    expect(resolveStealth(false, false)).toBe(false);
  });

  test("request null inherits service level", () => {
    expect(resolveStealth(false, null)).toBe(false);
    expect(resolveStealth(true, null)).toBe(true);
  });

  test("request undefined inherits service level", () => {
    expect(resolveStealth(false, undefined)).toBe(false);
    expect(resolveStealth(true, undefined)).toBe(true);
  });
});

describe("getStealthChromium", () => {
  test("lazy singleton: loader runs once; second call returns same reference", () => {
    let loads = 0;
    const fakeChromium = {} as StealthChromiumLauncher;
    const loader = (): StealthChromiumLauncher => {
      loads++;
      return fakeChromium;
    };

    const first = getStealthChromium({ loadStealthChromium: loader });
    const second = getStealthChromium();

    expect(first).toBe(fakeChromium);
    expect(second).toBe(fakeChromium);
    expect(loads).toBe(1);
  });

  test("does not initialize stealth chromium until first getStealthChromium call", () => {
    expect(resolveStealth(false, true)).toBe(true);
    expect(getStealthChromiumSingletonForTest()).toBeUndefined();

    const fake = {} as StealthChromiumLauncher;
    getStealthChromium({ loadStealthChromium: () => fake });
    expect(getStealthChromiumSingletonForTest()).toBe(fake);
  });

  test("never calling getStealthChromium leaves singleton unset (plugin path not taken)", () => {
    expect(resolveStealth(true, false)).toBe(false);
    expect(getStealthChromiumSingletonForTest()).toBeUndefined();
  });
});
