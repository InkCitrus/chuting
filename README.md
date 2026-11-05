# 初听 · 音乐初听日历

每首歌，都有第一次响起的那天。

「初听」把网易云「回忆坐标」里的初听时间找回来，排成一条可以翻看的时间线。档案只留在你这台设备上：本机 SQLite，或 Cloudflare 上的浏览器存储。

## 能做什么

- **时间线**：按月、按日排开，精确到分钟；最新在前或从头讲起，都能跳。
- **搜索**：歌名、歌手，跨所有月份。
- **歌曲详情**：初听那天几点、听了多少遍、专辑封面；点一下就能放歌。
- **同步**：网页默认只翻「我喜欢的音乐」；最近播放、排行、歌单、历史报告想开就开。随时停，下次接着来。
- **备份**：JSON / CSV，换设备时带走。
- **浅色 / 深色**：跟着系统走，手机也顺手。

## Cloudflare 版

页面和只读代理跑在 Cloudflare，歌和进度存在当前浏览器。关掉页面就停，下次打开接着同步；换浏览器时用 JSON 备份。

```sh
npm ci
cp .dev.vars.example .dev.vars
# SESSION_SECRET 换成至少 32 字符的随机串
npm run dev:cloudflare
```

打开 <http://127.0.0.1:8787>，扫一下网易云 App，或在设置里导入备份。同步大约每秒十几首，顺畅时会自己再快一点。

部署到 Workers 或 Pages 的步骤见 [Cloudflare 说明](docs/CLOUDFLARE.md)。合并到 `main` 后，GitHub Actions 会测完再发到 Cloudflare Pages：<https://chuting.inkorange.com>。

## 本机版

需要 macOS 或 Linux、Python 3.9+（带时区数据）、Node.js 22+。

```sh
git clone https://github.com/InkCitrus/chuting.git
cd chuting
npm ci --ignore-scripts
npm start
```

打开 <http://127.0.0.1:8767>。macOS 也可以直接双击 `start.command`，第一次会自己装依赖。

### 登录

- **macOS**：先在官方网易云客户端登好，「初听」只读沿用它的登录状态。
- **其他系统**：用环境变量 `NETEASE_COOKIE` 提供 Cookie。应用不会自动读 `.env`。

登录只在同步时用；已经落下来的档案，离线也能翻。

## 同步

网页右上角点「同步」，选这次查多少首。查过的会跳过；「全部未查询」就把剩下的一次做完。

也可以命令行（先关掉占用同一数据目录的网页服务）：

```sh
python3 -m music_calendar sync --limit 200                 # 查 200 首
python3 -m music_calendar sync --limit 0                   # 查完全部未查询的
python3 -m music_calendar sync --limit 200 --retry-empty   # 连「暂无记录」的也再问一遍
```

`--no-playlists` 跳过自建歌单。每次都会先找新歌；失败的下次重试，空结果满 30 天自动补，也可以勾选或加 `--retry-empty` 提前补。本机版一次一首。

## 数据放哪儿

默认在项目里的 `data/`（已被 Git 忽略）：

- `calendar.sqlite3`：账号、歌曲、初听时间、来源和同步进度。
- `raw/`：接口的原始响应。
- `session-tmp/`：运行时临时文件，不存 Cookie。

备份时先关掉程序，再复制整个 `data/`；跑着的时候别直接拷数据库文件。换目录或端口：

```sh
python3 -m music_calendar --data-dir /path/to/archive serve --port 8768
```

服务只听 `127.0.0.1`，同一个数据目录同时只能有一个进程在用。

## 开发

Python 标准库 + SQLite；Node 子进程只调白名单里的只读接口；前端是原生 HTML / CSS / JS，不用构建。上游依赖钉在 `4.41.1`。

```sh
npm test
node --check web/app.js
node --check music_calendar/provider.cjs
```

测试走模拟接口和临时库，不碰真实 Cookie。

[产品范围](docs/PRODUCT.md) · [接口验证](docs/API_FINDINGS.md) · [实现说明](docs/ARCHITECTURE.md)
