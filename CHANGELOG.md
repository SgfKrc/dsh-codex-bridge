# Changelog

本仓库是 **dsh-codex-bridge** —— DSH 侧的 Reasonix DeepSeek worker 桥接器（PATCH-ONLY bundle）。

它把 `reasonix-codex-bridge` 里那套已经跑通的 MCP stdio 服务**连同测试一起 vendor 进来**，
因此 DSH 侧可以独立装配、独立自验，不依赖工作区里另一个仓库目录。

## [0.1.0] - 2026-09-20

### Added

- 首次发布：`cordis.patch.yml` 模板，声明两个角色互斥通道
  （`reasonix-mcp-read` / `reasonix-mcp-write`），路径与模型引用均为占位符。
- 从 `reasonix-codex-bridge@987ed9bbf999e4ba9b18d8267065fbccd58753bc` vendor：
  `src/`（12 个模块，MCP server 及其全部内部依赖）、`test/`（`node --test` 套件）、
  `scripts/check-readme-links.mjs`、`scripts/acp-acceptance.mjs`、`prompts/`、`LICENSE`（MIT）。
- `scripts/sync-vendor.mjs` 与 `VENDOR.json`：从上游同步 vendor 文件并记录上游 commit 与逐文件 sha256。
- `README.md` 增加「占位符与本机配置」一节，说明 dsh 的 patch 覆盖是整体替换 `config`。
