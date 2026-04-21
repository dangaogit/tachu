# ADR 0004 — CLI / 宿主多模态输入（本地图片附件）

- Status: Accepted
- Date: 2026-04-21
- Applies to: `@tachu/core`, `@tachu/cli`
- Related: 引擎侧 `envelopeNeedsVision`、Intent / Prompt 装配对多模态 `InputEnvelope` 的处理（与 core 主线变更同期）。

## 背景

先前 CLI 仅发送纯文本 `InputEnvelope`，无法将本地图片作为 `image_url` 块交给 VL 模型；宿主若手写 `data:` URL 易出错且无统一 MIME 校验。需要：

1. **SDK / 宿主**：用少量 API 从「文字 + 内存中的 base64 图」构造合法多模态信封。
2. **CLI**：`tachu run` 能附加磁盘图片；交互式 `tachu chat` 能通过斜杠命令触发同一语义。

## 决定

### 1) `@tachu/core` 导出纯函数

- `buildMultimodalUserContent({ text, images: { mimeType, base64 }[] })` → `Message["content"]`（内联 `data:{mime};base64,...`）。
- `buildMultimodalInputEnvelope(...)` → `InputEnvelope`，含 `metadata.modality`（有图为 `image`）。
- MIME 白名单仅限常见栅格图：`image/png|jpeg|gif|webp`（由调用方保证；CLI 层用魔数写入）。

### 2) `@tachu/cli` 魔数识别 MIME

- **禁止**仅靠扩展名推断类型；使用 `detectImageMimeFromMagic(Buffer)` 识别文件头：
  - PNG、JPEG、GIF、WebP（RIFF…WEBP）。
- 无法识别则拒绝并给出明确错误，避免错误 `Content-Type` 导致上游 400。

### 3) 路径沙箱

- 读图路径经 `resolveAllowedPath`（与 read-file 一致语义），根集合来自 `safety.workspaceRoot` + `allowedWriteRoots`（见 `buildCliReadSandboxRoots`）。
- 单文件大小不超过 `safety.maxInputSizeBytes`（与全局安全策略对齐）。

### 4) `tachu run`

- 支持 **重复** `--image <path>`（通过扫描 `process.argv`，而非 citty 单值参数）。
- 与位置参数 / `--input` / stdin 组合：若仅有 `--image`、无其它 prompt 源，则使用默认中文提示：「请描述这张图片的主要内容。」
- **`--json` 与 `--image` 互斥**（避免 JSON 解析语义冲突）。

### 5) `tachu chat`（Ink / readline）

- 斜杠命令：`/image <path> [可选说明文字]`；支持 `"path with spaces.png"` 形式引号路径。
- 命令名后必须为空白或行尾，避免误匹配 `/images`。
- 每轮仍走 `engine.runStream`，与纯文本回合一致（MCP `activateForPrompt` 仍接收整行用于 keyword 惰性装配）。

### 6) 非目标（本 ADR 不包含）

- Ink 内拖拽上传、剪贴板图片。
- 在 CLI 内暴露「仅 URL、无本地文件」的附件（宿主可直接组 `InputEnvelope`）。

## 后果

- **正**：多模态与 `capabilityMapping.vision` / 引擎 `envelopeNeedsVision` 对齐；行为可测、可文档化。
- **负**：内联 base64 会放大 prompt 体积，大图仍受 `maxInputSizeBytes` 约束；宿主应注意成本与延迟。

## 参考实现（代码路径）

| 能力 | 路径 |
|------|------|
| Core 组装 | `packages/core/src/utils/multimodal-envelope.ts` |
| CLI 魔数 | `packages/cli/src/utils/image-mime.ts` |
| CLI 读盘 + 沙箱 + 信封 | `packages/cli/src/utils/multimodal-local-images.ts` |
| 斜杠解析 | `packages/cli/src/utils/image-slash-command.ts` |
| `run` 集成 | `packages/cli/src/commands/run.ts` |
| 交互集成 | `packages/cli/src/interactive.ts`、`packages/cli/src/ui/ink-interactive-chat.tsx` |
