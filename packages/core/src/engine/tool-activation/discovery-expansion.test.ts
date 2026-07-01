import { describe, it, expect } from "bun:test";
import type { DiscoveryExpansionConfig } from "../../types/config";
import { expandDiscoverySiblings } from "./discovery-expansion";

const asSet = (names: string[]): ReadonlySet<string> => new Set(names);

describe("expandDiscoverySiblings", () => {
  it("pin 一个成员时并入其配置的同域兄弟（pinned 排前）", () => {
    const cfg: DiscoveryExpansionConfig = {
      enabled: true,
      siblings: { A: ["B", "C"] },
    };
    const out = expandDiscoverySiblings(["A"], cfg, asSet(["A", "B", "C"]), asSet([]));
    expect(out).toEqual(["A", "B", "C"]);
  });

  it("enabled !== true → 原样返回 names（完全等价现状）", () => {
    const cfg: DiscoveryExpansionConfig = { siblings: { A: ["B", "C"] } };
    const out = expandDiscoverySiblings(["A"], cfg, asSet(["A", "B", "C"]), asSet([]));
    expect(out).toEqual(["A"]);
  });

  it("dedup 且只保留已注册工具（未注册兄弟被丢弃）", () => {
    const cfg: DiscoveryExpansionConfig = {
      enabled: true,
      siblings: { A: ["B", "B", "ghost"] },
    };
 // ghost 未注册；B 重复只出现一次
    const out = expandDiscoverySiblings(["A", "A"], cfg, asSet(["A", "B"]), asSet([]));
    expect(out).toEqual(["A", "B"]);
  });

  it("excludeTools 命中的兄弟被剔除", () => {
    const cfg: DiscoveryExpansionConfig = {
      enabled: true,
      siblings: { A: ["B", "C"] },
    };
    const out = expandDiscoverySiblings(["A"], cfg, asSet(["A", "B", "C"]), asSet(["B"]));
    expect(out).toEqual(["A", "C"]);
  });

  it("groupByNamespacePrefix：并入同命名空间前缀的已注册工具，跨命名空间/无命名空间不并入", () => {
    const cfg: DiscoveryExpansionConfig = {
      enabled: true,
      groupByNamespacePrefix: true,
    };
    const registered = asSet([
      "mcp.biz.query_database",
      "mcp.biz.list_databases",
      "mcp.biz.read_ontology",
      "mcp.other.query",
      "plain-tool",
    ]);
    const out = expandDiscoverySiblings(
      ["mcp.biz.query_database"],
      cfg,
      registered,
      asSet([]),
    );
    expect(out).toEqual([
      "mcp.biz.query_database",
      "mcp.biz.list_databases",
      "mcp.biz.read_ontology",
    ]);
  });

  it("maxTools 超限：保留全部 pinned + 依序截断兄弟", () => {
    const cfg: DiscoveryExpansionConfig = {
      enabled: true,
      siblings: { A: ["B", "C", "D"] },
      maxTools: 3,
    };
    const out = expandDiscoverySiblings(
      ["A"],
      cfg,
      asSet(["A", "B", "C", "D"]),
      asSet([]),
    );
    expect(out).toEqual(["A", "B", "C"]);
  });

  it("maxTools 小于 pinned 数量：pinned 全部保留（cap 只截断兄弟）", () => {
    const cfg: DiscoveryExpansionConfig = {
      enabled: true,
      siblings: { A: ["X"] },
      maxTools: 2,
    };
    const out = expandDiscoverySiblings(
      ["A", "B", "C"],
      cfg,
      asSet(["A", "B", "C", "X"]),
      asSet([]),
    );
    expect(out).toEqual(["A", "B", "C"]);
  });

  it("默认 maxTools=20：兄弟超过 20 项时截断到 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => `sib-${i}`);
    const cfg: DiscoveryExpansionConfig = {
      enabled: true,
      siblings: { A: many },
    };
    const out = expandDiscoverySiblings(
      ["A"],
      cfg,
      asSet(["A", ...many]),
      asSet([]),
    );
    expect(out.length).toBe(20);
    expect(out[0]).toBe("A");
  });
});
