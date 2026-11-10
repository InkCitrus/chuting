# Cloudflare 本地优先版

## 数据放哪儿

| 内容 | 位置 |
| --- | --- |
| 页面、样式、同步器 | Workers Static Assets 或 Pages |
| 候选、初听、观测、最近响应、查询状态 | 浏览器 IndexedDB，按网易 UID 分开 |
| 历史扫描检查点 | 同一个 IndexedDB，跟着 JSON 备份走 |
| 网易登录 Cookie | 加密封进 HttpOnly / SameSite=Strict Cookie，线上加 Secure，7 天过期 |
| 会话加密密钥 | Cloudflare Secret `SESSION_SECRET` |

没有云数据库、对象存储或后台任务。代理处理完请求就把 Cookie 和响应丢掉，不写进 Cloudflare 存储。部署包只有 `web/` 和代理代码。

需要 HTTPS，以及带 IndexedDB 和 Web Locks 的新版浏览器。清站点数据或关掉隐私窗口，当地档案会一起走；应用会申请持久存储，换设备前记得「备份 JSON」。预览域名、生产域名、不同浏览器之间的数据互不相通。

## 本机预览

Node.js 22+。按 README 装好依赖、写好 `.dev.vars`，再：

```sh
npm run dev:cloudflare
```

打开 <http://127.0.0.1:8787>。不要提交 `.dev.vars`、真实 Cookie 或个人备份。

## Workers Static Assets

配置在 `wrangler.worker.jsonc`，`name` 可以改成自己的项目名：

```sh
npx wrangler login
npm run check:cloudflare
npm run deploy:cloudflare
npx wrangler secret put SESSION_SECRET --config wrangler.worker.jsonc
```

提示里填至少 32 字符的随机密钥。没设密钥时，页面还能导入和浏览本地档案，登录和代理返回 503。设好后刷新，用网易云 App 扫一下就行。

更新再跑一遍 `npm run deploy:cloudflare`。密钥别写进 `vars` 或 Git；换密钥会让已有登录失效，本地档案还在。

## Pages Functions

### GitHub Actions 自动发布

工作流 `.github/workflows/pages.yml`：各分支推送和 PR 都跑测试和构建；只有 `main` 的推送（或在 `main` 上手动跑）才发布。生产地址：`https://chuting.inkorange.com`。

仓库 Settings → Secrets and variables → Actions：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 目标账户的 Account → Cloudflare Pages → Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Pages 项目所属 Cloudflare 账户 ID |

第一次发布会检查 `chuting` 项目，并在 Cloudflare 里生成随机 `SESSION_SECRET`。之后的部署沿用已有密钥，不会每次把人踢下线。这个运行时密钥不进 GitHub、构建产物或日志。

`npm run build:pages` 从 `web/` 拷静态资源，并把 Functions 编到 `dist/pages/_worker.js/`。CI 只发 `dist/pages`，碰不到本机 `data/`、Cookie、备份或 `.dev.vars`。

授权配好后，合并到 `main` 就会测完再发；测挂了不发。Cloudflare 原生的 Git 自动部署可以关掉，免得建两遍。

### 手动发布

Pages CLI 不认自定义配置路径，所以根目录用标准的 `wrangler.jsonc`；Workers 的 npm 命令显式指另一份。

入口 `functions/api/[[path]].js` 复用同一套代理。`web/_routes.json` 只让 `/api/*` 进 Functions；`web/_headers` 写安全响应头，并让 `.js` / `.css` 每次重新验证（ETag 命中就 304），免得新旧模块混在一起。

离线：`web/sw.js` 同源 Service Worker。页面和模块网络优先，断网才用缓存；`npm run build:pages` 把内容哈希写进缓存名，新版本激活时清掉旧的。`/sw.js` 本身不缓存，`/api/*` 从不进缓存。档案在 IndexedDB 里，断网也能翻、也能搜。

封面直接从 `https://*.music.126.net` 加载（`?param=120y120` 等）；CSP 的 `img-src` / `connect-src` / `media-src` 只额外放这个域名。看过的封面 Service Worker 最多留 600 张。

## 播放

歌曲详情里的播放器走 `/api/netease` 的 `song_url`：Worker 带着完整登录 Cookie 请求 `song/enhance/player/url/v1`，先要 exhigh，拿不到或只有试听就退回 standard。会员账号能拿到完整音源；真没版权才标成试听或放不了。音频由浏览器直连 `*.music.126.net`（签名地址，几分钟过期），不经 Worker，也不进 Service Worker；没网时播放器关掉。

CSP 只放同源脚本。Pages 开了 Web Analytics 的话，关掉它的自动注入就行，别为了信标放宽 CSP。

首次建项目（已有的跳过）：

```sh
npx wrangler pages project create chuting --production-branch main
```

设密钥并部署：

```sh
npx wrangler pages secret put SESSION_SECRET --project-name chuting
npm run deploy:pages
```

项目名改成自己的时，连同 `wrangler.jsonc`、npm 命令和工作流一起改。预览环境可以在控制台单独设 Secret。Git 集成部署的构建命令是 `npm run build:pages`，输出 `dist/pages`；Functions 用配置里的 `nodejs_compat`。

本地验 Pages：

```sh
npx wrangler pages dev web --port 8788
```

## 把本机档案迁过来

旧的「导出 JSON」只有有效初听，可以直接导入。想连空结果、失败和待查的一起带走：

```sh
python3 scripts/export_browser.py --data-dir data --output exports/chuting-browser-backup.json
```

脚本用只读 SQLite 快照，不改原档案，也不覆盖已有文件。在新页面设置里「导入档案」选这个文件——内容只在浏览器里解析，不上传到代理。`data/raw/` 还留在本机；迁移文件带候选状态和时间观测，不复制原始响应。

浏览器「备份 JSON」带上全部候选、事实、观测、最近响应和检查点；CSV 只导出有效初听。导入先校验整份文件再写，按账号和歌曲 ID 去重，已有事实和不同时间观测都留着。单文件上限 25 MB。

## 同步怎么跑

- 默认只翻「我喜欢的音乐」，从最近喜欢的开始往回。最近播放、排行、自建歌单、历史月榜和年度报告在设置里单独开。
- 初听时间来自 `music_first_listen_info`（一次一个 songId）；其他来源只用来发现更多歌。前 100 首的歌名和封面先取，其余和初听查询并行。
- 8 条通道共用一个发起间隔：约 120ms 起步（或上次跑顺的值），顺畅就逐步收到 67ms（约每秒 15 次）；限流或风控就把间隔乘 3 并冷却，学到的速度记在 `localStorage` 的 `chuting-pace`。
- 历史扫描从听歌足迹最早年份起，或手动指定 2017 年以来的起点；逐月扫到本月，再查年度报告。月榜、报告里的 `songId` 只当候选。
- 扫过的月份和年报会记检查点：当月 1 天内、更早的 30 天内跳过；失败的下次再补。
- 每首歌单独落盘。第一次拿到的时间用来显示，其他时间留作观测；空结果不会抹掉已知事实。
- 网络、408、临时 5xx 最多重试 2 次。301/401/403/429/460 立刻停；连续 3 首失败也停。Web Locks 保证同账号不会两个标签页一起同步；关掉再开会标成中断，可以接着来。

本机 Python 版一次一首，同样有本周排行、临时错误重试和空结果自动补查。

## 验证

```sh
npm test
npm run check:cloudflare
npx wrangler pages functions build --outdir dist/pages-functions --compatibility-date 2026-11-03 --compatibility-flag nodejs_compat
```

测的是加密、会话、跨站拒绝、UID 绑定、并发写入、去重和冲突、导入、限流、暂停恢复和历史检查点。真实网易接口最好在本地 Workers 和最终域名各验一遍。

关掉页面就停；档案不自动跨设备。

参考：[Workers 静态资源](https://developers.cloudflare.com/workers/static-assets/)、[Pages 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)、[Pages 命令](https://developers.cloudflare.com/workers/wrangler/commands/pages/)、[Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。

## 省请求与备用代理

免费版 Workers 每天 10 万次请求（UTC 0 点重置），页面因此尽量少打 Functions：

- 初听信息一次请求问最多 20 首（`music_first_listen_batch`，代理里仍是每首单独、只用这个账号的会话去问网易）。1000 首喜欢的歌首次同步约 70 次请求，之前约 1020 次。
- `/api/runtime` 的结果在本机记 12 小时；`login_status` 一天最多问一次（每次 `/api/netease` 本来就核对账号）。
- 只有和账号无关的目录数据进边缘缓存（`caches.default`，键里没有 Cookie、uid 或会话）：`song_detail`（裁剪后的歌名、歌手、专辑封面，1 天；含云盘上传的批次不缓存）和 `artist_search`（7 天）。初听、喜欢列表、听歌排行、歌单、播放地址、登录状态从不缓存。

额度用完（1027 页面或 fail-open 的静态页）、限流（429）、5xx，或网易对 Cloudflare 出口返回 -460/-462 时，页面会切到备用代理，过 5、10、20… 分钟（最多 1 小时）再试 Cloudflare。每个浏览器按本地随机 id 固定用其中一台，挂了换另一台。全都不可用时显示「现在使用的人有点多，进度已保存，稍后会自动继续」，已查到的都在本机，2–30 分钟后自动接着同步。

备用代理是 `server/proxy.mjs`：同一套 `handleApi` 跑在 Node 22 上，不存、不记任何请求。跨域不带 Cookie：Functions 在 `/api/auth/status` 和登录结果里给页面一个 relay token（同一份会话用 `SHARED_SESSION_SECRET` 封装、同样的过期时间），页面只把它放在发给备用代理的 `Authorization` 头里。

启用需要：

| 位置 | 名称 | 内容 |
| --- | --- | --- |
| Pages 项目 Secret | `SHARED_SESSION_SECRET` | 至少 32 字符的随机串，和备用代理相同。设好后新会话用它封装，旧会话继续可用 |
| GitHub Actions 变量 | `CHUTING_FALLBACK_ORIGINS` | 逗号分隔的 https 源，构建时写进 `transport.js` 和 CSP 的 `connect-src` |
| 备用代理环境 | `SHARED_SESSION_SECRET`、`PUBLIC_ORIGIN`、`ALLOWED_ORIGINS` | 见 `server/proxy.mjs` 开头 |

不设 `CHUTING_FALLBACK_ORIGINS` 时行为和以前一样，只走 Functions。
