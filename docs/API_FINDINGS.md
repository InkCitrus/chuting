# 接口验证记录

验证日期：2026-11-04（Asia/Shanghai）。账号侧都是只读查询。

上游：[NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，钉在 `984cc021b8598cf94c22134f32a8426887fb2de7`。

## 初听：/music/first/listen/info

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/music_first_listen_info.js)

参数：`id`。上游路径：`/api/content/activity/music/first/listen/info`。

实测两首：一首空 `data`，一首带回初听日期、累计次数和听得最多的那天。

关键字段：

- `data.musicFirstListenDto.listenTime`：初听 Unix 毫秒。
- `data.musicFirstListenDto.date`：对应日期时间字符串。
- `data.musicTotalPlayDto.playCount`：累计播放次数。
- `data.musicPlayMostDto.timestamp`、`mostPlayedCount`：听得最多的那天及次数。

这是首期的核心数据源。一次一个 songId，不能靠它枚举听过的全部歌。

## 近期播放：/record/recent/song

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/record_recent_song.js)

上游 `/api/play-record/song/list`，有 `data.list[].playTime`（毫秒）。本账号 `limit=10` 和 `limit=1000` 都是同样的 300 条、300 个不同歌曲 ID。没找到更早的分页。

## 今日歌曲：/listen/data/today/song

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/listen_data_today_song.js)

上游 `/api/content/activity/listen/data/today/song/play/rank`。实测 7 首；`data.songDTOs[].lastPlayTime` 是 Unix **秒**，和近期接口的毫秒不一样。每首歌只给一个最近时间。

## 月榜：/listen/data/song/play/rank

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/listen_data_song_play_rank.js)

支持 `type` 和 `endTime`。实测能取到 2024 年 12 月的榜，20 首和对应 `playCount`；没有逐次播放时间。

## 年报：/summary/annual

[模块源码](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/984cc021b8598cf94c22134f32a8426887fb2de7/module/summary_annual.js)

实测 `year=2024` 有年报：年度歌曲、月份分布、`latePlayDTO.datetime` 等精选事件。年报里的 `annualSong.firstDate` 和回忆坐标的初听时间在样本里对不上，不当同一条事实用。

## 年度足迹与周报

- `/listen/data/year/report`：实测有 2019、2023、2024、2025 的年度汇总。
- `/listen/data/report?type=year&endTime=...`：2024 年请求成功，但 `listenTimeBlock=null`。
- `/vip/timemachine`：实测 43 份周报，2025-11-02 至 2026-10-31；歌曲是部分样本。
- `/user/record?type=0`：实测 100 首排行，没有逐次时间。
- `/recent/listen/list`：这次返回的是歌单资源，不是歌曲事件。

## 小结

初听日历已经有可用数据源。目前还没找到能按任意日期翻页、盖住账号整段听歌史、又保留同歌每一次重播时间的现成接口。

不提交账号 Cookie、个人播放响应、完整年报或本机数据库。实现上会限速、断点续采、原始响应本地留存，并核对来源字段。
