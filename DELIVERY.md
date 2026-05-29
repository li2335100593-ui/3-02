# 项目交付说明 - 自动轮播 URL 调度与工时审计系统

**更新日期**: 2026-05-29
**项目状态**: 核心记录链路可用，已补齐运行健康、告警和生产监控基础设施。

## 生产交付物

```text
scheduler.html            入口调度页
carousel.js               轮播 SDK，嵌入客户页面
operator-report.html      工时审计、站点统计、运行健康与告警面板
worker/                   Cloudflare Worker + D1 schema/migrations
tests/                    SDK 回归测试
tools/player-health-monitor.mjs 生产健康监控脚本
```

## 当前生产地址

- 管理面板: https://li2335100593-ui.github.io/3-02/operator-report.html
- Worker API: https://exposure-analytics.li2335100593.workers.dev
- 轮播 SDK: https://li2335100593-ui.github.io/3-02/carousel.js

## 工程化补强

- SDK heartbeat 附带版本、队列长度、可见状态、轮播 slot、flush 状态。
- Worker 维护 `player_status`，快速判断播放端是否在线、当前站点、最后心跳和离线队列。
- Worker 维护 `alert_events`，记录心跳超时、离线队列过大、flush 失败。
- 管理面板新增“运行健康”区，播放员列表直接显示在线/告警/离线状态。
- 新增 D1 migration: `worker/sql/migration_005_player_health_alerts.sql`。
- 新增 `tools/player-health-monitor.mjs`，可用于 cron/自动化平台定时验证生产健康。

## 已验证能力

- 两站点轮播工时会进入同一个播放员会话，并在站点明细里分别展示。
- 30 秒 heartbeat 作为工时来源；因此两小时理论值会接近 `1小时59分/2小时`，这是 30 秒粒度和会话边界导致的正常舍入。
- 网络中断期间事件进入本地队列，恢复后自动 flush；24 小时离线容量回归测试通过，队列长度为 2882，低于 5000 上限。
- 页面后台/隐藏时不主动结束会话；只要浏览器 timer 继续执行，heartbeat 继续记录。
- 生产 `/api/player-health` 已验证可返回在线播放端、今日覆盖站点和 open alerts。

## 验证命令

```bash
node --check worker/src/index.js
node --check carousel.js
awk '/^<script>$/{flag=1;next} /^<\/script>$/{flag=0} flag' operator-report.html > /tmp/operator-report-main.js && node --check /tmp/operator-report-main.js
node --check tools/player-health-monitor.mjs
bash tests/run-carousel-tests.sh
```

## 生产部署命令

```bash
cd worker
npx wrangler d1 execute exposure_analytics --remote --file=sql/migration_005_player_health_alerts.sql
npx wrangler deploy
```

前端通过 GitHub Pages 发布，提交并推送 `main` 后生效。

## 生产监控命令

```bash
REPORT_USER='client_view_20260529' \
REPORT_PASS='View-20260529-GAM!' \
node tools/player-health-monitor.mjs --once
```

持续监控:

```bash
REPORT_USER='client_view_20260529' \
REPORT_PASS='View-20260529-GAM!' \
MONITOR_INTERVAL_SEC=60 \
node tools/player-health-monitor.mjs
```

## 运维判断标准

- `online`: 最近 2 分钟内有事件。
- `warning`: 超过 2 分钟没有事件，或队列偏大，或明确 flush 失败。
- `offline`: 超过 5 分钟没有事件，或离线队列接近上限。
- `open_alerts = 0`: 当前没有需要人工处理的异常。

## 已知边界

- 操作系统低电量、省电模式、强制休眠会影响浏览器 timer 和 Wake Lock。
- 如果某个目标页面完全打不开，轮播无法在该页面继续执行脚本，需要站点本身可访问。
- 旧版页面未带 SDK 版本和队列字段时，健康面板仍可判断在线和站点，但版本/队列显示为空。
