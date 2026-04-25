# 自动轮播 URL 调度系统

纯前端的自动轮播 URL 调度系统。用户打开入口页后，系统自动在 12 个不同域名的客户页面之间每 5 分钟轮转一次，持续 60 分钟后循环。

## 快速开始

### 步骤 1: 部署 scheduler.html

将 `scheduler.html` 部署到您的服务器上，作为轮播的入口页面。

### 步骤 2: 在每个目标页面加入 carousel.js

在每个需要参与轮播的页面的 `<head>` 或 `<body>` 末尾加入以下代码：

```html
<script src="https://li2335100593-ui.github.io/3-02/carousel.js"></script>
```

### 步骤 3: 配置并打开入口页

在 `scheduler.html` 中配置您的 URL 列表和轮播参数，然后在浏览器中打开入口页即可开始自动轮播。

---

## 配置说明

### scheduler.html 中的配置

在 `scheduler.html` 的 `<script>` 标签上使用 `data-*` 属性配置轮播参数：

```html
<script 
  data-urls='["https://domain-a.com","https://domain-b.com","https://domain-c.com"]'
  data-interval="300"
  data-cycle="3600"
>
  // ... scheduler 代码 ...
</script>
```

#### 配置参数

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `data-urls` | JSON 数组字符串 | 所有目标 URL 列表（**必填**） | 无 |
| `data-interval` | 数字字符串 | 每个 URL 停留秒数 | `"300"`（5 分钟） |
| `data-cycle` | 数字字符串 | 总循环秒数（周期结束后重新开始） | `"3600"`（60 分钟） |

---

## 完整示例

### 客户页面集成示例

在每个参与轮播的页面中加入：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>客户页面</title>
  <!-- 其他内容 -->
</head>
<body>
  <!-- 页面内容 -->
  
  <!-- 在页面底部加入 carousel.js -->
  <script src="https://li2335100593-ui.github.io/3-02/carousel.js"></script>
</body>
</html>
```

### scheduler.html 配置示例

```html
<script 
  data-urls='[
    "https://domain-a.com/page1",
    "https://domain-b.com/page2",
    "https://domain-c.com/page3",
    "https://domain-d.com/page4",
    "https://domain-e.com/page5",
    "https://domain-f.com/page6",
    "https://domain-g.com/page7",
    "https://domain-h.com/page8",
    "https://domain-i.com/page9",
    "https://domain-j.com/page10",
    "https://domain-k.com/page11",
    "https://domain-l.com/page12"
  ]'
  data-interval="300"
  data-cycle="3600"
>
  // scheduler.html 中的内联 JavaScript 代码
</script>
```

---

## 工作原理

### URL Hash Fragment 跨域状态传输

系统使用 URL hash fragment（`#`后的部分）来传递跨域状态：

```
https://example.com#_ci=0&_ct=1709364781000&_iv=300&_cy=3600&_cu=WyJodHRwczovL2V4YW1wbGUuY29tIl0=
```

- `_ci`: 当前页面索引（0-based）
- `_ct`: 周期开始时间戳（毫秒）
- `_iv`: 每页停留秒数
- `_cy`: 总周期秒数
- `_cu`: URL 列表（Base64 编码的 JSON 数组）

### 自动跳转机制

- `carousel.js` 使用 `setInterval(1000)` + `Date.now()` 对比的 **timestamp-based 定时器**
- 计时起点为 `DOMContentLoaded` 事件触发时
- 自愈逻辑：每次页面加载时检查已过时间，如已超时立即跳转

### Screen Wake Lock 防息屏

- 主方案：使用 `navigator.wakeLock.request('screen')` 保持屏幕常亮
- 降级方案：silent video loop（当 Wake Lock 不可用时）
- 在 `visibilitychange` 事件返回 `'visible'` 时重新获取 Wake Lock

---

## 注意事项

### ⚠️ HTTPS 必需

Wake Lock API 需要**安全上下文**，因此所有页面必须使用 HTTPS 协议。HTTP 页面无法保持屏幕常亮。

### ⚠️ 所有页面都要加 carousel.js

**每一个**参与轮播的页面都必须引入 `carousel.js`。如果某个页面忘记加脚本，轮播链会在该页面中断。

### ⚠️ 不支持 SPA hash 路由

系统使用 URL hash 传递状态，因此不兼容已经使用 hash 路由（如 `#/home`, `#/about`）的单页应用（SPA）。

如果目标页面已有其他 hash 参数（非路由），carousel 会尝试与之合并，但无法保证完全兼容。

### ⚠️ 轮播链中断

如果用户：
- 手动后退/前进浏览器历史
- 刷新页面但 hash 丢失
- 访问未加入 carousel.js 的页面

轮播链会中断，需要重新打开 scheduler.html 重新开始。

---

## 浏览器兼容性

| 浏览器 | 最低版本 | 说明 |
|--------|----------|------|
| Chrome | 85+ | 完整支持（包括 Wake Lock） |
| Edge | 85+ | 完整支持 |
| Safari | 16.4+ | Wake Lock 从 16.4 开始支持 |
| Firefox | 126+ | Wake Lock 从 126 开始支持 |

**移动端浏览器：**
- iOS Safari 16.4+
- Chrome for Android 85+

---

## 已知限制

### 低电量/省电模式

在低电量或省电模式下，即使使用了 Wake Lock 和 silent video，屏幕仍可能自动息屏。这是操作系统级别的限制，无法通过前端技术完全绕过。

### 后台标签页定时器

如果用户切换到其他标签页，浏览器会限制后台标签的定时器执行频率，可能导致轮播延迟或暂停。

**建议：** 用户应保持轮播标签页始终在前台。

### 网络中断

如果某个页面加载失败（网络错误、404 等），轮播链会停止。系统不会自动重试或跳过失败页面。

---

## 技术栈

- **纯前端**：无后端、无数据库、无 API
- **零依赖**：Vanilla JavaScript，不依赖任何第三方库
- **轻量级**：scheduler.html + carousel.js 总大小 < 15KB

---

## 文件清单

```
├── scheduler.html       # 入口调度页（用户打开的第一个页面）
├── carousel.js          # 轮播 SDK（嵌入到每个目标页面）
└── README.md            # 本文档
```

---

## 故障排查

### 轮播未自动开始

1. 检查 `scheduler.html` 的 `data-urls` 配置是否正确
2. 检查浏览器控制台是否有 JavaScript 错误
3. 确认所有目标页面都已引入 `carousel.js`

### 页面未自动跳转

1. 检查目标页面是否成功引入 `carousel.js`
2. 检查浏览器控制台是否有错误
3. 确认 URL 的 hash 参数是否包含 `_ci`, `_ct`, `_iv`, `_cy`, `_cu`

### 屏幕自动息屏

1. 确认所有页面使用 HTTPS 协议
2. 检查是否处于低电量/省电模式
3. 尝试在浏览器设置中关闭省电模式

### 进度条未显示

1. 检查页面是否成功引入 `carousel.js`
2. 检查 URL hash 是否包含完整的 carousel 状态参数
3. 检查浏览器控制台是否有 JavaScript 错误

---

## 联系支持

如有技术问题或需要定制化支持，请联系技术团队。
