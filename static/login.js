const loginTab = document.querySelector("#loginTab");
const registerTab = document.querySelector("#registerTab");
const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const authMessage = document.querySelector("#authMessage");
const initialAdminNote = document.querySelector("#initialAdminNote");

let csrfToken = "";

function getNextPath() {
  const value = String(new URLSearchParams(location.search).get("next") || "");
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) return "/";
  return value;
}

function setMessage(text, isError = false) {
  authMessage.textContent = text || "";
  authMessage.classList.toggle("is-error", Boolean(isError));
}

function setMode(mode) {
  const isLogin = mode === "login";
  loginTab.classList.toggle("is-active", isLogin);
  registerTab.classList.toggle("is-active", !isLogin);
  loginTab.setAttribute("aria-selected", String(isLogin));
  registerTab.setAttribute("aria-selected", String(!isLogin));
  loginForm.classList.toggle("is-hidden", !isLogin);
  registerForm.classList.toggle("is-hidden", isLogin);
  setMessage("");
  requestAnimationFrame(() => {
    (isLogin ? document.querySelector("#loginUsername") : document.querySelector("#registerUsername")).focus();
  });
}

async function getJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function bootstrap() {
  const [securityResponse, sessionResponse] = await Promise.all([
    fetch("/api/security", { cache: "no-store" }),
    fetch("/api/auth/session", { cache: "no-store" })
  ]);
  const security = await getJson(securityResponse);
  const session = await getJson(sessionResponse);
  if (!securityResponse.ok || !security.csrfToken) {
    throw new Error(security.error || "无法初始化安全校验");
  }
  csrfToken = security.csrfToken;
  if (session.authenticated) {
    location.replace(getNextPath());
    return;
  }
  initialAdminNote.classList.toggle("is-hidden", !session.initialAdminAvailable);
}

async function submitAuth(form, endpoint, payload) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(endpoint.endsWith("register") ? "正在创建账号…" : "正在登录…");
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(payload)
    });
    const data = await getJson(response);
    if (!response.ok) throw new Error(data.error || "操作失败");
    if (data.becameInitialAdmin) {
      setMessage("初始管理员已创建，正在进入工作区…");
    } else if (data.registeredWithInvite) {
      setMessage("可编辑账号已创建，正在进入工作区…");
    } else {
      setMessage("验证成功，正在进入工作区…");
    }
    location.replace(getNextPath());
  } catch (error) {
    setMessage(error.message || "操作失败", true);
  } finally {
    button.disabled = false;
  }
}

loginTab.addEventListener("click", () => setMode("login"));
registerTab.addEventListener("click", () => setMode("register"));

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(loginForm, "/api/auth/login", {
    username: document.querySelector("#loginUsername").value,
    password: document.querySelector("#loginPassword").value,
    rememberMe: document.querySelector("#loginRemember").checked
  });
});

registerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(registerForm, "/api/auth/register", {
    username: document.querySelector("#registerUsername").value,
    name: document.querySelector("#registerName").value,
    password: document.querySelector("#registerPassword").value,
    inviteCode: document.querySelector("#registerInviteCode").value,
    rememberMe: document.querySelector("#registerRemember").checked
  });
});

bootstrap().catch((error) => setMessage(error.message || "登录页初始化失败", true));
