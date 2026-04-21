import { describe, expect, test } from "bun:test";
import { PlanningError } from "../errors";
import { topologicalSort } from "./topological-sort";

describe("topologicalSort", () => {
  test("sorts dag nodes", () => {
    const sorted = topologicalSort(
      [
        { id: "a", type: "sub-flow", ref: "a", input: {} },
        { id: "b", type: "sub-flow", ref: "b", input: {} },
      ],
      [{ from: "a", to: "b" }],
    );
    expect(sorted.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("throws cycle error", () => {
    expect(() =>
      topologicalSort(
        [
          { id: "a", type: "sub-flow", ref: "a", input: {} },
          { id: "b", type: "sub-flow", ref: "b", input: {} },
        ],
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
    ).toThrow(PlanningError);
  });

  test("throws invalid plan when edge references unknown node", () => {
    expect(() =>
      topologicalSort(
        [{ id: "a", type: "sub-flow", ref: "a", input: {} }],
        [{ from: "a", to: "missing" }],
      ),
    ).toThrow(PlanningError);
  });
});

