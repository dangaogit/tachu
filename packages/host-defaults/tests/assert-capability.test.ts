import { describe, expect, it } from "bun:test";
import { assertCapabilityProvided } from "../src/capabilities";

describe("assertCapabilityProvided", () => {
  it("throws and emits factory.fail-closed when capability not provided", () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const observability = {
      emit(event: { type: string; payload: unknown }) {
        events.push(event);
      },
    };
    expect(() =>
      assertCapabilityProvided(observability as never, "providers", false, "providers"),
    ).toThrow(/fail-closed/);
    const failClosed = events.find(
      (e) => (e.payload as { status?: string }).status === "factory.fail-closed",
    );
    expect(failClosed).toBeDefined();
    expect((failClosed?.payload as { capability?: string }).capability).toBe("providers");
  });

  it("silently returns when capability is provided", () => {
    const events: unknown[] = [];
    const observability = {
      emit(event: unknown) {
        events.push(event);
      },
    };
    assertCapabilityProvided(observability as never, "providers", true, "providers");
    expect(events).toHaveLength(0);
  });
});
