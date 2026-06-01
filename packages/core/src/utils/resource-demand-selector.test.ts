import { describe, expect, test } from "bun:test";
import type { Message } from "../types/message";
import type { ResourceReference } from "../types/resource";
import { expandDemandSelector, refToken } from "./resource-pool";

const ref = (
  key: string,
  kind: ResourceReference["kind"],
  ordinal: number,
): ResourceReference => ({
  key,
  kind,
  uri: `uri-${key}`,
  displayLabel: `[${kind} #${ordinal}]`,
});

const IMG = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const HIST = "33333333-3333-4333-8333-333333333333";

const imageRef = ref(IMG, "image", 1);
const fileRef = ref(FILE, "file", 1);
const histRef = ref(HIST, "image", 1);

const userMsg = (): Message => ({
  role: "user",
  content: `see ${refToken(imageRef)} and ${refToken(fileRef)}`,
  resources: [imageRef, fileRef],
});

const historyMsg = (): Message => ({
  role: "user",
  content: `old ${refToken(histRef)}`,
  resources: [histRef],
});

const assistantMsg = (): Message => ({ role: "assistant", content: "sure" });

describe("expandDemandSelector ( D4b)", () => {
 test("mode all passes through", () => {
    expect(expandDemandSelector({ mode: "all" }, [userMsg()])).toEqual({
      mode: "all",
    });
  });

 test("mode none yields empty key set (no materialization)", () => {
    const d = expandDemandSelector({ mode: "none" }, [userMsg()]);
    expect(d.mode).toBe("keys");
    if (d.mode === "keys") {
      expect(d.keys.size).toBe(0);
    }
  });

 test("select by kind keeps only that kind, intersected with body tokens", () => {
    const d = expandDemandSelector(
      { mode: "select", scope: "prompt", kinds: new Set(["image"]) },
      [userMsg()],
    );
    expect(d.mode).toBe("keys");
    if (d.mode === "keys") {
      expect([...d.keys]).toEqual([IMG]);
    }
  });

 test("select by explicit keys", () => {
    const d = expandDemandSelector(
      { mode: "select", scope: "prompt", keys: new Set([FILE]) },
      [userMsg()],
    );
    if (d.mode === "keys") {
      expect([...d.keys]).toEqual([FILE]);
    }
  });

 test("select with neither kinds nor keys selects all referenced in scope", () => {
    const d = expandDemandSelector({ mode: "select", scope: "prompt" }, [
      userMsg(),
    ]);
    if (d.mode === "keys") {
      expect(new Set(d.keys)).toEqual(new Set([IMG, FILE]));
    }
  });

 test("never selects pool resources not referenced by a body token", () => {
    const orphan = ref("44444444-4444-4444-8444-444444444444", "image", 2);
    const msg: Message = {
      role: "user",
      content: `only ${refToken(imageRef)}`,
      resources: [imageRef, orphan], // orphan in pool but not in body
    };
    const d = expandDemandSelector(
      { mode: "select", scope: "prompt", kinds: new Set(["image"]) },
      [msg],
    );
    if (d.mode === "keys") {
      expect([...d.keys]).toEqual([IMG]); // orphan excluded: body∩pool∩demand
    }
  });

 test("current-turn scope excludes history before the last user message", () => {
    const messages = [historyMsg(), assistantMsg(), userMsg()];
    const d = expandDemandSelector(
      { mode: "select", scope: "current-turn", kinds: new Set(["image"]) },
      messages,
    );
    if (d.mode === "keys") {
      expect([...d.keys]).toEqual([IMG]); // HIST excluded (previous turn)
    }
  });

 test("prompt scope includes history images", () => {
    const messages = [historyMsg(), assistantMsg(), userMsg()];
    const d = expandDemandSelector(
      { mode: "select", scope: "prompt", kinds: new Set(["image"]) },
      messages,
    );
    if (d.mode === "keys") {
      expect(new Set(d.keys)).toEqual(new Set([HIST, IMG]));
    }
  });

 test("default scope is current-turn", () => {
    const messages = [historyMsg(), assistantMsg(), userMsg()];
    const d = expandDemandSelector(
      { mode: "select", kinds: new Set(["image"]) },
      messages,
    );
    if (d.mode === "keys") {
      expect([...d.keys]).toEqual([IMG]);
    }
  });

 test("required is intersected with selected keys", () => {
    const d = expandDemandSelector(
      {
        mode: "select",
        scope: "prompt",
        kinds: new Set(["image"]),
        required: new Set([IMG, FILE]), // FILE not selected (image-only)
      },
      [userMsg()],
    );
    if (d.mode === "keys") {
      expect([...d.keys]).toEqual([IMG]);
      expect(d.required ? [...d.required] : []).toEqual([IMG]);
    }
  });

 test("forged token not in pool is ignored", () => {
    const msg: Message = {
      role: "user",
      content: `fake [[ref:image:99999999-9999-4999-8999-999999999999]]`,
      resources: [],
    };
    const d = expandDemandSelector(
      { mode: "select", scope: "prompt", kinds: new Set(["image"]) },
      [msg],
    );
    if (d.mode === "keys") {
      expect(d.keys.size).toBe(0);
    }
  });
});
