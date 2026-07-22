# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm start              # Start production server on port 8080
cd dev && npm start    # Start dev server on port 8082
node --check server.js          # Syntax check server
node -c static/app.js      # Syntax check frontend
```

## Project Structure

LanShare is a single-file Node.js application (no framework). Both server and frontend logic are in individual files.

### Production (`server.js` + `static/`)

```
server.js              # HTTP server, API routes, file operations, logging
static/
  index.html           # Main page with tab navigation
  app.js               # All frontend logic
  styles.css           # All styles with theme support
  tools/
    audio/             # Audio processing tool (iframe)
      index.html
      app.js
      styles.css
    video/             # Video frame extraction tool (iframe)
      index.html
      app.js
      styles.css
shared/                # Uploaded files live here
shared_NSFW/           # Password-entry overseas-drama files
backup/daily/          # Daily incremental snapshots and .snapshot.json manifests
recycle_bin/           # Deleted files before permanent removal
logs/                  # Daily log files (YYYY-MM-DD.log)
```

### Dev (`dev/`)
Mirror of production with port 8082. Used for testing changes before syncing to production.

**正式版与 dev 版的区别：**
| 项目 | 正式版 | dev 版 |
|------|--------|--------|
| 端口 | 8080 | 8082 |
| 浏览器标签页标题 | 局域网文件服务器 | 局域网文件服务器（测试版） |
| 版本号 | 与 dev 保持一致 | 与正式版保持一致 |
| shared 目录 | `<项目目录>\shared\` | `<项目目录>\dev\shared\` |
| ROOT_DIR 基准 | 正式版 `__dirname` | dev 版 `__dirname` |

### Backup copies
- `LanShare/` - Local backup (no git)
- `github/` - Git repository for GitHub push

## Architecture

### Main Page (Tab-based)
- **文件管理** (Files): Browse, upload, download, move, delete files
- **音频处理** (Audio): Import audio/video, trim, speed, reverse, merge, export
- **视频截帧** (Video): Import videos, mark frames, export screenshots

Tools run in iframes, inheriting theme CSS variables from parent via MutationObserver.

### Server Flow
1. `http.createServer` receives all requests
2. `handleApi()` routes API calls (`/api/list`, `/api/upload`, `/api/delete`, etc.)
3. Write operations are protected by CSRF token + Origin/Referer check
4. File paths are normalized and restricted within `ROOT_DIR`

### Frontend Flow
1. Tab switching controls visibility of `tab-content` divs
2. All write operations go through `apiFetch()` (auto-attaches CSRF token + nickname)
3. Upload uses XMLHttpRequest with progress tracking
4. Theme slider interpolates CSS variable colors in real-time

### Key Concepts
- **CSRF**: Token generated per server startup, fetched by frontend via `/api/security`
- **Path safety**: `safeRelative()` normalizes paths, `resolveInsideRoot()` prevents directory traversal
- **Recycle bin**: Items are `rename`-ed to `recycle_bin/<uuid>/` with a `meta.json`
- **Daily backup**: Defaults to 23:55. The first snapshot copies all files; later snapshots hard-link unchanged files from the previous snapshot and copy only new/changed files.
- **Per-upload backup**: Disabled by default. Set `PER_UPLOAD_BACKUP_ENABLED=1` only for temporary legacy compatibility.
- **Backup scope**: Each daily snapshot includes both `shared` and `shared_NSFW` and writes `.snapshot.json`.
- **Tool iframes**: Audio/Video tools use `crypto.randomUUID()` polyfill (`generateId()`) for iframe compatibility
- **Thumbnail**: Uses ffmpeg with `-analyzeduration 100M -probesize 50M` to handle moov atom at end of MP4 files
- **File stream**: No slot limit (removed 48-concurrent limit). Direct streaming via `pipeFileToResponse()`
- **Project status**: 目录支持三种状态（`not_started`/`in_progress`/`completed`），存储在 `.status` 文件中。点文件（`.status`、`.complete`、`.project`）在文件列表中隐藏。状态UI仅根目录显示。排序：进行中 > 待开始 > 已完成

## 开发流程（重要）

1. **所有修改先改 `dev/`**，在 `http://127.0.0.1:8082` 测试
2. 测试确认无问题后，**必须经用户确认**才能同步到正式版
3. 正式版验证通过后，**必须经用户确认**才能同步到 `LanShare/`、`github/` 和 GitHub

### 版本同步流程

1. 更新 `package.json`、`dev/package.json`、`dev/static/index.html`、`CHANGELOG.md` 和相关文档中的版本号
2. 经用户确认后运行 `npm run sync`
3. 同步脚本自动把 dev 端口 8082 改为正式版 8080，并移除正式版标题与版本徽标中的测试标记
4. 同步正式版代码、静态资源、脚本、`package.json`、README、CLAUDE、CHANGELOG 和交接文档到 `LanShare/`、`github/`
5. 语法检查并验证所有版本号、端口和测试标记一致
6. Git commit/push 是独立外部操作，只有用户明确要求推送时才执行

### 同步命令

```powershell
npm run sync -- --dry-run  # 只预览，不写文件
npm run sync              # 经用户确认后执行本地同步
```

### 版本号更新
每次同步前，更新正式版与 dev 的 `package.json`、dev 版 `static/index.html`、`CHANGELOG.md` 和交接文档中的版本号；正式版 `static/index.html` 由同步脚本生成。

## Style Notes
- 2-space indentation in JavaScript
- No semicolons in frontend code (app.js)
- Chinese comments and UI text
- Template strings for dialog HTML in app.js
- Day theme: teal (#0d9488), Night theme: warm red-orange (#d65a3a)

## Git Rules
- **NEVER** use `git push --force`
- **NEVER** use `git reset --soft` to squash commits
- **NEVER** delete or rewrite commit history
- Always preserve full commit history

## 代码修改规则
- **最小改动原则**：任何代码修改请始终遵守"最小改动原则"，除非我主动要求优化或者重构。
- **严禁擅自删除**：永远不要删除不是你写的代码（即便代码已被注释），也**永远不要删除原有的任何注释**。
- **复用与参考**：写代码前先思考哪些业务可以参考或复用。尽可能参考现有业务的实现风格；如果不明确，请让我为你提供参考，坚决避免重复造轮子。
- **必须经过用户允许才能同步**：用户已明确声明"以后不许更新与推送"，同步必须等用户命令。
