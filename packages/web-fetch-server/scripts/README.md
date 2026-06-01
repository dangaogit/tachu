# 脚本

在仓库根执行 `bun run --filter '@tachu/web-fetch-server' smoke` 可跑端到端 smoke：仅依赖本机 Bun，无需 Docker、无需外网；会短暂拉起 `scripts/smoke.fixture.ts` 与 `src/server.ts`，校验 `POST /v1/extract` 静态分支后退出并清理进程。
