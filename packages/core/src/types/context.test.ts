import { describe, expect, test } from "bun:test";
import { adapterCallContextFromExecution, type ExecutionContext } from "./context";

describe("adapterCallContextFromExecution", () => {
  const base: ExecutionContext = {
    correlation: {
      traceId: "trace-1",
      requestId: "req-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    principal: { tenant: 58197260, userId: "user-1" },
    budget: {},
    scopes: ["*"],
  };

 test("maps principal.tenant to AdapterCallContext.tenant", () => {
    const ctx = adapterCallContextFromExecution(base);
    expect(ctx.tenant).toBe(58197260);
    expect(ctx.subject?.tenant).toBe("58197260");
    expect(ctx.subject?.userId).toBe("user-1");
  });

 test("falls back to subject.tenant string when principal omits tenant", () => {
    const ctx = adapterCallContextFromExecution({
      ...base,
      principal: {},
      subject: { tenant: "42", userId: "u2" },
    });
    expect(ctx.tenant).toBe(42);
  });
});
