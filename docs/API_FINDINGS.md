# 接口验证记录

验证日期：2026-11-04（Asia/Shanghai）。所有账号测试均为只读查询。

上游仓库：[NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)。本次固定版本：`984cc021b8598cf94c22134f32a8426887fb2de7`。

## 首次收听：/music/first/listen/info

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/music_first_listen_info.js)

参数：`id`。上游路径：`/api/content/activity/music/first/listen/info`。

实测：两首歌曲中，一首返回空 `data`，一首返回有效首次收听日期、累计次数和高频收听信息。

关键字段：

- `data.musicFirstListenDto.listenTime`：首次收听 Unix 毫秒时间戳。
- `data.musicFirstListenDto.date`：对应日期时间字符串。
- `data.musicTotalPlayDto.playCount`：上游返回的累计播放次数。
- `data.musicPlayMostDto.timestamp`、`mostPlayedCount`：播放最多的某一天及次数，不是那一天的每次播放事件。

这是首期的核心数据源。输入需要已知歌曲 ID，不能通过这个接口直接枚举所有曾经听过的歌曲。

## 近期播放：/record/recent/song

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/record_recent_song.js)

上游 `/api/play-record/song/list`，包含 `data.list[].playTime`（毫秒）。本账号 `limit=10` 和 `limit=1000` 都返回相同的 300 条记录、300 个不同歌曲 ID。未验证到更早历史的分页方法；不能视为完整逐次流水。

## 今日歌曲：/listen/data/today/song

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/listen_data_today_song.js)

上游 `/api/content/activity/listen/data/today/song/play/rank`。实测 7 首歌曲，字段 `data.songDTOs[].lastPlayTime` 为 Unix **秒**时间戳，与近期接口的毫秒单位不同。

每首歌只提供一个最近时间；不能重建同一天内的所有重播。

## 月榜：/listen/data/song/play/rank

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/listen_data_song_play_rank.js)

支持 `type` 和 `endTime`。实测能取到 2024 年 12 月的歌曲榜，返回 20 首和对应 `playCount`；没有逐次播放时间。

## 年报：/summary/annual

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/summary_annual.js)

实测 `year=2024` 返回有效年报，包含年度歌曲、月份分布及 `latePlayDTO.datetime` 等精选事件。不能将年报的日期和高光事件解读为完整流水；同歌的 `annualSong.firstDate` 与回忆坐标的首次时间在本次样本中有差异，不能直接合并为同一个事实。

## 年度足迹与周报

- `/listen/data/year/report`：实测返回 2019、2023、2024、2025 年的年度汇总，证明存在比近期窗口更早的统计数据。
- `/listen/data/report?type=year&endTime=...`：2024 年请求成功但 `listenTimeBlock=null`，不据此推断完整年报内容。
- `/vip/timemachine`：实测 43 份周报，2025-11-02 至 2026-10-31；歌曲为部分样本。
- `/user/record?type=0`：实测 100 首排行，不含逐次时间。
- `/recent/listen/list`：本次返回歌单资源，不是歌曲事件列表。

## 结论与边界

首次收听日历已有可用数据源。当前未找到并验证支持按任意日期翻页、覆盖账号全生命周期、保留同歌全部重播时间的现成接口。保留这一不确定性，不能把没有搜索到接口表述为服务器不存在数据。

不提交账号 Cookie、个人播放响应、完整年报或本机数据库。首期实现需要限速、断点续采、原始响应本地留存和来源字段验证。
