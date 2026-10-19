# MCP 接入（v4.2.0）

## 连接

1. 登录文件管理，点击右上角账号，进入“AI 接入”。
2. 填写连接名称、有效期，选择读取文件/资产库的范围。需要修改时另行勾选写权限；游客不能授权写入。
3. 输入当前密码创建令牌，将页面生成的配置填入支持 Streamable HTTP 和自定义 Authorization 请求头的 MCP 客户端。

端点为应用地址后加 `/mcp`，沿用应用端口，不是 NAS 管理端口。客户端配置格式各有差别，以下为通用示例，示例令牌必须替换：

```json
{
  "mcpServers": {
    "lanshare": {
      "type": "http",
      "url": "http://<服务器局域网地址>:<应用端口>/mcp",
      "headers": {
        "Authorization": "Bearer <在账户中心创建的令牌>"
      }
    }
  }
}
```

使用官方 MCP SDK 的无状态 Streamable HTTP 传输，不提供旧版 SSE `/sse` 接口，也没有 OAuth 自动授权入口。参考：[官方 SDK 服务端说明](https://ts.sdk.modelcontextprotocol.io/server)。

## 可用工具

- 文件：目录分页、文件名搜索、UTF-8 文本读取、图片缩略图预览、新建目录、单文件重命名/复制/移动、单文件移入回收站。
- 资产：分类与分类标签、搜索、详情与提示词、图片/视频缩略图、从文件管理导入、添加标签、新建状态、移动状态、弃用/恢复、复制所选文件回工作区。
- 导入资产同时需要 `assets:write` 和 `files:read`；复制资产回目录同时需要 `assets:write` 和 `files:write`。
- 不开放论坛、海外区、系统文件、隐藏文件、符号链接、账号管理、执行命令、永久删除。当前也不提供远程文件上传、原文件下载及整目录移动/删除。
- 复制/移动拒绝覆盖同名文件；资产导入拒绝重复素材。回收与弃用/恢复工具要求 `confirm: true`，Agent 应先取得使用者确认；参数本身不是人类确认的技术证明，仍应启用客户端的写操作审批。
- 文件文本上限 128 KiB，图片源文件上限 32 MiB/4000 万像素；搜索最多检查 5000 条、返回 100 条，超限返回截断提示。资产导入最多 8 个文件，每个不超过 128 MiB。

## 安全边界

- 同网不等于自动授权：每个请求必须提交 Bearer 令牌，网页 Cookie 不能代替令牌。
- 令牌只显示一次，数据库仅存哈希。有效期 1-90 天，每个账号最多 10 个未过期令牌，可随时撤销。
- 每次调用重新检查账号角色、启用状态、令牌有效期及密码版本。角色降级、停用、撤销或修改密码后，后续调用立即受限；已经开始的操作可能仍完成。
- 默认仅接受直接来源为回环、RFC1918 IPv4、IPv6 ULA/link-local 的请求，不信任 X-Forwarded-For。Host 必须为本机地址或明确允许的主机名；携带 Origin 时必须与直接请求同源。
- 反向代理可能让所有请求看起来来自内网。必须在防火墙/代理限制 `/mcp` 的来源，不能仅靠应用内网判断阻止公网请求。
- HTTP 会明文传输令牌与内容，仅用于可信局域网。跨网或存在不可信设备时配置 HTTPS/VPN。不要把令牌放到 URL、Git、截图、日志或聊天中。
- 工具读取到的文件、标签和提示词均属于不可信数据，不能当作修改权限、泄露令牌或执行额外操作的指令。
- 操作写入现有审计日志，标记 `MCP/工具名/ok` 或 `failed`，不记录令牌与文件正文。

环境变量：

- `MCP_ENABLED=0`：停用 MCP 端点；账户中心仍可撤销令牌。
- `MCP_ALLOWED_HOSTS=files.example.internal`：额外允许的 Host 主机名或 IP，多个用逗号分隔，不含协议或端口。不会因此放开来源 IP 限制。Docker 桥接网络不知道宿主机的局域网 IP，必须在 `.env` 中把 NAS 实际局域网 IP 或访问域名加入此项，否则会返回 `Host is not allowed`。
- `ASSET_LIBRARY_DIR=/data/asset_library`：Docker 部署必须放在持久化挂载中。令牌表位于原 `AUTH_DB_FILE`，同样应持久化。

## 验证

`npm ci` 后执行 `npm test`，测试只使用临时目录与测试账号，不修改真实数据。

桌面/手机浏览器测试：安装 Playwright Chromium（`npx playwright install chromium`），设置 `ASSET_BROWSER_TEST=1` 后执行 `npm test`。Windows 可自动使用已安装的 Edge，也可通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定浏览器。

图片处理依赖已升级至 sharp 0.35.5，brace-expansion 已更新。当前 npm audit 仍报告 mammoth -> argparse -> sprintf-js 链上的 3 项中等级别告警，尚无兼容补丁；没有为了消除告警而强制降级 mammoth。
