# 初听 · 音乐收听日历

在月历上查看每天第一次听到的歌曲，点击日期查看按分钟排列的曲目与详情。

第一版以网易云音乐“回忆坐标”首次播放时间建立档案。保存毫秒原始时间戳，以北京时间显示到分钟。**首次播放日历不等于当天所有收听记录。**

## 启动

需要 macOS / Linux、Python 3.9+（含时区数据）、Node.js 22+。

```sh
git clone https://github.com/InkCitrus/netease-listening-archive.git
cd netease-listening-archive
npm ci --ignore-scripts
npm start
```

打开 http://127.0.0.1:8767 。macOS 也可双击仓库内的 `start.command`，首次启动会安装固定版本的接口依赖。

macOS 默认只读复用官方网易云音乐客户端的登录态。其他环境可通过 `NETEASE_COOKIE` 环境变量提供自己的有效 Cookie；不需要写进代码。应用不自动读取 `.env`。已采集的数据可以离线浏览，不依赖登录继续有效。

## 功能

- 月份切换、日期选择、跨月份搜索歌名或歌手。
- 每日曲目按首次播放时间排列，显示歌名、歌手和 `HH:mm`。
- 歌曲详情展示原始时间戳、来源、累计次数与时间冲突。
- 从近期播放、累计排行、喜欢的歌曲及自己创建的歌单发现候选歌曲。
- 分批或全部采集、暂停、断点续采、重试失败和重新查询空结果。
- 展示候选总数、已查询数、有效首次时间、空结果和失败数量。
- JSON / CSV 导出，保留原始毫秒时间戳和时区。

## 采集

点击“采集歌曲”选择本批数量。已归档歌曲会跳过；“全部待查询歌曲”会处理所有剩余候选。请求串行执行，在请求间隔约 0.9 秒。

也可用命令行，先关闭使用同一数据目录的网页服务：

```sh
python3 -m music_calendar sync --limit 200
python3 -m music_calendar sync --limit 0
python3 -m music_calendar sync --limit 200 --retry-empty
```

`--no-playlists` 跳过我的歌单。每次采集会重新发现新增候选。失败歌曲下次采集重试；空结果需勾选重查或加 `--retry-empty`。

## 本地存储

默认 `data/` 目录已被 Git 忽略：

- `calendar.sqlite3`：账号、候选、首次时间、来源、冲突与进度。
- `raw/`：首次播放接口的原始响应，用于复核。
- `session-tmp/`：运行临时文件，不保存登录 Cookie。

关闭程序后备份整个 `data/` 目录；运行时应使用 SQLite 在线备份，不能只复制正在写入的主数据库文件。

```sh
python3 -m music_calendar --data-dir /path/to/archive serve --port 8768
```

应用仅监听 `127.0.0.1`，同一数据目录只允许一个网页或 CLI 进程运行。

## 数据边界

候选列表的并集不保证包含账号曾听过的所有歌曲。接口空结果也不表示从未收听。累计次数不会展开为伪造事件；重复采集不增加首次播放条目。不同时间版本保留供核对，日历显示最早采集到的版本。

后续每次重播需要接入可靠的播放事件或已有日志，当前没有验证到可导出账号终身逐次流水的接口。

## 开发

Python 标准库 + SQLite，Node 子进程调用只读接口白名单，前端无构建依赖。接口包固定为 `4.41.1`，完整性见锁文件。

```sh
npm test
node --check web/app.js
node --check music_calendar/provider.cjs
```

测试使用模拟接口与临时数据库，不读取真实 Cookie。HTTP 用例使用临时本机端口。

[产品范围](docs/PRODUCT.md) · [接口验证](docs/API_FINDINGS.md) · [实现说明](docs/ARCHITECTURE.md)
