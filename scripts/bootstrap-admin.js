#!/usr/bin/env node

const fs = require("fs/promises");

const CONFIG_FILE = process.env.BOOTSTRAP_CONFIG_FILE || "/run/secrets/bootstrap-admin.json";
const BASE_URL = process.env.BOOTSTRAP_BASE_URL || "http://127.0.0.1:8080";

async function readJsonResponse(response) {
  return response.json().catch(() => ({}));
}

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  const username = String(config.username || "").trim();
  const password = String(config.password || "");
  const name = String(config.name || "").trim();

  if (!username || !password || !name || password === "CHANGE_ME") {
    throw new Error("请先复制并修改 bootstrap-admin.json 中的账号、密码和姓名");
  }

  const sessionResponse = await fetch(`${BASE_URL}/api/auth/session`, {
    cache: "no-store"
  });
  const session = await readJsonResponse(sessionResponse);
  if (!sessionResponse.ok) {
    throw new Error(session.error || "无法读取账号系统状态");
  }
  if (!session.initialAdminAvailable) {
    throw new Error("系统已经存在管理员，或初始化请求未被识别为容器本机请求");
  }

  const securityResponse = await fetch(`${BASE_URL}/api/security`, {
    cache: "no-store"
  });
  const security = await readJsonResponse(securityResponse);
  if (!securityResponse.ok || !security.csrfToken) {
    throw new Error(security.error || "无法取得 CSRF 令牌");
  }

  const registerResponse = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": BASE_URL,
      "X-CSRF-Token": security.csrfToken
    },
    body: JSON.stringify({
      username,
      password,
      name,
      rememberMe: false
    })
  });
  const result = await readJsonResponse(registerResponse);
  if (!registerResponse.ok) {
    throw new Error(result.error || "初始管理员创建失败");
  }
  if (!result.becameInitialAdmin || result.user?.role !== "admin") {
    throw new Error("账号已创建，但没有成为受保护的初始管理员");
  }

  console.log(`初始管理员创建完成：${result.user.username}（${result.user.name}）`);
  console.log("请立即删除宿主机上的 bootstrap-admin.json，然后从网页登录。");
}

main().catch((error) => {
  console.error(`初始化失败：${error.message}`);
  process.exit(1);
});
