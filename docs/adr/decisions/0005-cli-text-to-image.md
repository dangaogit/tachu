# ADR 0005 — CLI 文生图（qwen / wanxiang）与 `--save-image` 本地落盘

- Status: Accepted
- Date: 2026-04-21
- Applies to: `@tachu/core`, `@tachu/extensions`, `@tachu/cli`
- Related: ADR 0004（多模态输入）、`capabilityMapping.text-to-image`、`direct-answer` 子流程

## 背景

接入 Qwen / Wanxiang 系列做文生图时暴露三个问题：

1. **模型路由错位**：`QwenProviderAdapter` 仅用 `/wanx/i` 识别图像合成模型，`wan2.7-image` 被错误转发到 OpenAI 兼容端点，返回
   `x-dashscope-sse and stream parameter mismatch. Received: x-dashscope-sse=enable, stream=False`。
2. **结构化产物缺失**：`ChatResponse` / `EngineOutput.metadata` 没有结构化的 generatedImages 字段，即便模型成功返图，CLI
   也只能在正文中硬解析 URL。
3. **无本地落盘**：CLI 完全没有把生成图片下载到本地文件的能力，用户在 prompt 中写「保存到 /tmp/cat.png」也只是个表面
   指令，引擎不会把字节写下来。

DashScope 的 aigc 文生图实际上有两个端点，需分别对待：

| 端点 | 适配模型 | 同步/异步 | SSE |
|------|----------|-----------|-----|
| `POST /api/v1/services/aigc/text2image/image-synthesis` | `wanx-*` | **异步任务**（create → poll） | 否 |
| `POST /api/v1/services/aigc/multimodal-generation/generation` | `wan2.x-image*` / `qwen-image-*` | **同步**返图 | 否 |

## 决定

### 1) 核心类型扩展（`@tachu/core`）

新增 `GeneratedImage` 结构并在两处 API 上暴露：

- `ChatResponse.images?: GeneratedImage[]` —— Provider 层结果；
- `EngineOutput.metadata.generatedImages?: GeneratedImage[]` —— 引擎输出（由 `direct-answer` 子流程与
  `runOutputPhase` 联合注入）。

`GeneratedImage` 形状：

```ts
interface GeneratedImage {
  url: string; // 远端 URL 或 data: URL
  index: number; // 同轮内稳定下标
  mimeType?: string;
  size?: string;
  sizeBytes?: number;
  providerMetadata?: Record<string, unknown>;
}
```

### 2) Qwen Provider 重路由（`@tachu/extensions`）

- 新增 `isDashScopeMultimodalImageGenerationModel(model)`：匹配 `^wan2\.\d+-image` / 未来
  `qwen-image-*`，走 `chatMultimodalGeneration`。
- 保留 `isWanxImageModel()` → `chatImageSynthesis`（异步任务）。
- 两者都把结果结构化进 `ChatResponse.images`。
- `QwenImageParameters` 扩展到 DashScope 2026 参数全集：`size`（含 `2K`）、`seed`、`watermark`、
  `thinkingMode`、`promptExtend`、`enableSequential`、`bboxList`、`colorPalette`、`outputFormat`、`refImages`。
- 文生图与 OpenAI 兼容聊天彻底分流：不再错误设置 `x-dashscope-sse`。

### 3) 子流程传播（`direct-answer`）

- `DirectAnswerContext` 新增 `onGeneratedImages?(images)` 回调。
- `InternalSubflowContext` 透传该回调；`Engine` 用 `activeRunGeneratedImages: Map<traceId, GeneratedImage[]>`
  接收，在 `runOutputPhase` 组装 `EngineOutput.metadata.generatedImages`。
- **文生图强制非流式**：ChatStream 的 `finish` 事件不承载 `images`。当 `input.textToImage === true` 时
  子流程直接走 `Provider.chat()`，保证图片列表完整回传。

### 4) `tachu run --save-image <path>`

- `saveGeneratedImages({ cwd, images, target, signal, overwrite })` 统一处理落盘：
  - 已存在目录 / 以 `/` 结尾 → 视为目录，写 `generated-<index>.<ext>`；
  - 单图 + 文件路径 → 直接命名；
  - 多图 + 文件路径 → 追加 `-<n>` 后缀；
  - 父目录不存在自动 `mkdir -p`；
  - 单张失败只记录错误（`SavedImageRecord.error`），其它继续。
- **不做沙箱**：`--save-image` 是用户显式授权（等价 `curl -o`），只做基本非空校验与路径归一化。
- 扩展名优先级：`mimeType` → URL 扩展名 → `.png` 兜底。

### 5) `tachu chat` 的 `/draw`

- `/draw <prompt>` / `/text-to-image` / `/text2image` 触发 `capabilityMapping.text-to-image`。
- 支持显式 `--save <path>` / `--save=<path>`（含带空格的引号路径）；
- 无显式 flag 时从**提示词尾部**启发式提取「保存到 / 存为 / 写入 / save to / output to」+ 看起来像文件路径的 token；
- 两种方式都复用 `saveGeneratedImages`，命中后从 `ChatResponse.images` → `EngineOutput.metadata.generatedImages`
  取列表。

### 6) 隐式文生图意图识别（`detectTextToImageIntent`）

实际场景里，用户常常**不打** `/draw` 就直接说「生成一只橘猫，保存到 /tmp/cat.png」。若只走
Intent → Planning 路线，会被判为 `complex` 后进入 `tool-use` 循环（gpt-4o + 24 工具池里并没有文生图工具），
最终在 60 秒 LLM 超时后落到 `output` 阶段的兜底文案「您可以去用 DALL-E / Midjourney」——典型的工具错配。

为此 CLI 交互层（`interactive.ts` + `ink-interactive-chat.tsx`）在**普通 chat 输入**前加一层本地
零成本启发式 `detectTextToImageIntent(line)`，命中即走 `/draw` 同款 `buildTextToImageInputEnvelope`：

| 来源 | 触发条件 | 典型命中 |
|------|----------|----------|
| `slash` | 显式 `/draw` / `/text-to-image` / `/text2image` | `/draw 橘猫 --save /tmp/cat.png` |
| `heuristic-path` | 尾部「保存到 X.png」且扩展名 ∈ `IMAGE_EXTENSIONS`（png/jpg/jpeg/webp/gif/bmp/svg/tif/heic/avif/ico/...） | `生成一只橘猫，保存到 /tmp/cat.png` |
| `heuristic-keyword` | 中/英「动词 + ≤30 字 + 图像名词」正则同句命中 | `画一幅水彩插画` / `draw a cat picture` |

**反例**（明确**不**命中）：
- `写一首关于小猫的诗` — 纯文本需求
- `把今天的会议纪要，保存到 /tmp/notes.txt` — 扩展名非图像
- `生成一个脚本，保存到 /tmp/build.sh` — 扩展名非图像
- `解释一下 Node.js 的事件循环` — 无动词-名词对

命中时 CLI 在输出里追加一条 `[tachu] 识别为文生图请求（heuristic-path / heuristic-keyword）` 提示，
避免用户误以为走了普通 chat；显式 `/draw` 路径不打印该提示。

### 7) 非目标

- 不支持 S3 / OSS 等远端协议上传（可在 CLI 之外用宿主脚本完成）。
- 不支持按 HTTP Content-Type 再次校验 MIME（目前相信 provider 元数据与 URL 后缀；若不匹配仍能落盘）。
- 不做缩略图 / 压缩；落盘即原始字节。

## 后果

- **正**：CLI 文生图从「文字回报」升级到「字节落盘 + 结构化 metadata」，复用一套 `GeneratedImage` 契约贯穿
  provider → 引擎 → CLI；Qwen `wan2.x-image` 正确走 multimodal-generation 端点，错误消息消失。
- **负**：文生图路径**强制非流式**，对人类感知的响应延迟略高（等完整响应才显示）；但文生图任务本身就是一次性返图，
  非流式更符合实际语义。

## 参考实现（代码路径）

| 能力 | 路径 |
|------|------|
| 核心类型 | `packages/core/src/types/io.ts`、`packages/core/src/modules/provider.ts` |
| Qwen 适配器 | `packages/extensions/src/providers/qwen.ts` |
| `direct-answer` 透传 | `packages/core/src/engine/subflows/direct-answer.ts`、`.../subflows/registry.ts` |
| 引擎聚合 | `packages/core/src/engine/engine.ts`（`activeRunGeneratedImages`） |
| CLI 落盘工具 | `packages/cli/src/utils/save-generated-images.ts` |
| `run --save-image` | `packages/cli/src/commands/run.ts` |
| `/draw --save` 与启发式 | `packages/cli/src/utils/text-to-image-slash-command.ts` |
| 交互式集成 | `packages/cli/src/interactive.ts`、`packages/cli/src/ui/ink-interactive-chat.tsx` |
