# LanShare — 局域网文件服务器 / LAN File Server

[中文](#中文) | [English](#english)

---

## 中文

### 简介

LanShare 是一个基于 Node.js 的局域网文件共享与管理工具。无需互联网、无需注册账户，在同一个局域网内即可通过浏览器上传、下载、预览、管理文件。

### 功能

- **文件管理**：浏览目录、上传/下载文件、新建文件夹、重命名、移动、删除
- **预览**：图片、音频、视频在线预览
- **批量操作**：批量上传、批量下载（流式 zip 打包）、批量移动、批量删除
- **回收站**：删除到回收站可恢复，支持 7 天自动清理
- **全局搜索**：递归搜索整个共享目录
- **拖拽上传**：支持文件和文件夹拖拽
- **夜间模式**：日间/夜间一键切换 + 渐变过渡滑块
- **昵称系统**：首次使用设置昵称，操作日志记录谁做了什么
- **日志系统**：实时记录上传、下载、删除、重命名等操作，支持展开查看文件列表
- **光效与视觉**：昵称脉动发光、背景浮动字符、鼠标粒子特效
- **自定义背景**：支持上传图片/视频作为页面背景

### 快速开始

```bash
npm install
npm start
```

打开浏览器访问 `http://127.0.0.1:8080`

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `SHARED_DIR` | `./shared` | 共享目录路径 |
| `BACKUP_DIR` | `./backup` | 备份目录路径 |
| `MAX_FILE_SIZE` | `4GB` | 单文件上传上限 |
| `RECYCLE_RETENTION_DAYS` | `7` | 回收站保留天数 |
| `LOG_FILE` | `./logs/` | 日志文件目录 |

### 技术栈

- 后端：Node.js (http 原生模块)
- 前端：原生 HTML + CSS + JavaScript (ES Modules)
- 依赖：`archiver`（流式 zip）、`busboy`（流式上传）

---

## English

### About

LanShare is a Node.js-based LAN file sharing and management tool. No internet connection or account required. Any device on the same LAN can browse, upload, download, preview and manage files through a browser.

### Features

- **File Management**: Browse directories, upload/download files, create folders, rename, move, delete
- **Preview**: Inline preview for images, audio, and video
- **Batch Operations**: Batch upload, batch download (streaming zip), batch move, batch delete
- **Recycle Bin**: Deleted items go to recycle bin with 7-day auto cleanup
- **Global Search**: Recursive search across the entire shared directory
- **Drag & Drop Upload**: Support files and folders
- **Dark Mode**: Toggle between light/dark with smooth gradient slider
- **Nickname System**: Set nickname on first use, logs track who did what
- **Activity Log**: Real-time logging for uploads, downloads, deletes, renames, etc. with expandable file lists
- **Visual Effects**: Glowing nickname, floating background characters, mouse particle effects
- **Custom Background**: Upload images or videos as page background

### Quick Start

```bash
npm install
npm start
```

Open browser at `http://127.0.0.1:8080`

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `SHARED_DIR` | `./shared` | Shared directory path |
| `BACKUP_DIR` | `./backup` | Backup directory path |
| `MAX_FILE_SIZE` | `4GB` | Max file upload size |
| `RECYCLE_RETENTION_DAYS` | `7` | Recycle bin retention days |
| `LOG_FILE` | `./logs/` | Log directory |

### Tech Stack

- Backend: Node.js (native http module)
- Frontend: Vanilla HTML + CSS + JavaScript (ES Modules)
- Dependencies: `archiver` (streaming zip), `busboy` (streaming upload)
