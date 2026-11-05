# Cloudflare 本地优先版

## 数据与运行方式

| 内容 | 位置 |
| --- | --- |
| 页面、样式、同步器 | Workers Static Assets 或 Pages |
| 候选、初听事实、差异观测、最近原始响应、查询状态 | 浏览器 IndexedDB，按网易 UID 隔离 |
| 历史扫描检查点 | 同一个 IndexedDB，随 JSON 备份迁移 |
| 网易登录 Cookie | 加密封装进 HttpOnly / SameSite=Strict Cookie，线上加 Secure，7 天过期 |
| 会话加密密钥 | Cloudflare Secret `SESSION_SECRET` |

没有云数据库、对象存储或后台任务。代理只在处理当前请求时使用 Cookie 和响应，不写入 Cloudflare 存储、不记录 Cookie 或请求体。部署包只包含 `web/` 和代理代码，不包含 `data/` 或个人备份。

需要 HTTPS、新版浏览器的 IndexedDB 和 Web Locks。清除网站数据、关闭隐私窗口或存储被回收会丢失当地档案。应用会申请持久存储，仍应定期「备份 JSON」。预览域名、生产域名与不同浏览器的数据相互独立。

## 本机预览

Node.js 22+，执行 README 中的 `npm ci` 和 `.dev.vars` 配置，然后 `npm run dev:cloudflare`。访问 <http://127.0.0.1:8787>。不要提交 `.dev.vars`、真实 Cookie 或个人 JSON。

## Workers Static Assets 部署

配置文件为 `wrangler.worker.jsonc`，可先把 `name` 改成自己的项目名：

```sh
npx wrangler login
npm run check:cloudflare
npm run deploy:cloudflare
npx wrangler secret put SESSION_SECRET --config wrangler.worker.jsonc
```

在最后一个交互提示中输入至少 32 字符的安全随机密钥。未设置密钥时，页面仍可导入、浏览本地档案，登录和代理返回 503。设置后刷新页面，用网易云 App 扫码确认登录。

更新时重新执行 `npm run deploy:cloudflare`。不要将密钥写入 `vars` 或 Git；更换密钥会让已有登录失效，本地档案不会受影响。

## Pages Functions 部署

### GitHub Actions 自动发布

工作流 `.github/workflows/pages.yml` 在各分支推送和 PR 中运行测试并构建；只有 `main` 的推送或在 `main` 手动运行时才发布。生产地址为 `https://chuting.inkorange.com`。

仓库 Settings → Secrets and variables → Actions 中配置：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 仅授予目标账户的 Account → Cloudflare Pages → Edit 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Pages 项目所属 Cloudflare 账户 ID |

首次发布会检查 `chuting` 项目，并在 Cloudflare 中生成随机 `SESSION_SECRET`。后续部署保留已有密钥，不会每次令用户退出登录。此运行时密钥不进入 GitHub、构建产物或日志。

`npm run build:pages` 仅从 `web/` 复制静态资源，并把 Functions 编译到 `dist/pages/_worker.js/`。CI 发布整个 `dist/pages`，不会读取或上传本机 `data/`、Cookie、个人备份或 `.dev.vars`。

配置好授权后，每次将改动合并到 `main` 就会自动测试、构建并发布；测试失败不发布。Cloudflare 原生 Git 自动部署可以保持关闭，避免重复构建。

### 手动发布

Pages CLI 不支持自定义配置路径，因此使用根目录的标准 `wrangler.jsonc`；Workers 的 npm 命令已显式指定另一份配置。

入口 `functions/api/[[path]].js` 复用相同代理。`web/_routes.json` 只让 `/api/*` 进入 Functions，`web/_headers` 设置静态资源安全响应头。

首次创建项目（已有项目跳过）：

```sh
npx wrangler pages project create chuting --production-branch main
```

设置密钥并部署：

```sh
npx wrangler pages secret put SESSION_SECRET --project-name chuting
npm run deploy:pages
```

把 `chuting` 换成自己的项目名时，同时修改 `wrangler.jsonc`、npm 命令和工作流。预览环境可在控制台设置独立 Secret。Git 集成部署的构建命令是 `npm run build:pages`，输出目录为 `dist/pages`；Functions 使用配置中的 `nodejs_compat`。

本地验证 Pages：

```sh
npx wrangler pages dev web --port 8788
```

## 迁移 SQLite 档案

旧的「导出 JSON」只包含有效初听记录，可以直接导入。要保留空结果、失败和待查询候选，生成完整迁移文件：

```sh
python3 scripts/export_browser.py --data-dir data --output exports/chuting-browser-backup.json
```

脚本使用只读 SQLite 快照，不修改原档案，拒绝覆盖已有文件。在新页面页底「导入档案」选择生成文件，内容只在浏览器解析，不上传到代理。原 `data/raw/` 继续作为本机证据保存；迁移文件包含全部候选状态和时间观测，不复制原始响应文件。

浏览器「备份 JSON」包含全部候选、事实、观测、最近原始响应和检查点；CSV 只导出有效初听记录。导入先校验整个文件再写入，按账号和歌曲 ID 去重，保留已有事实和不同时间观测。单文件上限 25 MB。

## 抓取改进

- 同时查询 1 或 2 首，两条通道及重试共用 650ms 发起间隔。网络较慢时可以重叠等待，不保证速度翻倍。
- 候选来自最近播放、累计排行、本周排行、喜欢的歌曲和自建歌单。只有 ID 的歌曲批量补充名字。
- 历史扫描自动从听歌足迹最早年份开始，或手动指定 2017 年以来的起点。逐月扫描到本月，再查年度报告。
- 月榜、报告中的明确 `songId` 只作为候选；`firstDate`、月榜日期和次数都不能生成初听事实。
- 成功扫描后保存检查点：当月 1 天内、历史月份和年度报告 30 天内跳过。失败来源不会标记成功，下次继续补查，并在任务状态中提示。
- 每首使用独立 IndexedDB 事务提交。首次采集到的时间作为显示版本，其他时间保留为差异观测；空结果不能删除已知事实。
- 网络、408 和临时 5xx 最多重试 2 次，等待 2 秒、4 秒。301/401/403/429/460 立即停止；连续 3 首失败也停止。等待已发出的请求落盘后再保存最终状态。
- 已有有效事实跳过。空结果满 30 天自动补查，也可显式提前补查。Web Locks 防止同账号多个标签页同时同步；关闭后重新打开会标记上次中断，可手动继续。

月榜只有 Top20，年度报告也只包含部分歌曲。扩大候选范围可以提高覆盖，无法证明完整还原了所有历史播放。本机 Python 版保留串行，但也增加本周排行、临时错误重试和空结果自动补查。

## 验证

```sh
npm test
npm run check:cloudflare
npx wrangler pages functions build --outdir dist/pages-functions --compatibility-date 2026-11-03 --compatibility-flag nodejs_compat
```

测试覆盖加密与固定上游版本的一致性、会话校验、跨站拒绝、UID 绑定、并发写入、去重和冲突、导入原子性、限流、暂停恢复和历史检查点。真实网易接口需在本地 Workers 运行时和最终部署域名分别验证，本地可用不代表 Cloudflare 出口不会被上游限制。

这是无需云数据库的多用户自助工具。页面关闭后不继续后台抓取，不自动跨设备同步。

参考：[Workers 静态资源](https://developers.cloudflare.com/workers/static-assets/)、[Pages 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)、[Pages 命令](https://developers.cloudflare.com/workers/wrangler/commands/pages/)、[Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。
