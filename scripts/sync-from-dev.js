#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function getArgValue(name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return "";
  return args[index + 1];
}

const workspaceRoot = path.resolve(
  getArgValue("--workspace") ||
  process.env.LANSHARE_WORKSPACE ||
  path.join(__dirname, "..")
);

const devDir = path.join(workspaceRoot, "dev");
const prodDir = workspaceRoot;
const lanShareDir = path.join(workspaceRoot, "LanShare");
const githubDir = path.join(workspaceRoot, "github");

const copied = [];

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureRequiredPath(targetPath, label) {
  if (!(await exists(targetPath))) {
    throw new Error(`${label} 不存在: ${targetPath}`);
  }
}

async function copyFile(sourcePath, targetPath) {
  copied.push(`${path.relative(workspaceRoot, sourcePath)} -> ${path.relative(workspaceRoot, targetPath)}`);
  if (dryRun) return;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function copyDir(sourceDir, targetDir) {
  if (!(await exists(sourceDir))) return;
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  if (!dryRun) {
    await fs.mkdir(targetDir, { recursive: true });
  }
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

function assertSafeGeneratedDir(targetDir) {
  const resolved = path.resolve(targetDir);
  if (!isInsideOrEqual(workspaceRoot, resolved)) {
    throw new Error(`拒绝清理工作区外目录: ${resolved}`);
  }
  const name = path.basename(resolved).toLowerCase();
  if (name !== "static") {
    throw new Error(`只允许镜像 static 目录，当前目标: ${resolved}`);
  }
}

function isInsideOrEqual(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function mirrorDir(sourceDir, targetDir) {
  await ensureRequiredPath(sourceDir, "同步源目录");
  assertSafeGeneratedDir(targetDir);
  copied.push(`清理 ${path.relative(workspaceRoot, targetDir)}`);
  if (!dryRun) {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
  await copyDir(sourceDir, targetDir);
}

function withProductionPort(serverSource) {
  const replaced = serverSource.replace(
    /const PORT = Number\(process\.env\.PORT \|\| \d+\);/,
    "const PORT = Number(process.env.PORT || 8080);"
  );
  if (replaced === serverSource) {
    throw new Error("没有找到 server.js 的 PORT 配置，已停止同步");
  }
  return replaced;
}

function withProductionIndexHtml(indexSource) {
  const replaced = indexSource
    .replace("<title>局域网文件服务器（测试版）</title>", "<title>局域网文件服务器</title>")
    .replace(/\s*<span class="test-badge">test_version<\/span>/, "")
    .replace(/(>\s*v\d+\.\d+\.\d+)\s+test_version(\s*<)/, "$1$2");

  if (replaced === indexSource) {
    throw new Error("没有找到 index.html 的测试版标识，已停止同步");
  }
  return replaced;
}

async function writeFile(targetPath, content, label) {
  copied.push(`${label} -> ${path.relative(workspaceRoot, targetPath)}`);
  if (dryRun) return;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}

async function syncServerFiles() {
  const devServerPath = path.join(devDir, "server.js");
  const serverSource = await fs.readFile(devServerPath, "utf8");
  const productionServer = withProductionPort(serverSource);
  await writeFile(path.join(prodDir, "server.js"), productionServer, "dev/server.js(8080)");
  await writeFile(path.join(lanShareDir, "server.js"), productionServer, "dev/server.js(8080)");
  await writeFile(path.join(githubDir, "server.js"), productionServer, "dev/server.js(8080)");
}

async function syncStaticFiles() {
  const devStaticDir = path.join(devDir, "static");
  const productionIndex = withProductionIndexHtml(
    await fs.readFile(path.join(devStaticDir, "index.html"), "utf8")
  );
  await mirrorDir(devStaticDir, path.join(prodDir, "static"));
  await writeFile(path.join(prodDir, "static", "index.html"), productionIndex, "dev/static/index.html(正式版)");
  await mirrorDir(devStaticDir, path.join(lanShareDir, "static"));
  await writeFile(path.join(lanShareDir, "static", "index.html"), productionIndex, "dev/static/index.html(正式版)");
  await mirrorDir(devStaticDir, path.join(githubDir, "static"));
  await writeFile(path.join(githubDir, "static", "index.html"), productionIndex, "dev/static/index.html(正式版)");
}

async function syncProductionExtras(targetDir) {
  await ensureRequiredPath(targetDir, "同步目标目录");
  await copyDir(path.join(prodDir, "scripts"), path.join(targetDir, "scripts"));

  const extraFiles = [
    "package.json",
    "package-lock.json",
    "README.md",
    "CLAUDE.md",
    "CHANGELOG.md",
    "交接文档.md"
  ];
  for (const fileName of extraFiles) {
    await copyFile(path.join(prodDir, fileName), path.join(targetDir, fileName));
  }
}

async function main() {
  await ensureRequiredPath(devDir, "dev 目录");
  await ensureRequiredPath(path.join(devDir, "server.js"), "dev/server.js");
  await ensureRequiredPath(path.join(prodDir, "package.json"), "正式版 package.json");
  await ensureRequiredPath(lanShareDir, "LanShare 目录");
  await ensureRequiredPath(githubDir, "github 目录");

  await syncServerFiles();
  await syncStaticFiles();
  await syncProductionExtras(lanShareDir);
  await syncProductionExtras(githubDir);

  console.log(dryRun ? "预览同步完成，不写入文件。" : "同步完成。");
  for (const item of copied) {
    console.log(`- ${item}`);
  }
  console.log("注意：脚本不会自动 git commit 或 git push。");
}

main().catch((error) => {
  console.error(`同步失败: ${error.message}`);
  process.exit(1);
});
