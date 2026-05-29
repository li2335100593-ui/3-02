# 项目交付说明 - 自动轮播 URL 调度与工时审计系统

**更新日期**: 2026-05-29
**项目状态**: 核心记录链路、运行健康、告警、主动巡检、CI 和备份基础设施已补齐。

## 生产交付物

```text
scheduler.html            入口调度页
carousel.js               轮播 SDK，嵌入客户页面
operator-report.html      工时审计、站点统计、运行健康、告警与巡检面板
worker/                   Cloudflare Worker + D1 schema/migrations
tests/                    SDK 回归测试
tools/player-health-monitor.mjs 生产巡检 + Server酱通知脚本
.github/workflows/        CI、生产巡检、D1 备份、手动 Worker 部署
```

## 当前生产地址

- 管理面板: https://li2335100593-ui.github.io/3-02/operator-report.html
- Worker API: https://exposure-analytics.li2335100593.workers.dev
- 轮播 SDK: https://li2335100593-ui.github.io/3-02/carousel.js

## 工程化能力

- SDK heartbeat 附带版本、队列长度、可见状态、轮播 slot、flush 状态。
- Worker 维护 `player_status`，快速判断播放端是否在线、当前站点、最后心跳和离线队列。
- Worker 维护 `monitor_targets`，只有启用监控的 UID/任务会触发离线告警，避免历史测试数据误报。
- Worker 维护 `alert_events`，记录心跳超时、预期站点缺失、离线队列过大、flush 失败和通知状态。
- 管理面板新增“运行健康”和“告警 / 巡检”区，可查看告警历史、确认告警、启停监控目标。
- GitHub Actions 新增 CI、每 5 分钟生产巡检、每日 D1 备份、手动 Worker 部署。
- Server酱通知通过 `SERVERCHAN_SENDKEY` 注入，不在仓库保存密钥。

## GitHub Secrets / Variables

必填 Secrets:

```text
REPORT_USER
REPORT_PASS
SERVERCHAN_SENDKEY
CLOUDFLARE_API_TOKEN
```

建议 Variables:

```text
MONITOR_REQUIRED_UIDS=SOAK_20260529_24H_NET_QUEUE
MONITOR_REQUIRED_URLS=https://livingroom-design.ddmmoney.com/,https://old-house-renovation.chworld.com.tw
MONITOR_NOTIFY_REPEAT_MINUTES=60
```

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
npx wrangler d1 execute exposure_analytics --remote --file=sql/migration_006_monitoring_notifications.sql
npx wrangler deploy
```

前端通过 GitHub Pages 发布，提交并推送 `main` 后生效。

## 生产巡检命令

```bash
REPORT_USER='client_view_20260529' \
REPORT_PASS='View-20260529-GAM!' \
SERVERCHAN_SENDKEY='SCT...' \
MONITOR_REQUIRED_UIDS='SOAK_20260529_24H_NET_QUEUE' \
MONITOR_REQUIRED_URLS='https://livingroom-design.ddmmoney.com/,https://old-house-renovation.chworld.com.tw' \
node tools/player-health-monitor.mjs --once
```

## 运维判断标准

- `online`: 最近 2 分钟内有事件。
- `warning`: 超过 2 分钟没有事件，或队列偏大，或明确 flush 失败。
- `offline`: 超过 5 分钟没有事件，或离线队列接近上限。
- `open_alerts = 0`: 当前没有需要人工处理的异常。
- `monitor_targets.is_enabled = 1`: 该 UID 是正式需要巡检的目标。

## 已知边界

- 操作系统低电量、省电模式、强制休眠会影响浏览器 timer 和 Wake Lock。
- 如果某个目标页面完全打不开，轮播无法在该页面继续执行脚本，需要站点本身可访问。
- 旧版页面未带 SDK 版本和队列字段时，健康面板仍可判断在线和站点，但版本/队列显示为空。
