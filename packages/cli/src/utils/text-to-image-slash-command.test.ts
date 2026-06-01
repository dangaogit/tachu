import { describe, expect, it } from "bun:test";
import {
  detectTextToImageIntent,
  extractSavePathHeuristic,
  tryParseTextToImageSlashCommand,
} from "./text-to-image-slash-command";

describe("tryParseTextToImageSlashCommand", () => {
  it("parses /draw with prompt", () => {
    expect(tryParseTextToImageSlashCommand("/draw 一只猫")).toEqual({ prompt: "一只猫" });
  });

  it("parses /text-to-image", () => {
    expect(tryParseTextToImageSlashCommand("/text-to-image 水彩风景")).toEqual({
      prompt: "水彩风景",
    });
  });

  it("parses /text2image with empty prompt", () => {
    expect(tryParseTextToImageSlashCommand("/text2image")).toEqual({ prompt: "" });
  });

  it("does not match /drawing", () => {
    expect(tryParseTextToImageSlashCommand("/drawing x")).toBeNull();
  });

  it("extracts --save <path> from tail", () => {
    expect(tryParseTextToImageSlashCommand("/draw 一只小猫 --save /tmp/cat.png")).toEqual({
      prompt: "一只小猫",
      savePath: "/tmp/cat.png",
    });
  });

  it("extracts --save=<path> with equals form", () => {
    expect(
      tryParseTextToImageSlashCommand("/draw 海滩 --save=~/Desktop/a.jpg"),
    ).toEqual({ prompt: "海滩", savePath: "~/Desktop/a.jpg" });
  });

  it("extracts --save with quoted path containing spaces", () => {
    expect(
      tryParseTextToImageSlashCommand('/draw 星空 --save "/tmp/night sky.png"'),
    ).toEqual({ prompt: "星空", savePath: "/tmp/night sky.png" });
  });

  it("falls back to heuristic: 保存到 <path>", () => {
    expect(
      tryParseTextToImageSlashCommand("/draw 生成一只小猫图片，保存到 /tmp/cat.png"),
    ).toEqual({ prompt: "生成一只小猫图片", savePath: "/tmp/cat.png" });
  });

  it("falls back to heuristic: save to <path>", () => {
    expect(
      tryParseTextToImageSlashCommand("/draw a cat portrait, save to ~/Pictures/cat.jpg"),
    ).toEqual({ prompt: "a cat portrait", savePath: "~/Pictures/cat.jpg" });
  });

  it("does not hijack text that looks like a sentence", () => {
    expect(
      tryParseTextToImageSlashCommand("/draw 一只写字的猫 save the world"),
    ).toEqual({ prompt: "一只写字的猫 save the world" });
  });
});

describe("extractSavePathHeuristic", () => {
  it("recognizes '保存到 <path>' at tail", () => {
    expect(extractSavePathHeuristic("一只小猫图片，保存到 /tmp/cat.png")).toEqual({
      prompt: "一只小猫图片",
      savePath: "/tmp/cat.png",
    });
  });

  it("recognizes '存为 <path>.'", () => {
    expect(extractSavePathHeuristic("水彩风景 存为 ./out/scene.jpeg。")).toEqual({
      prompt: "水彩风景",
      savePath: "./out/scene.jpeg",
    });
  });

  it("does not match bare filename like 'cat.png'", () => {
    expect(extractSavePathHeuristic("draw a cat save to cat.png")).toEqual({
      prompt: "draw a cat save to cat.png",
    });
  });

  it("returns raw prompt when no trigger phrase", () => {
    expect(extractSavePathHeuristic("just a cat portrait")).toEqual({
      prompt: "just a cat portrait",
    });
  });
});

describe("detectTextToImageIntent", () => {
  it("delegates to slash command parser", () => {
    expect(detectTextToImageIntent("/draw 橘猫")).toEqual({
      prompt: "橘猫",
      source: "slash",
    });
    expect(
      detectTextToImageIntent("/draw 橘猫 --save /tmp/cat.png"),
    ).toEqual({ prompt: "橘猫", savePath: "/tmp/cat.png", source: "slash" });
  });

  it("detects via image-extension save path even without image noun", () => {
    expect(
      detectTextToImageIntent("生成一只橘猫，保存到 /tmp/cat.png"),
    ).toEqual({
      prompt: "生成一只橘猫",
      savePath: "/tmp/cat.png",
      source: "heuristic-path",
    });
  });

  it("detects via image-extension when prompt has no verb", () => {
    expect(
      detectTextToImageIntent("橘色波斯猫，保存到 ~/Desktop/cat.webp"),
    ).toEqual({
      prompt: "橘色波斯猫",
      savePath: "~/Desktop/cat.webp",
      source: "heuristic-path",
    });
  });

  it("detects via Chinese verb + image noun without save path", () => {
    expect(detectTextToImageIntent("生成一张水彩风景的图片")).toEqual({
      prompt: "生成一张水彩风景的图片",
      source: "heuristic-keyword",
    });
    expect(detectTextToImageIntent("画一幅山水插画")).toEqual({
      prompt: "画一幅山水插画",
      source: "heuristic-keyword",
    });
  });

  it("detects via English verb + image noun", () => {
    expect(detectTextToImageIntent("draw a cat picture in watercolor")).toEqual(
      { prompt: "draw a cat picture in watercolor", source: "heuristic-keyword" },
    );
    expect(
      detectTextToImageIntent("please create an illustration of a sunrise"),
    ).toEqual({
      prompt: "please create an illustration of a sunrise",
      source: "heuristic-keyword",
    });
  });

  it("combines keyword + save path when both present", () => {
    expect(
      detectTextToImageIntent(
        "生成一张橘猫图片，保存到 /tmp/cat.png",
      ),
    ).toEqual({
      prompt: "生成一张橘猫图片",
      savePath: "/tmp/cat.png",
      source: "heuristic-path",
    });
  });

  it("does NOT hijack plain text requests without image signal", () => {
    expect(detectTextToImageIntent("写一首关于小猫的诗")).toBeNull();
    expect(
      detectTextToImageIntent("解释一下 Node.js 的事件循环"),
    ).toBeNull();
    expect(detectTextToImageIntent("what is kubernetes?")).toBeNull();
  });

  it("does NOT hijack save-to-non-image-extension requests", () => {
    expect(
      detectTextToImageIntent("把今天的会议纪要，保存到 /tmp/notes.txt"),
    ).toBeNull();
    expect(
      detectTextToImageIntent("生成一个脚本，保存到 /tmp/build.sh"),
    ).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectTextToImageIntent("")).toBeNull();
    expect(detectTextToImageIntent("   ")).toBeNull();
  });
});
