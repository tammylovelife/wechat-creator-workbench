# 每晚 AI 选题雷达

这个定时任务会在每天北京时间 20:00：

1. 从公开新闻 RSS 检索 AI 工具、AI 视频、AI 短剧和创作者工作流相关更新；
2. 用 DeepSeek 筛选出 5 个最适合个人 AI 公众号的选题；
3. 通过飞书群机器人推送标题建议、切入角度和来源链接。

## 只需配置三项私密变量

在 GitHub 仓库中打开：`Settings` → `Secrets and variables` → `Actions` → `New repository secret`，依次新增：

- `DEEPSEEK_API_KEY`：你的 DeepSeek API Key。
- `DEEPSEEK_MODEL`：可选；留空时使用 `deepseek-v4-flash`。
- `FEISHU_WEBHOOK_URL`：飞书群内“自定义机器人”生成的 Webhook 地址。

这些内容只保存在 GitHub 的私密变量中，不会被提交到代码，也不会出现在任务日志中。

## 立即测试

在仓库的 `Actions` 标签页中，打开 **Personal Creator Radar**，点击 `Run workflow`。成功后，飞书群会立即收到一条测试推送。

## 提醒

- 这是公开资讯雷达，不会绕过公众号、小红书、抖音等平台的登录或访问限制。
- 若当天公开新闻不足，任务会停止而不是拼凑不可靠选题。
- GitHub 的定时任务可能有少量排队延迟；20:00 是计划触发时间。
