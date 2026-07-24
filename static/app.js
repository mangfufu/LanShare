const VIEW_MODE_KEY = "lan_file_server_view_mode";
const THEME_KEY = "lan_file_server_theme";
const THEME_POS_KEY = "lan_file_server_theme_pos";
const NICKNAME_KEY = "lan_file_server_nickname";
const NICKNAME_GLOW_COLOR_KEY = "lan_file_server_nickname_glow_color";
const FLOAT_SPEED_KEY = "lan_file_server_float_speed";
const FLOAT_SIZE_KEY = "lan_file_server_float_size";
const CURRENT_DIR_KEY = "lan_file_server_current_dir";
const CURSOR_EFFECT_KEY = "lan_file_server_cursor_effect";
const COLUMN_WIDTHS_KEY = "lan_file_server_column_widths";
const FORUM_READ_REPLIES_KEY = "lan_file_server_forum_read_replies";
const INTERNAL_DRAG_TYPE = "application/x-lanshare-paths";

const state = {
  currentDir: "",
  viewMode: localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "list",
  theme: localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light",
  themePos: Number(localStorage.getItem(THEME_POS_KEY)) || 0,
  uiStyle: "editorial",
  currentItems: [],
  previewIndex: -1,
  moveTargetDir: "",
  movePaths: [],
  moveDirectories: [],
  moveFilter: "",
  searchFilter: "",
  searchQuery: "",
  searchResults: [],
  searchTimeout: null,
  selectedPaths: new Set(),
  recycleSelectedIds: new Set(),
  recycleFilter: "",
  recycleItems: [],
  undoStack: [], // 操作撤销栈：{ type, items, targetDir, sourceDir, user, timestamp }
  uploadTasks: [],
  nextUploadTaskId: 1,
  csrfToken: "",
  csrfPromise: null,
  nickname: localStorage.getItem(NICKNAME_KEY) || "",
  glowColor: localStorage.getItem(NICKNAME_GLOW_COLOR_KEY) || "#57503f",
  cursorEffect: localStorage.getItem(CURSOR_EFFECT_KEY) !== null ? localStorage.getItem(CURSOR_EFFECT_KEY) : "comet",
  floatSpeed: Number(localStorage.getItem(FLOAT_SPEED_KEY)) || 10,
  floatSize: Number(localStorage.getItem(FLOAT_SIZE_KEY)) || 200,
  logEntries: [],
  fileOffset: 0,
  fileTotal: 0,
  loadingMore: false,
  sortKey: "name",
  sortAsc: true,
  filterStatus: "all", // all | completed | in_progress | not_started
  nsfwMode: false,
  clipboard: { items: [], mode: null },
  workspaceStatus: null,
  forumPosts: [],
  forumManageMode: false,
  forumSelectedPostIds: new Set(),
  inProgressProjects: [],
  workspaceProjects: [],
  workspaceProjectsLoaded: false,
  currentUser: null,
  permissions: []
};
const FORUM_REACTION_EMOJIS = [
  "😀", "😄", "😂", "🤣", "😊", "🥰",
  "😍", "😅", "😭", "😢", "😮", "😱",
  "😡", "🤬", "🤔", "🙄", "👍", "👎",
  "👏", "🙏", "💪", "❤️", "💔", "🔥",
  "🎉", "💯", "👀", "✅", "❌", "🤝"
];

let forumReadReplyCounts = {};

function getForumReadRepliesStorageKey() {
  return state.currentUser
    ? `${FORUM_READ_REPLIES_KEY}:${state.currentUser.id}`
    : FORUM_READ_REPLIES_KEY;
}

function loadForumReadReplyCounts() {
  forumReadReplyCounts = {};
  try {
    const scopedKey = getForumReadRepliesStorageKey();
    const raw = localStorage.getItem(scopedKey)
      || (scopedKey !== FORUM_READ_REPLIES_KEY ? localStorage.getItem(FORUM_READ_REPLIES_KEY) : "")
      || "{}";
    const saved = JSON.parse(raw);
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      forumReadReplyCounts = saved;
    }
  } catch {
    forumReadReplyCounts = {};
  }
}

function getForumReadReplyCount(postId) {
  return Math.max(0, Number(forumReadReplyCounts[String(postId)]) || 0);
}

function hasUnreadForumReplies(post) {
  return Number(post.replyCount || 0) > getForumReadReplyCount(post.id);
}

function markForumPostRepliesRead(post) {
  forumReadReplyCounts[String(post.id)] = Math.max(0, Number(post.replyCount || 0));
  try {
    localStorage.setItem(getForumReadRepliesStorageKey(), JSON.stringify(forumReadReplyCounts));
  } catch {
    // 某些隐私或受限浏览环境可能禁用本地存储。
  }
}

const tableBody = document.querySelector("#fileTableBody");
const tableView = document.querySelector("#tableView");
const fileTable = tableView ? tableView.querySelector("table") : null;
const gridView = document.querySelector("#gridView");
const breadcrumb = document.querySelector("#breadcrumb");
const messageBox = document.querySelector("#message");
const fileInput = document.querySelector("#fileInput");
const folderInput = document.querySelector("#folderInput");
const uploadBtn = document.querySelector("#uploadBtn");
const uploadMenu = document.querySelector("#uploadMenu");
const mkdirBtn = document.querySelector("#mkdirBtn");
const refreshBtn = document.querySelector("#refreshBtn");
const mainSearchInput = document.querySelector("#mainSearchInput");
const listViewBtn = document.querySelector("#listViewBtn");
const gridViewBtn = document.querySelector("#gridViewBtn");
const rowTemplate = document.querySelector("#rowTemplate");
const previewDialog = document.querySelector("#previewDialog");
const previewTitle = document.querySelector("#previewTitle");
const previewBody = document.querySelector("#previewBody");
const closePreviewBtn = document.querySelector("#closePreviewBtn");
const recycleToggleBtn = document.querySelector("#recycleToggleBtn");
const recycleDrawer = document.querySelector("#recycleDrawer");
const closeRecycleBtn = document.querySelector("#closeRecycleBtn");
const recycleCountBadge = document.querySelector("#recycleCountBadge");
const recycleList = document.querySelector("#recycleList");
const recycleMessage = document.querySelector("#recycleMessage");
const recycleSearchInput = document.querySelector("#recycleSearchInput");
const recycleSelectAllBtn = document.querySelector("#recycleSelectAllBtn");
const recycleInvertSelectionBtn = document.querySelector("#recycleInvertSelectionBtn");
const recycleSelectedCount = document.querySelector("#recycleSelectedCount");
const recycleRestoreSelectedBtn = document.querySelector("#recycleRestoreSelectedBtn");
const recycleDeleteSelectedBtn = document.querySelector("#recycleDeleteSelectedBtn");
const uploadProgress = document.querySelector("#uploadProgress");
const uploadProgressText = document.querySelector("#uploadProgressText");
const uploadSpeedEl = document.querySelector("#uploadSpeed");
const uploadProgressPercent = document.querySelector("#uploadProgressPercent");
const uploadProgressFill = document.querySelector("#uploadProgressFill");
const uploadQueue = document.querySelector("#uploadQueue");
const nicknameDisplay = document.querySelector("#nicknameDisplay");
const logToggleBtn = document.querySelector("#logToggleBtn");
const logPanel = document.querySelector("#logPanel");
const logList = document.querySelector("#logList");
const closeLogBtn = document.querySelector("#closeLogBtn");
const workspaceRail = document.querySelector("#workspaceRail");
const workspaceModeLabel = document.querySelector("#workspaceModeLabel");
const workspaceOverviewBody = document.querySelector("#workspaceOverviewBody");
const forumComposeToggle = document.querySelector("#forumComposeToggle");
const forumComposeForm = document.querySelector("#forumComposeForm");
const forumPostTitle = document.querySelector("#forumPostTitle");
const forumPostContent = document.querySelector("#forumPostContent");
const forumComposeMessage = document.querySelector("#forumComposeMessage");
const forumPostList = document.querySelector("#forumPostList");
const forumPostCount = document.querySelector("#forumPostCount");
const forumManageToggle = document.querySelector("#forumManageToggle");
const forumBatchBar = document.querySelector("#forumBatchBar");
const forumBatchCount = document.querySelector("#forumBatchCount");
const forumSelectAllToggle = document.querySelector("#forumSelectAllToggle");
const forumBatchCancel = document.querySelector("#forumBatchCancel");
const forumBatchDelete = document.querySelector("#forumBatchDelete");
const accountDialog = document.querySelector("#accountDialog");
const closeAccountBtn = document.querySelector("#closeAccountBtn");
const accountName = document.querySelector("#accountName");
const accountUsername = document.querySelector("#accountUsername");
const accountRole = document.querySelector("#accountRole");
const accountAvatar = document.querySelector("#accountAvatar");
const accountNameInput = document.querySelector("#accountNameInput");
const accountProfileForm = document.querySelector("#accountProfileForm");
const accountPasswordForm = document.querySelector("#accountPasswordForm");
const accountCurrentPassword = document.querySelector("#accountCurrentPassword");
const accountNewPassword = document.querySelector("#accountNewPassword");
const accountMessage = document.querySelector("#accountMessage");
const accountAppearanceBtn = document.querySelector("#accountAppearanceBtn");
const accountManageUsersBtn = document.querySelector("#accountManageUsersBtn");
const accountLogoutBtn = document.querySelector("#accountLogoutBtn");
const accountUsersDialog = document.querySelector("#accountUsersDialog");
const closeAccountUsersBtn = document.querySelector("#closeAccountUsersBtn");
const accountInviteForm = document.querySelector("#accountInviteForm");
const accountInviteCode = document.querySelector("#accountInviteCode");
const accountInviteDisable = document.querySelector("#accountInviteDisable");
const accountInviteState = document.querySelector("#accountInviteState");
const accountInviteMessage = document.querySelector("#accountInviteMessage");
const accountUsersList = document.querySelector("#accountUsersList");
let forumReactionPickerPortal = null;

function can(permission) {
  return state.permissions.includes("*") || state.permissions.includes(permission);
}

function setAccountMessage(text, isError = false) {
  if (!accountMessage) return;
  accountMessage.textContent = text || "";
  accountMessage.classList.toggle("is-error", Boolean(isError));
}

function updateAccountSummary() {
  const user = state.currentUser;
  if (!user) return;
  if (accountName) accountName.textContent = user.name;
  if (accountUsername) accountUsername.textContent = `@${user.username}`;
  if (accountRole) accountRole.textContent = user.roleLabel;
  if (accountAvatar) accountAvatar.textContent = Array.from(user.name || user.username || "账")[0] || "账";
  if (accountNameInput) accountNameInput.value = user.name;
}

function applyRoleUi() {
  const canWrite = can("files.write");
  const canDownload = can("files.download");
  const canUseRecycle = can("recycle.read");
  const isAdmin = can("*");
  document.querySelector(".upload-group")?.classList.toggle("is-hidden", !canWrite);
  mkdirBtn?.classList.toggle("is-hidden", !canWrite);
  document.querySelector("#createProjectBtn")?.classList.toggle("is-hidden", !canWrite);
  recycleToggleBtn?.classList.toggle("is-hidden", !canUseRecycle);
  logToggleBtn?.classList.toggle("is-hidden", !isAdmin);
  forumComposeToggle?.classList.toggle("is-hidden", !can("forum.write"));
  document.querySelector(".nsfw-entry")?.classList.toggle("is-hidden", !canWrite);
  accountManageUsersBtn?.classList.toggle("is-hidden", !isAdmin);
  if (!can("forum.write")) forumComposeForm?.classList.add("is-hidden");
  const chatInputControl = document.querySelector("#chatInput");
  const chatSendControl = document.querySelector("#chatSendBtn");
  if (chatInputControl) {
    chatInputControl.disabled = !can("forum.write");
    chatInputControl.placeholder = can("forum.write") ? "写点啥…" : "游客不可发送消息";
  }
  if (chatSendControl) chatSendControl.disabled = !can("forum.write");
  const chatClearControl = document.querySelector("#chatClearBtn");
  if (chatClearControl) chatClearControl.style.display = isAdmin ? "" : "none";
  if (typeof _nsfwSet !== "undefined" && _nsfwSet) {
    _nsfwSet.style.display = isAdmin && !state.nsfwMode ? "" : "none";
  }
  if (!canUseRecycle) recycleDrawer?.classList.add("is-hidden");
  if (!isAdmin) logPanel?.classList.add("is-hidden");
  updateAccountSummary();
  updateToolbarButtons();
}

async function loadCurrentAccount() {
  const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
  const data = await parseJsonResponse(response);
  if (!response.ok || !data.authenticated || !data.user) {
    location.replace("/login");
    return null;
  }
  state.currentUser = data.user;
  state.permissions = Array.isArray(data.user.permissions) ? data.user.permissions : [];
  loadForumReadReplyCounts();
  state.nickname = data.user.name;
  localStorage.setItem(NICKNAME_KEY, state.nickname);
  updateNicknameDisplay();
  applyRoleUi();
  return data.user;
}

const accountReady = loadCurrentAccount().catch(() => {
  location.replace("/login");
  return null;
});

const moveDialog = document.createElement("dialog");
moveDialog.className = "preview-dialog move-dialog";
moveDialog.innerHTML = `
  <div class="preview-header">
    <div>
      <div class="label">选择目标文件夹</div>
      <div id="moveDialogTitle" class="preview-title"></div>
    </div>
    <button id="closeMoveDialogBtn" class="button ghost" type="button">关闭</button>
  </div>
  <div class="move-dialog-body">
    <div id="moveDialogCurrent" class="move-current-path"></div>
    <div id="moveDialogBreadcrumb" class="breadcrumb move-breadcrumb"></div>
    <div class="move-dialog-tools">
      <input id="moveSearchInput" class="field" type="search" placeholder="搜索当前文件夹" />
      <button id="moveCreateFolderBtn" class="button ghost" type="button">新建目标文件夹</button>
    </div>
    <div class="move-dialog-actions">
      <button id="moveHereBtn" class="button primary" type="button">移动到当前文件夹</button>
    </div>
    <div id="moveDialogMessage" class="message"></div>
    <div id="moveDialogList" class="move-folder-list"></div>
  </div>
`;
document.body.appendChild(moveDialog);
const moveDialogTitle = moveDialog.querySelector("#moveDialogTitle");
const moveDialogCurrent = moveDialog.querySelector("#moveDialogCurrent");
const moveDialogBreadcrumb = moveDialog.querySelector("#moveDialogBreadcrumb");
const moveDialogMessage = moveDialog.querySelector("#moveDialogMessage");
const moveDialogList = moveDialog.querySelector("#moveDialogList");
const moveSearchInput = moveDialog.querySelector("#moveSearchInput");
const moveCreateFolderBtn = moveDialog.querySelector("#moveCreateFolderBtn");
const moveHereBtn = moveDialog.querySelector("#moveHereBtn");
const closeMoveDialogBtn = moveDialog.querySelector("#closeMoveDialogBtn");

const DRAG_SCROLL_EDGE_SIZE = 72;
const DRAG_SCROLL_MAX_SPEED = 24;
let dragScrollFrame = 0;
let dragScrollContainer = null;
let dragScrollSpeed = 0;
let toastHost = null;

function ensureToastHost() {
  if (toastHost) return toastHost;
  toastHost = document.createElement("div");
  toastHost.className = "toast-host";
  document.body.appendChild(toastHost);
  return toastHost;
}

function showToast(text, type = "info") {
  const host = ensureToastHost();
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  const content = document.createElement("span");
  content.className = "toast-content";
  content.textContent = text;
  item.appendChild(content);
  if (type === "error") {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.setAttribute("aria-label", "关闭通知");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => item.remove());
    item.appendChild(closeBtn);
  }
  host.appendChild(item);
  if (type === "error") return;
  window.setTimeout(() => item.classList.add("is-leaving"), 2600);
  window.setTimeout(() => item.remove(), 3100);
}

function shouldUseInlineMessage(text, type) {
  return String(text || "").startsWith("搜索\"");
}

function showMessage(text, type = "info") {
  if (!shouldUseInlineMessage(text, type)) {
    showToast(text, type);
    if (messageBox.textContent && messageBox.className === "message error") return;
    clearMessage();
    return;
  }
  messageBox.textContent = text;
  messageBox.className = `message ${type}`;
}

function showRecycleMessage(text, type = "info") {
  recycleMessage.textContent = text;
  recycleMessage.className = `message ${type}`;
}

function clearMessage() {
  messageBox.textContent = "";
  messageBox.className = "message";
}

async function ensureSecurity() {
  if (state.csrfToken) return state.csrfToken;
  if (!state.csrfPromise) {
    state.csrfPromise = fetch("/api/security", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || !data.csrfToken) {
          throw new Error(data.error || "安全校验初始化失败");
        }
        state.csrfToken = data.csrfToken;
        return state.csrfToken;
      })
      .finally(() => {
        state.csrfPromise = null;
      });
  }
  return state.csrfPromise;
}

async function parseJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function apiFetch(url, options = {}) {
  const csrfToken = await ensureSecurity();
  const headers = new Headers(options.headers || {});
  headers.set("X-CSRF-Token", csrfToken);
  if (state.nickname) headers.set("X-Device-Name", encodeURIComponent(state.nickname));
  // NSFW 模式下追加参数
  if (state.nsfwMode) {
    url += (url.indexOf("?") === -1 ? "?" : "&") + "nsfw=1"
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && res.headers.get("X-Auth-Required") === "1") {
    location.replace("/login");
  } else if (res.status === 401 && state.nsfwMode) {
    setNsfwModeUi(false);
  }
  if (res.ok && can("*") && (options.method === "POST" || options.method === undefined)) pollLogs();
  return res;
}

function setNsfwModeUi(enabled) {
  state.nsfwMode = Boolean(enabled);
  if (state.nsfwMode) sessionStorage.setItem("nsfw_authed", "1");
  else sessionStorage.removeItem("nsfw_authed");
  const input = document.getElementById("nsfwInput");
  const bar = document.getElementById("nsfwBar");
  if (input) input.style.display = state.nsfwMode ? "none" : "";
  if (bar) bar.style.display = state.nsfwMode ? "" : "none";
  if (typeof _nsfwSet !== "undefined" && _nsfwSet) {
    _nsfwSet.style.display = can("*") && !state.nsfwMode ? "" : "none";
  }
  loadInProgressProjects();
}

async function restoreNsfwSession() {
  if (sessionStorage.getItem("nsfw_authed") !== "1") return;
  try {
    const response = await fetch("/api/nsfw/session", { cache: "no-store" });
    setNsfwModeUi(response.ok);
  } catch {
    setNsfwModeUi(false);
  }
}

async function checkConflicts(payload) {
  const res = await apiFetch("/api/check-conflicts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) {
    throw new Error(data.error || "冲突检查失败");
  }
  return Array.isArray(data.conflicts) ? data.conflicts : [];
}

async function confirmOverwriteConflicts({ title, message, conflicts, confirmText }) {
  if (!conflicts.length) return true;
  return await openConfirmDialog({
    title,
    message,
    items: conflicts.map((item) => item.path || item.name || "同名项目"),
    confirmText,
    danger: true
  });
}

function getActiveFileScrollContainer() {
  return state.viewMode === "grid" ? gridView : tableView;
}

function stopDragAutoScroll() {
  if (dragScrollFrame) cancelAnimationFrame(dragScrollFrame);
  dragScrollFrame = 0;
  dragScrollContainer = null;
  dragScrollSpeed = 0;
}

function runDragAutoScroll() {
  if (!dragScrollContainer || dragScrollSpeed === 0) {
    stopDragAutoScroll();
    return;
  }
  dragScrollContainer.scrollTop += dragScrollSpeed;
  dragScrollFrame = requestAnimationFrame(runDragAutoScroll);
}

function updateDragAutoScroll(event) {
  const container = getActiveFileScrollContainer();
  if (!container || container.classList.contains("is-hidden")) {
    stopDragAutoScroll();
    return;
  }

  const rect = container.getBoundingClientRect();
  let speed = 0;
  if (event.clientY < rect.top + DRAG_SCROLL_EDGE_SIZE) {
    const ratio = Math.max(0, Math.min(1, (rect.top + DRAG_SCROLL_EDGE_SIZE - event.clientY) / DRAG_SCROLL_EDGE_SIZE));
    speed = -Math.ceil(ratio * DRAG_SCROLL_MAX_SPEED);
  } else if (event.clientY > rect.bottom - DRAG_SCROLL_EDGE_SIZE) {
    const ratio = Math.max(0, Math.min(1, (event.clientY - (rect.bottom - DRAG_SCROLL_EDGE_SIZE)) / DRAG_SCROLL_EDGE_SIZE));
    speed = Math.ceil(ratio * DRAG_SCROLL_MAX_SPEED);
  }

  if (speed === 0) {
    stopDragAutoScroll();
    return;
  }

  dragScrollContainer = container;
  dragScrollSpeed = speed;
  if (!dragScrollFrame) {
    dragScrollFrame = requestAnimationFrame(runDragAutoScroll);
  }
}

function positionDragCancelZone() {
  const cancelZone = document.querySelector("#dragCancelZone");
  const container = getActiveFileScrollContainer();
  if (!cancelZone || !container || container.classList.contains("is-hidden")) return;

  const rect = container.getBoundingClientRect();
  const gap = 12;
  const zoneWidth = window.innerWidth < 760 ? 132 : 176;
  let left = rect.right + gap;
  if (left + zoneWidth > window.innerWidth - gap) {
    left = Math.max(gap, window.innerWidth - zoneWidth - gap);
  }

  const top = Math.max(gap, rect.top);
  const bottomLimit = window.innerHeight - 46;
  const height = Math.max(180, bottomLimit - top);

  cancelZone.style.setProperty("--drag-cancel-left", `${Math.round(left)}px`);
  cancelZone.style.setProperty("--drag-cancel-top", `${Math.round(top)}px`);
  cancelZone.style.setProperty("--drag-cancel-width", `${Math.round(zoneWidth)}px`);
  cancelZone.style.setProperty("--drag-cancel-height", `${Math.round(height)}px`);
}

function showDragCancelZone() {
  const cancelZone = document.querySelector("#dragCancelZone");
  if (!cancelZone) return;
  positionDragCancelZone();
  cancelZone.classList.remove("is-hidden");
}

function hideDragCancelZone() {
  const cancelZone = document.querySelector("#dragCancelZone");
  if (!cancelZone) return;
  cancelZone.classList.remove("drag-over");
  cancelZone.classList.add("is-hidden");
}

function finishInternalMoveDragUi() {
  stopDragAutoScroll();
  setDropActive(false);
  hideDragCancelZone();
  document.querySelectorAll(".drag-over").forEach((element) => {
    element.classList.remove("drag-over");
  });
}

function showDialog(dialog) {
  if (typeof dialog.showModal === "function") {
    try {
      dialog.showModal();
      return;
    } catch {
      // Fall through for browsers that reject nested modal dialogs.
    }
  }
  dialog.setAttribute("open", "open");
}

function closeDialog(dialog) {
  if (dialog.open && typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

function getDataTransferTypes(dataTransfer) {
  return Array.from(dataTransfer?.types || []);
}

function hasDataTransferType(dataTransfer, type) {
  return getDataTransferTypes(dataTransfer).includes(type);
}

function isExternalFileDrag(event) {
  return hasDataTransferType(event.dataTransfer, "Files") || (event.dataTransfer?.files?.length || 0) > 0;
}

function isInternalMoveDrag(event) {
  if (!event.dataTransfer) return false;
  if (hasDataTransferType(event.dataTransfer, INTERNAL_DRAG_TYPE)) return true;
  return hasDataTransferType(event.dataTransfer, "application/json") && !isExternalFileDrag(event);
}

function getInternalDragPaths(dataTransfer) {
  try {
    const raw = dataTransfer.getData(INTERNAL_DRAG_TYPE) || dataTransfer.getData("application/json") || "[]";
    const paths = JSON.parse(raw);
    return Array.isArray(paths) ? paths : [];
  } catch {
    return [];
  }
}

function openInputDialog({
  title,
  label,
  value = "",
  suffix = "",
  hint = "",
  confirmText = "确定",
  inputType = "text",
  autocomplete = "off",
  trimValue = true,
  validate
}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "preview-dialog form-dialog";
    dialog.innerHTML = `
      <div class="preview-header">
        <div>
          <div class="label">${escapeHtml(label)}</div>
          <div class="preview-title">${escapeHtml(title)}</div>
        </div>
        <button class="button ghost" data-action="cancel" type="button">关闭</button>
      </div>
      <form class="form-dialog-body" method="dialog">
        <div class="input-row">
          <input class="field" name="value" autocomplete="off" />
          ${suffix ? `<span class="input-suffix">${escapeHtml(suffix)}</span>` : ""}
        </div>
        ${hint ? `<div class="form-hint">${escapeHtml(hint)}</div>` : ""}
        <div class="message"></div>
        <div class="dialog-actions">
          <button class="button ghost" data-action="cancel" type="button">取消</button>
          <button class="button primary" type="submit">${escapeHtml(confirmText)}</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    const form = dialog.querySelector("form");
    const input = dialog.querySelector("input");
    const message = dialog.querySelector(".message");
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      closeDialog(dialog);
      dialog.remove();
      resolve(result);
    };

    input.type = inputType;
    input.autocomplete = autocomplete;
    input.value = value;
    input.focus();
    input.select();

    dialog.addEventListener("mousedown", (e) => { dialog._downTarget = e.target; });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && dialog._downTarget === dialog || event.target.dataset.action === "cancel") finish(null);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const nextValue = trimValue ? input.value.trim() : input.value;
      const error = validate ? validate(nextValue) : "";
      if (error) {
        message.textContent = error;
        message.className = "message error";
        input.focus();
        return;
      }
      finish(nextValue);
    });

    showDialog(dialog);
  });
}

function openConfirmDialog({ title, message, items = [], confirmText = "确定", danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "preview-dialog confirm-dialog";
    const itemList = items.length
      ? `<div class="confirm-list">${items.slice(0, 80).map((item) => `<div>${escapeHtml(item)}</div>`).join("")}${items.length > 80 ? `<div>还有 ${items.length - 80} 项未显示</div>` : ""}</div>`
      : "";
    dialog.innerHTML = `
      <div class="preview-header">
        <div>
          <div class="label">确认操作</div>
          <div class="preview-title">${escapeHtml(title)}</div>
        </div>
        <button class="button ghost" data-action="cancel" type="button">关闭</button>
      </div>
      <div class="confirm-dialog-body">
        <div class="confirm-message">${escapeHtml(message)}</div>
        ${itemList}
        <div class="dialog-actions">
          <button class="button ghost" data-action="cancel" type="button">取消</button>
          <button class="button ${danger ? "ghost danger-button" : "primary"}" data-action="confirm" type="button">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      closeDialog(dialog);
      dialog.remove();
      resolve(result);
    };
    dialog.addEventListener("mousedown", (e) => { dialog._downTarget = e.target; });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && dialog._downTarget === dialog || event.target.dataset.action === "cancel") finish(false);
      if (event.target.dataset.action === "confirm") finish(true);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    showDialog(dialog);
  });
}

function showMoveDialogMessage(text, type = "info") {
  moveDialogMessage.textContent = text;
  moveDialogMessage.className = `message ${type}`;
}

function setUploadProgress(percent, text, options = {}) {
  uploadProgress.classList.remove("is-hidden");
  uploadProgress.classList.toggle("is-indeterminate", Boolean(options.indeterminate));
  uploadProgressText.textContent = text;
  uploadProgressPercent.textContent = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  uploadProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (options.speed !== undefined && uploadSpeedEl) {
    uploadSpeedEl.textContent = options.speed;
    window._uploadSpeed = options.speed;
  }
  renderWorkspaceOverview();
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  }
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

function calculateUploadSpeed(samples) {
  if (samples.length < 2) return null;
  const recent = samples.slice(-5);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = (last.time - first.time) / 1000;
  if (dt <= 0) return null;
  const bytes = last.loaded - first.loaded;
  if (bytes <= 0) return null;
  return bytes / dt;
}

function resetUploadProgress() {
  uploadProgress.classList.add("is-hidden");
  uploadProgress.classList.remove("is-indeterminate");
  uploadProgressText.textContent = "准备上传...";
  if (uploadSpeedEl) uploadSpeedEl.textContent = "";
  uploadProgressPercent.textContent = "0%";
  uploadProgressFill.style.width = "0%";
  renderWorkspaceOverview();
}

function createUploadTask(label, count) {
  const task = {
    id: state.nextUploadTaskId++,
    label,
    count,
    progress: 0,
    status: "pending",
    message: "等待上传",
    xhr: null,
    cancelled: false
  };
  state.uploadTasks.unshift(task);
  renderUploadQueue();
  return task;
}

function updateUploadTask(task, patch) {
  Object.assign(task, patch);
  renderUploadQueue();
}

function removeUploadTask(taskId) {
  state.uploadTasks = state.uploadTasks.filter((task) => task.id !== taskId);
  renderUploadQueue();
}

function renderUploadQueue() {
  if (!uploadQueue) return;
  uploadQueue.classList.toggle("is-hidden", state.uploadTasks.length === 0);
  uploadQueue.innerHTML = "";
  for (const task of state.uploadTasks.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = `upload-task ${task.status}`;
    row.innerHTML = `
      <div class="upload-task-main">
        <div class="upload-task-title">${escapeHtml(task.label)}</div>
        <div class="upload-task-message">${escapeHtml(window._uploadSpeed || "")} · ${task.progress.toFixed(0)}%</div>
        <div class="upload-task-bar"><div style="width:${Math.max(0, Math.min(100, task.progress))}%"></div></div>
      </div>
    `;
    const actions = document.createElement("div");
    actions.className = "upload-task-actions";
    if (task.status === "pending" || task.status === "uploading") {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "link-button danger-button";
      cancelBtn.textContent = "取消";
      cancelBtn.onclick = () => {
        task.cancelled = true;
        if (task.xhr) task.xhr.abort();
        updateUploadTask(task, { status: "cancelled", message: "已取消", progress: task.progress });
      };
      actions.appendChild(cancelBtn);
    } else {
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "link-button";
      closeBtn.textContent = "移除";
      closeBtn.onclick = () => removeUploadTask(task.id);
      actions.appendChild(closeBtn);
    }
    row.appendChild(actions);
    uploadQueue.appendChild(row);
  }
  renderWorkspaceOverview();
}

function formatSize(size) {
  if (size == null) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatWorkspaceActivitySize(bytes, complete) {
  const value = Math.max(0, Number(bytes) || 0);
  if (complete !== false) return formatSize(value);
  return value > 0 ? `≥ ${formatSize(value)}` : "待累计";
}

function formatItemSize(item) {
  if (item.type !== "directory") return formatSize(item.size);
  if (item.folderSize != null) return formatSize(item.folderSize);
  if (item.folderSizeStatus === "pending" || item.folderSizeStatus === "stale") return "计算中";
  return "-";
}

function fileUrl(path) {
  var u = "/file?path=" + encodeURIComponent(path)
  if (state.nsfwMode) u += "&nsfw=1"
  return u
}

function previewUrl(path) {
  var u = "/preview?path=" + encodeURIComponent(path)
  if (state.nsfwMode) u += "&nsfw=1"
  return u
}
function getFileType(item) {
  if (item.type === "directory") return "文件夹";
  const name = item.name || "";
  const ext = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "";
  if (ext) return ext;
  if (item.previewType === "image") return "图片";
  if (item.previewType === "video") return "视频";
  if (item.previewType === "audio") return "音频";
  return "文件";
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 撤销功能
function pushUndo(entry) {
  state.undoStack.push(entry);
  // 保留最近 20 条操作
  if (state.undoStack.length > 20) state.undoStack.shift();
}

async function undoLastAction() {
  // 找到当前用户最近的操作
  const user = state.nickname || "anonymous";
  const idx = state.undoStack.findLastIndex(e => e.user === user);
  if (idx === -1) {
    showMessage("没有可撤销的操作", "info");
    return;
  }
  const entry = state.undoStack[idx];
  state.undoStack.splice(idx, 1);

  if (entry.type === "delete") {
    // 删除操作：恢复回收站中的文件
    const recycleItems = await fetchRecycleItems();
    for (const undoItem of entry.items) {
      const itemPath = typeof undoItem === "string" ? undoItem : undoItem.originalPath;
      const itemId = typeof undoItem === "string" ? "" : undoItem.id;
      const fileName = typeof undoItem === "string" ? itemPath.split("/").pop() : undoItem.name || itemPath.split("/").pop();
      const recycleEntry = recycleItems.find((r) => itemId && r.id === itemId)
        || recycleItems.find((r) => r.originalPath === itemPath)
        || recycleItems.find(r => r.name === fileName || r.items?.some(i => i.name === fileName));
      if (recycleEntry) {
        await apiFetch("/api/recycle/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: recycleEntry.id })
        });
      }
    }
    showMessage("已撤销删除", "success");
    await loadDir(entry.sourceDir);
    await loadRecycleItems();
  } else if (entry.type === "move") {
    // 移动操作：移回原目录
    const movedPaths = entry.items.map(p => {
      const fileName = p.split("/").pop();
      return entry.targetDir ? `${entry.targetDir}/${fileName}` : fileName;
    });
    const ok = await moveItems(movedPaths, entry.sourceDir);
    if (ok) {
      showMessage("已撤销移动", "success");
      await loadDir(state.currentDir);
    }
  }
}

async function fetchRecycleItems() {
  const res = await apiFetch("/api/recycle/list");
  const data = await parseJsonResponse(res);
  return data.items || [];
}

function getSelectionCount() {
  return state.selectedPaths.size;
}

function updateToolbarButtons() {
  const selectionTools = document.querySelector("#selectionTools") || document.querySelector(".toolbar-actions-right");
  if (!selectionTools) return;
  const selectionSummary = document.querySelector("#selectionSummary");

  let moveBtn = document.querySelector("#batchMoveBtn");
  if (!moveBtn) {
    moveBtn = document.createElement("button");
    moveBtn.id = "batchMoveBtn";
    moveBtn.type = "button";
    moveBtn.className = "button ghost batch-action";
    moveBtn.addEventListener("click", moveSelectedItems);
  }

  let deleteBtn = document.querySelector("#batchDeleteBtn");
  if (!deleteBtn) {
    deleteBtn = document.createElement("button");
    deleteBtn.id = "batchDeleteBtn";
    deleteBtn.type = "button";
    deleteBtn.className = "button ghost danger-button batch-action";
    deleteBtn.addEventListener("click", deleteSelectedItems);
  }

  let downloadBtn = document.querySelector("#batchDownloadBtn");
  if (!downloadBtn) {
    downloadBtn = document.createElement("button");
    downloadBtn.id = "batchDownloadBtn";
    downloadBtn.type = "button";
    downloadBtn.className = "button ghost batch-action";
    downloadBtn.addEventListener("click", downloadSelectedItems);
  }

  let selectAllBtn = document.querySelector("#selectAllBtn");
  if (!selectAllBtn) {
    selectAllBtn = document.createElement("button");
    selectAllBtn.id = "selectAllBtn";
    selectAllBtn.type = "button";
    selectAllBtn.className = "button ghost select-action";
    selectAllBtn.addEventListener("click", selectAll);
  }

  let invertBtn = document.querySelector("#invertSelectBtn");
  if (!invertBtn) {
    invertBtn = document.createElement("button");
    invertBtn.id = "invertSelectBtn";
    invertBtn.type = "button";
    invertBtn.className = "button ghost select-action";
    invertBtn.addEventListener("click", invertSelection);
  }

  const count = getSelectionCount();
  const total = state.currentItems.length;
  if (selectionSummary) {
    selectionSummary.textContent = `已选 ${count} 项`;
  }
  selectAllBtn.textContent = count > 0 && count >= total ? "取消全选" : "全选";
  invertBtn.textContent = "反选";
  moveBtn.textContent = "移动";
  downloadBtn.textContent = "下载";
  deleteBtn.textContent = "删除";
  moveBtn.title = count > 0 ? `移动已选 ${count} 个项目` : "先选择文件再批量移动";
  deleteBtn.title = count > 0 ? `删除已选 ${count} 个项目` : "先选择文件再批量删除";
  downloadBtn.title = count > 0 ? `下载已选 ${count} 个项目` : "先选择文件再批量下载";
  selectAllBtn.title = count > 0 && count >= total ? "取消全选" : "全选当前列表";
  invertBtn.title = "反选当前列表";
  selectAllBtn.disabled = total === 0;
  invertBtn.disabled = total === 0;
  moveBtn.disabled = count === 0;
  deleteBtn.disabled = count === 0;
  downloadBtn.disabled = count === 0;
  const visibleButtons = [selectAllBtn, invertBtn];
  if (can("files.write")) visibleButtons.push(moveBtn);
  if (can("files.download")) visibleButtons.push(downloadBtn);
  if (can("files.write")) visibleButtons.push(deleteBtn);
  for (const button of [moveBtn, downloadBtn, deleteBtn]) {
    if (!visibleButtons.includes(button)) button.remove();
  }
  for (const button of visibleButtons) {
    selectionTools.appendChild(button);
  }
  renderWorkspaceOverview();
}

function renderBreadcrumb() {
  breadcrumb.innerHTML = "";
  if (state.searchQuery) {
    const searchLabel = document.createElement("span");
    searchLabel.className = "crumb is-search";
    searchLabel.textContent = `搜索：${state.searchQuery}`;
    breadcrumb.appendChild(searchLabel);
    return;
  }
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = "crumb";
  rootButton.textContent = state.nsfwMode ? "shared_NSFW" : "shared";
  rootButton.onclick = () => loadDir("");
  // 面包屑拖拽支持
  rootButton.addEventListener("dragover", (e) => {
    if (!isInternalMoveDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    rootButton.classList.add("drag-over");
  });
  rootButton.addEventListener("dragleave", () => rootButton.classList.remove("drag-over"));
  rootButton.addEventListener("drop", async (e) => {
    if (!isInternalMoveDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    rootButton.classList.remove("drag-over");
    const paths = getInternalDragPaths(e.dataTransfer);
    if (paths.length) {
      const ok = await moveItems(paths, "");
      if (ok) { showMessage(`已移动 ${paths.length} 个项目`, "success"); loadDir(state.currentDir); }
    }
  });
  breadcrumb.appendChild(rootButton);

  const parts = state.currentDir ? state.currentDir.split("/") : [];
  let acc = "";
  for (const part of parts) {
    const sep = document.createElement("span");
    sep.textContent = "/";
    sep.className = "sep";
    breadcrumb.appendChild(sep);
    acc = acc ? `${acc}/${part}` : part;
    const targetDir = acc;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "crumb";
    btn.textContent = part;
    btn.onclick = () => loadDir(targetDir);
    // 面包屑拖拽支持
    let navigateTimer = null;
    btn.addEventListener("dragover", (e) => {
      if (!isInternalMoveDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      btn.classList.add("drag-over");
      if (!navigateTimer) {
        navigateTimer = setTimeout(() => {
          loadDir(targetDir);
          navigateTimer = null;
        }, 800);
      }
    });
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("drag-over");
      if (navigateTimer) { clearTimeout(navigateTimer); navigateTimer = null; }
    });
    btn.addEventListener("drop", async (e) => {
      if (!isInternalMoveDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove("drag-over");
      if (navigateTimer) { clearTimeout(navigateTimer); navigateTimer = null; }
      const paths = getInternalDragPaths(e.dataTransfer);
      if (paths.length) {
        const ok = await moveItems(paths, targetDir);
        if (ok) { showMessage(`已移动 ${paths.length} 个项目`, "success"); loadDir(state.currentDir); }
      }
    });
    breadcrumb.appendChild(btn);
  }
  // 显示/隐藏返回上级按钮
  if (upDirBtn) {
    upDirBtn.classList.toggle("is-hidden", !state.currentDir);
  }
}

function loadLazyThumbnail(img) {
  const src = img.dataset.src;
  if (!src || img.dataset.loaded === "1") return;
  img.dataset.loaded = "1";
  img.src = src;
  if (img.dataset.thumbType === "video") {
    scheduleVideoThumbnailRetry(img, src);
  }
}

function scheduleVideoThumbnailRetry(img, baseSrc) {
  const retry = Number(img.dataset.retry || 0);
  if (retry >= 4) return;
  window.setTimeout(() => {
    if (!document.body.contains(img)) return;
    const nextRetry = retry + 1;
    img.dataset.retry = String(nextRetry);
    img.src = `${baseSrc}&retry=${nextRetry}&t=${Date.now()}`;
    scheduleVideoThumbnailRetry(img, baseSrc);
  }, 3500 + retry * 1500);
}

const thumbnailObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      loadLazyThumbnail(entry.target);
      thumbnailObserver.unobserve(entry.target);
    }
  }, { rootMargin: "300px" })
  : null;

function observeLazyThumbnail(img) {
  if (thumbnailObserver) {
    thumbnailObserver.observe(img);
  } else {
    loadLazyThumbnail(img);
  }
}

function buildThumbnail(item, searchDir) {
  const wrapper = document.createElement("div");
  wrapper.className = "name-wrap";

  const thumb = document.createElement("div");
  thumb.className = `thumb ${item.type === "directory" ? "folder" : item.previewType}`;

  if (item.type === "directory") {
    thumb.textContent = "DIR";
    if (item.completed) {
      thumb.classList.add("is-completed")
    }
  } else if (item.previewType === "image") {
    const img = document.createElement("img");
    var thumbBase = "/api/thumb?path=" + encodeURIComponent(item.path) + "&w=200" + (state.nsfwMode ? "&nsfw=1" : "")
    img.dataset.src = thumbBase;
    img.alt = item.name;
    img.loading = "lazy";
    img.decoding = "async";
    thumb.appendChild(img);
    observeLazyThumbnail(img);
  } else if (item.previewType === "video") {
    const img = document.createElement("img");
    var thumbBase2 = "/api/thumb?path=" + encodeURIComponent(item.path) + "&w=200" + (state.nsfwMode ? "&nsfw=1" : "")
    img.dataset.src = thumbBase2;
    img.dataset.thumbType = "video";
    img.alt = item.name;
    img.loading = "lazy";
    img.decoding = "async";
    thumb.appendChild(img);
    observeLazyThumbnail(img);
    const badge = document.createElement("span");
    badge.className = "thumb-badge";
    badge.textContent = "VIDEO";
    thumb.appendChild(badge);
  } else if (item.previewType === "audio") {
    thumb.innerHTML = '<span class="audio-wave">♪</span><span class="thumb-badge">AUDIO</span>';
  } else {
    thumb.textContent = "FILE";
  }

  const meta = document.createElement("div");
  meta.className = "name-meta";
  const title = document.createElement("div");
  title.className = "file-title";
  title.textContent = item.name;
  meta.appendChild(title);

  if (searchDir) {
    const sub = document.createElement("div");
    sub.className = "file-sub";
    sub.textContent = searchDir;
    meta.appendChild(sub);
  } else if (item.previewType !== "none" && item.type === "file") {
    const sub = document.createElement("div");
    sub.className = "file-sub";
    sub.textContent = "双击可预览";
    meta.appendChild(sub);
  }

  wrapper.appendChild(thumb);
  wrapper.appendChild(meta);
  return wrapper;
}

function getPreviewableItems() {
  return state.currentItems.filter((item) =>
    item.previewType === "image"
    || item.previewType === "video"
    || item.previewType === "audio"
  );
}

function openPreview(item) {
  if (item.type === "directory") {
    loadDir(item.path);
    return;
  }
  if (item.previewType === "none") {
    if (!can("files.download")) {
      showMessage("该格式暂不支持游客预览", "error");
      return;
    }
    window.open(fileUrl(item.path), "_blank", "noopener");
    return;
  }
  // 记录当前预览项在可预览列表中的索引
  var previewable = getPreviewableItems();
  state.previewIndex = previewable.findIndex((p) => p.path === item.path);

  showPreviewItem(item);
}

function showPreviewItem(item) {
  previewTitle.textContent = item.name;
  const restrictedPreview = !can("files.download");
  const src = restrictedPreview ? previewUrl(item.path) : fileUrl(item.path);
  const currentType = previewBody.dataset.previewType;

  if (currentType === item.previewType) {
    // 类型相同，直接更新 src，不重建 DOM
    if (item.previewType === "image") {
      var img = previewBody.querySelector("img");
      if (img) {
        img.src = src;
        img.alt = item.name;
        img.draggable = !restrictedPreview;
        img.oncontextmenu = restrictedPreview ? (event) => event.preventDefault() : null;
      }
    } else if (item.previewType === "video") {
      var video = previewBody.querySelector("video");
      if (video) {
        var ext = (item.name || "").toLowerCase().match(/\.(\w+)$/)
        ext = ext ? ext[1] : ""
        if (["mp4", "webm", "ogg"].indexOf(ext) === -1) {
          loadWasmPlayer(video, src, item.name)
        } else {
          video.src = src
          video.play().catch(function() {})
        }
      }
    } else if (item.previewType === "audio") {
      var audio = previewBody.querySelector("audio");
      if (audio) { audio.src = src; audio.play().catch(() => {}); }
    }
  } else {
    // 类型不同，重建 DOM
    previewBody.dataset.previewType = item.previewType;
    previewBody.innerHTML = "";

    if (item.previewType === "image") {
      const img = document.createElement("img");
      img.className = "preview-image";
      img.src = src;
      img.alt = item.name;
      img.draggable = !restrictedPreview;
      if (restrictedPreview) img.addEventListener("contextmenu", (event) => event.preventDefault());
      previewBody.appendChild(img);
    } else if (item.previewType === "video") {
      const video = document.createElement("video");
      video.className = "preview-video";
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      if (restrictedPreview) {
        video.controlsList = "nodownload noremoteplayback";
        video.disablePictureInPicture = true;
        video.disableRemotePlayback = true;
        video.addEventListener("contextmenu", (event) => event.preventDefault());
      }
      previewBody.appendChild(video);
      // 非原生格式走 WASM 转码
      var ext = (item.name || "").toLowerCase().match(/\.(\w+)$/)
      ext = ext ? ext[1] : ""
      if (["mp4", "webm", "ogg"].indexOf(ext) === -1) {
        loadWasmPlayer(video, src, item.name)
      } else {
        video.src = src
      }
    } else if (item.previewType === "audio") {
      previewBody.innerHTML = `
        <div class="audio-preview">
          <div class="audio-art">♪</div>
          <div class="audio-name">${escapeHtml(item.name)}</div>
          <audio class="preview-audio" src="${src}" controls autoplay></audio>
        </div>
      `;
      if (restrictedPreview) {
        const audio = previewBody.querySelector("audio");
        audio.controlsList = "nodownload noremoteplayback";
        audio.disableRemotePlayback = true;
        audio.addEventListener("contextmenu", (event) => event.preventDefault());
      }
    }
  }

  // 更新导航按钮状态
  updatePreviewNav();

  if (typeof previewDialog.showModal === "function") {
    previewDialog.showModal();
  } else {
    previewDialog.setAttribute("open", "open");
  }
}

function updatePreviewNav() {
  var prevBtn = document.querySelector("#previewPrevBtn");
  var nextBtn = document.querySelector("#previewNextBtn");
  var counter = document.querySelector("#previewCounter");
  var previewable = getPreviewableItems();
  var total = previewable.length;
  if (prevBtn) prevBtn.disabled = total <= 1;
  if (nextBtn) nextBtn.disabled = total <= 1;
  if (counter) counter.textContent = total > 0 ? (state.previewIndex + 1) + " / " + total : "";
}

function navigatePreview(direction) {
  var previewable = getPreviewableItems();
  if (previewable.length === 0) return;
  var newIndex = state.previewIndex + direction;
  if (newIndex < 0) newIndex = previewable.length - 1;
  if (newIndex >= previewable.length) newIndex = 0;
  state.previewIndex = newIndex;
  showPreviewItem(previewable[newIndex]);
}

function closePreview() {
  previewBody.innerHTML = "";
  previewBody.dataset.previewType = "";
  state.previewIndex = -1;
  if (previewDialog.open && typeof previewDialog.close === "function") {
    previewDialog.close();
  } else {
    previewDialog.removeAttribute("open");
  }
}

function setViewMode(mode) {
  state.viewMode = mode;
  localStorage.setItem(VIEW_MODE_KEY, mode);
  const isList = mode === "list";
  tableView.classList.toggle("is-hidden", !isList);
  gridView.classList.toggle("is-hidden", isList);
  listViewBtn.classList.toggle("is-active", isList);
  gridViewBtn.classList.toggle("is-active", !isList);
  renderCurrentDirectory();
}

// ========== ffmpeg.wasm 视频播放器（非原生格式） ==========
var _wasmLoading = null
var _wasmMemCache = {}
function loadWasmPlayer(videoEl, fileUrl, fileName) {
  var ext = (fileName || "").toLowerCase().match(/\.(\w+)$/)
  ext = ext ? ext[1] : "mkv"
  var nativeFormats = ["mp4", "webm", "ogg"]

  if (nativeFormats.indexOf(ext) !== -1) {
    videoEl.src = fileUrl
    videoEl.play().catch(function() {})
    return
  }

  // 检查内存缓存
  var cacheKey = fileUrl
  if (_wasmMemCache[cacheKey]) {
    videoEl.src = _wasmMemCache[cacheKey]
    videoEl.play().catch(function() {})
    return
  }

  // 显示加载状态
  videoEl.style.display = "none"
  var statusEl = document.createElement("div")
  statusEl.className = "wasm-status"
  statusEl.innerHTML = '<div class="wasm-spinner"></div><div class="wasm-text">正在准备播放器...</div>'
  videoEl.parentNode.insertBefore(statusEl, videoEl)

  function setStatus(text) {
    var t = statusEl.querySelector(".wasm-text")
    if (t) t.textContent = text
  }

  // 动态加载 ffmpeg.wasm
  if (!_wasmLoading) {
    _wasmLoading = (async function() {
      var m = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js')
      var u = await import('/node_modules/@ffmpeg/util/dist/esm/index.js')
      return { FFmpeg: m.FFmpeg, fetchFile: u.fetchFile, toBlobURL: u.toBlobURL }
    })()
  }

  _wasmLoading.then(async function(ffmpegLib) {
    try {
      setStatus("正在下载视频...")
      var headRes = await fetch(fileUrl, { method: "HEAD" }).catch(function() { return null })
      var fileSize = headRes ? parseInt(headRes.headers.get("content-length") || "0") : 0
      if (fileSize > 1073741824) setStatus("大文件转码中，请耐心等待...")

      var inputName = "input." + ext
      var outputName = "output.mp4"

      var ffmpeg = new ffmpegLib.FFmpeg()
      ffmpeg.on("progress", function(_) {
        var pct = Math.round(_.progress * 100)
        if (isFinite(pct)) setStatus("转码中... " + pct + "%")
      })

      setStatus("加载解码器...")
      var baseURL = location.origin + "/wasm"
      await ffmpeg.load({
        coreURL: await ffmpegLib.toBlobURL(baseURL + "/ffmpeg-core.js", "text/javascript"),
        wasmURL: await ffmpegLib.toBlobURL(baseURL + "/ffmpeg-core.wasm", "application/wasm"),
      })

      setStatus("正在下载视频...")
      await ffmpeg.writeFile(inputName, await ffmpegLib.fetchFile(fileUrl))

      setStatus("转码中...（快速模式）")
      // 先尝试快速复制模式（不重新编码）
      var remuxOk = false
      try {
        await ffmpeg.exec([
          "-i", inputName,
          "-c:v", "copy",
          "-c:a", "copy",
          "-movflags", "+faststart+frag_keyframe+empty_moov",
          "-y",
          outputName
        ])
        var s = await ffmpeg.readFile(outputName)
        if (s && s.byteLength > 0) remuxOk = true
      } catch (_) {}

      if (!remuxOk) {
        setStatus("转码中...（编码模式，较慢）")
        // 复制模式失败 → 重新编码（兼容所有格式，但吃 CPU）
        await ffmpeg.exec([
          "-i", inputName,
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "23",
          "-c:a", "aac",
          "-movflags", "+faststart+frag_keyframe+empty_moov",
          "-y",
          outputName
        ])
      }

      setStatus("加载到播放器...")
      var data = await ffmpeg.readFile(outputName)
      var blob = new Blob([data.buffer], { type: "video/mp4" })
      var blobUrl = URL.createObjectURL(blob)

      _wasmMemCache[cacheKey] = blobUrl
      videoEl.src = blobUrl
      videoEl.style.display = ""
      statusEl.remove()
      videoEl.play().catch(function() {})

    } catch (err) {
      console.error("WASM 播放失败:", err)
      setStatus("转码失败: " + (err.message || JSON.stringify(err)))
      var a = document.createElement("a")
      a.href = fileUrl
      a.textContent = "下载文件"
      a.style.color = "var(--accent)"
      a.style.marginTop = "8px"
      statusEl.appendChild(document.createElement("br"))
      statusEl.appendChild(a)
    }
  })
}

const RESIZABLE_TABLE_COLUMNS = {
  name: { selector: ".col-name", min: 280, max: 1000, defaultWidth: 320 },
  size: { selector: ".col-size", min: 80, max: 200, defaultWidth: 100 },
  born: { selector: ".col-born", min: 120, max: 280, defaultWidth: 150 },
  date: { selector: ".col-time", min: 120, max: 280, defaultWidth: 150 }
};

const SORT_LABELS = { name: "名称", size: "大小", born: "上传时间", date: "修改时间" };
const FIXED_TABLE_COLUMN_WIDTH = 96 + 310;

function ensureSortHeaderContent(th) {
  let label = th.querySelector(".sort-label");
  if (label) return label;

  const existingHandle = th.querySelector(".column-resizer");
  const labelText = SORT_LABELS[th.dataset.sort] || th.textContent.trim();
  if (existingHandle) existingHandle.remove();
  th.textContent = "";

  label = document.createElement("span");
  label.className = "sort-label";
  label.textContent = labelText;
  th.appendChild(label);
  if (existingHandle) th.appendChild(existingHandle);
  return label;
}

function getSavedColumnWidths() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveColumnWidths(widths) {
  localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(widths));
}

function clampColumnWidth(key, width, currentWidths = getSavedColumnWidths()) {
  const config = RESIZABLE_TABLE_COLUMNS[key];
  if (!config) return width;
  // 计算可用最大宽度：容器可视宽度 - 其他可调列的最小宽度 - 固定列宽度
  const tableWrap = fileTable ? fileTable.closest(".table-wrap") : null
  const containerWidth = tableWrap ? tableWrap.clientWidth : window.innerWidth
  // 其他列的实际宽度（防止已扩大的列占用操作栏空间）
  var otherWidth = FIXED_TABLE_COLUMN_WIDTH
  for (var k in RESIZABLE_TABLE_COLUMNS) {
    if (k === key) continue
    var w = Number(currentWidths[k]) || RESIZABLE_TABLE_COLUMNS[k].defaultWidth
    otherWidth += Math.max(RESIZABLE_TABLE_COLUMNS[k].min, Math.min(RESIZABLE_TABLE_COLUMNS[k].max, w))
  }
  const dynamicMax = Math.max(config.min, containerWidth - otherWidth - 40)
  return Math.max(config.min, Math.min(dynamicMax, Math.round(width)));
}

function updateTableMinWidth(widths) {
  if (!fileTable) return;
  const minimumWidth = Object.entries(RESIZABLE_TABLE_COLUMNS).reduce((sum, [key, config]) => {
    return sum + Number(widths[key] || config.defaultWidth);
  }, FIXED_TABLE_COLUMN_WIDTH);
  fileTable.style.minWidth = `${minimumWidth}px`;
}

function applyColumnWidths(widths = getSavedColumnWidths()) {
  if (!fileTable) return;
  const appliedWidths = {};
  let savedWidthsChanged = false;
  for (const [key, config] of Object.entries(RESIZABLE_TABLE_COLUMNS)) {
    const col = fileTable.querySelector(config.selector);
    if (!col) continue;
    const width = Number(widths[key]);
    if (Number.isFinite(width)) {
      const clampedWidth = clampColumnWidth(key, width, widths);
      col.style.width = `${clampedWidth}px`;
      appliedWidths[key] = clampedWidth;
      if (clampedWidth !== width) {
        widths[key] = clampedWidth;
        savedWidthsChanged = true;
      }
    } else {
      col.style.width = "";
      appliedWidths[key] = config.defaultWidth;
      if (Object.prototype.hasOwnProperty.call(widths, key)) {
        delete widths[key];
        savedWidthsChanged = true;
      }
    }
  }
  updateTableMinWidth(appliedWidths);
  if (savedWidthsChanged) saveColumnWidths(widths);
}

function setColumnWidth(key, width) {
  const widths = getSavedColumnWidths();
  widths[key] = clampColumnWidth(key, width, widths);
  saveColumnWidths(widths);
  applyColumnWidths(widths);
}

function resetColumnWidth(key) {
  const widths = getSavedColumnWidths();
  delete widths[key];
  saveColumnWidths(widths);
  applyColumnWidths(widths);
}

function startColumnResize(event, th, handle) {
  const key = th.dataset.resizeColumn;
  const config = RESIZABLE_TABLE_COLUMNS[key];
  if (!config || !fileTable) return;

  event.preventDefault();
  event.stopPropagation();

  const startX = event.clientX;
  const startWidth = th.getBoundingClientRect().width;
  document.body.classList.add("is-column-resizing");
  th.classList.add("is-resizing");
  if (handle && typeof handle.setPointerCapture === "function") {
    handle.setPointerCapture(event.pointerId);
  }

  const onMove = (moveEvent) => {
    moveEvent.preventDefault();
    setColumnWidth(key, startWidth + moveEvent.clientX - startX);
  };

  const stop = () => {
    document.body.classList.remove("is-column-resizing");
    th.classList.remove("is-resizing");
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", stop);
    document.removeEventListener("pointercancel", stop);
    if (handle && typeof handle.releasePointerCapture === "function") {
      try { handle.releasePointerCapture(event.pointerId); } catch {}
    }
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", stop);
  document.addEventListener("pointercancel", stop);
}

function initColumnResize() {
  if (!fileTable) return;
  applyColumnWidths();
  document.querySelectorAll("th[data-resize-column]").forEach((th) => {
    ensureSortHeaderContent(th);
    if (th.querySelector(".column-resizer")) return;
    th.classList.add("is-resizable");
    const handle = document.createElement("span");
    handle.className = "column-resizer";
    handle.title = "拖动调整列宽，双击恢复默认";
    handle.addEventListener("click", (event) => event.stopPropagation());
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetColumnWidth(th.dataset.resizeColumn);
    });
    handle.addEventListener("pointerdown", (event) => startColumnResize(event, th, handle));
    th.appendChild(handle);
  });
  window.addEventListener("resize", () => applyColumnWidths());
}

// Theme color pairs for interpolation [light, dark]
const THEME_COLORS = {
  "--bg":           ["#f5f5f5", "#141210"],
  "--panel":        ["#ffffff", "#201e1a"],
  "--panel-strong": ["#ffffff", "#26231e"],
  "--panel-hover":  ["#f3f4f6", "#302c26"],
  "--panel-soft":   ["#f9fafb", "#221f1b"],
  "--line":         ["#e5e5e5", "#35312c"],
  "--text":         ["#1a1a1a", "#e2dcd4"],
  "--muted":        ["#6b7280", "#948c82"],
  "--accent":       ["#0d9488", "#d65a3a"],
  "--accent-2":     ["#0d9488", "#c14c2e"],
  "--accent-text":  ["#ffffff", "#141210"],
  "--floating-bg":  ["#1f2937", "#e2dcd4"],
  "--floating-text":["#ffffff", "#141210"]
};

const STYLE_PALETTES = {
  classic: THEME_COLORS,
  editorial: {
    "--bg":           ["#c8cfbe", "#16140f"],
    "--panel":        ["#d0d7c7", "#201d15"],
    "--panel-strong": ["#d0d7c7", "#252119"],
    "--panel-hover":  ["#c6cebb", "#2c2820"],
    "--panel-soft":   ["#c1c9b5", "#1c1a13"],
    "--line":         ["#b3bba9", "#3b362a"],
    "--text":         ["#20261d", "#e8e2d2"],
    "--muted":        ["#4f5949", "#8d8571"],
    "--accent":       ["#4a7c59", "#d65a3a"],
    "--accent-2":     ["#315f40", "#b9472c"],
    "--accent-text":  ["#ffffff", "#16140f"],
    "--floating-bg":  ["#20261d", "#e8e2d2"],
    "--floating-text":["#c8cfbe", "#16140f"],
    "--paper-deep":   ["#bcc4b0", "#1a1712"],
    "--ink-soft":     ["#434f3a", "#b5ad99"],
    "--line-soft":    ["#bac2ae", "#2e2a20"],
    "--s-blue":       ["#2f6db3", "#6aa3e0"],
    "--s-amber":      ["#a87b24", "#d3a04a"],
    "--s-green":      ["#3e7c4f", "#6fb585"],
    "--workspace-tone":["#5f6468", "#aeb4b8"],
    "--collab-tone":   ["#77736f", "#beb8b2"],
    "--danger":       ["#b23b3b", "#d96454"],
    "--success":      ["#3e7c4f", "#6fb585"]
  }
};

function hexToRgb(hex) {
  const c = hex.replace("#","");
  return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
}

function lerpColor(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const r = Math.round(ca[0] + (cb[0]-ca[0])*t);
  const g = Math.round(ca[1] + (cb[1]-ca[1])*t);
  const b_ = Math.round(ca[2] + (cb[2]-ca[2])*t);
  return `rgb(${r},${g},${b_})`;
}

let appliedThemeKeys = [];
function applyThemePos(pos) {
  state.themePos = pos;
  state.theme = pos < 50 ? "light" : "dark";
  document.body.dataset.theme = state.theme;
  document.body.style.colorScheme = state.theme;
  localStorage.setItem(THEME_POS_KEY, String(pos));
  localStorage.setItem(THEME_KEY, state.theme);
  const btn = document.querySelector("#themeToggleBtn");
  if (btn) {
    btn.title = pos < 50 ? "切换" : "切换";
    var sun = btn.querySelector(".tgl-sun"), moon = btn.querySelector(".tgl-moon");
    if (sun && moon) { sun.style.display = pos < 50 ? "" : "none"; moon.style.display = pos < 50 ? "none" : ""; }
  }
  const t = pos / 100;
  const palette = STYLE_PALETTES.editorial;
  for (var key of appliedThemeKeys) {
    if (!Object.prototype.hasOwnProperty.call(palette, key)) document.body.style.removeProperty(key);
  }
  for (var [key, [light, dark]] of Object.entries(palette)) {
    document.body.style.setProperty(key, lerpColor(light, dark, t));
  }
  appliedThemeKeys = Object.keys(palette);
}

function applyTheme(theme) {
  applyThemePos(theme === "dark" ? 100 : 0);
}

function toggleTheme() {
  applyThemePos(state.themePos < 50 ? 100 : 0);
}

function isSelected(path) {
  return state.selectedPaths.has(path);
}

function toggleSelected(path, checked) {
  if (checked) state.selectedPaths.add(path);
  else state.selectedPaths.delete(path);
  updateToolbarButtons();
}

function syncItemSelectionUi(path) {
  const selected = isSelected(path);
  document.querySelectorAll("[data-item-path]").forEach((el) => {
    if (el.dataset.itemPath !== path) return;
    el.classList.toggle("is-selected", selected);
    el.querySelectorAll(".select-checkbox").forEach((input) => {
      input.checked = selected;
    });
  });
}

function setSelected(path, checked) {
  toggleSelected(path, checked);
  syncItemSelectionUi(path);
}

let pendingItemClickTimer = null;

function cancelPendingItemClick() {
  if (!pendingItemClickTimer) return;
  clearTimeout(pendingItemClickTimer);
  pendingItemClickTimer = null;
}

function isItemClickIgnored(event) {
  const target = event.target;
  return Boolean(target.closest("button, a, input, label, select, textarea, .grid-actions, .op-cell"));
}

function handleItemClick(event, item) {
  if (isItemClickIgnored(event)) return;
  cancelPendingItemClick();
  if (state.selectedPaths.size > 0) {
    setSelected(item.path, !isSelected(item.path));
    return;
  }
  pendingItemClickTimer = window.setTimeout(() => {
    pendingItemClickTimer = null;
    setSelected(item.path, !isSelected(item.path));
  }, 120);
}

function handleItemDoubleClick(event, item) {
  if (isItemClickIgnored(event)) return;
  cancelPendingItemClick();
  openPreview(item);
}

function clearSelections() {
  state.selectedPaths.clear();
  updateToolbarButtons();
}

function copyItem(item) {
  state.clipboard = { items: [item.path], mode: "copy" }
  document.querySelectorAll(".cut-clip, .copy-clip").forEach(function(el) { el.classList.remove("cut-clip", "copy-clip") })
  var row = document.querySelector('[data-item-path="' + item.path.replace(/"/g, '') + '"]')
  if (row) row.classList.add("copy-clip")
  showMessage("已复制到剪贴板", "success")
}

async function pasteFromClipboard() {
  var items = state.clipboard.items, mode = state.clipboard.mode
  if (!items.length) return
  try {
    if (mode === "copy") {
      var res = await apiFetch("/api/copy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: items, targetDir: state.currentDir }) })
      var data = await parseJsonResponse(res)
      if (!res.ok) { showMessage(data.error || "粘贴失败", "error"); return }
      showMessage("已粘贴 " + data.copied + " 个项目", "success")
    } else {
      var ok = await moveItems(items, state.currentDir)
      if (ok) showMessage("已粘贴 " + items.length + " 个项目", "success")
    }
  } catch(e) { showMessage(e.message || "粘贴失败", "error") }
  state.clipboard = { items: [], mode: null }
  await loadDir(state.currentDir)
}

function selectAll() {
  const total = state.currentItems.length;
  const count = state.selectedPaths.size;
  if (count < total) {
    for (const item of state.currentItems) state.selectedPaths.add(item.path);
  } else {
    state.selectedPaths.clear();
  }
  updateToolbarButtons();
  renderCurrentDirectory();
}

function invertSelection() {
  const newSet = new Set();
  for (const item of state.currentItems) {
    if (!state.selectedPaths.has(item.path)) newSet.add(item.path);
  }
  state.selectedPaths = newSet;
  updateToolbarButtons();
  renderCurrentDirectory();
}

function getFilteredCurrentItems() {
  var items = state.currentItems;
  // 搜索过滤
  var keyword = state.searchFilter.trim().toLowerCase();
  if (keyword) {
    items = items.filter(function(item) {
      return item.name.toLowerCase().indexOf(keyword) !== -1 || item.path.toLowerCase().indexOf(keyword) !== -1
    })
  }
  // 状态过滤
  var fs = state.filterStatus
  if (fs && fs !== "all") {
    items = items.filter(function(item) { return item.status === fs })
  }
  return items
}

function sortItems(items) {
  const sorted = [...items];
  if (items._stoppedEarly) sorted._stoppedEarly = items._stoppedEarly;
  const { sortKey, sortAsc } = state;

  // 提取集数：第一集→1，第二集→2，第十集→10，第二十一集→21
  function extractNum(s) {
    const text = String(s || "");
    const patterns = [
      /第\s*([零〇一二两三四五六七八九十百千\d]+)\s*(?=集|话|章|回|卷|部|季|期|篇|$)/,
      /\b(?:ep|e)(\d+)\b/i,
      /(^|[^\d])(\d+)\s*(?=集|话|章|回|卷|部|季|期|篇|$)/
    ];
    const digits = { "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
    const units = { "十": 10, "百": 100, "千": 1000 };
    function parseChineseNumber(value) {
      let total = 0;
      let current = 0;
      for (const char of value) {
        if (digits[char] !== undefined) {
          current = digits[char];
          continue;
        }
        if (units[char] !== undefined) {
          total += (current || 1) * units[char];
          current = 0;
          continue;
        }
        return null;
      }
      return total + current;
    }
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const raw = match[1] && /^\d+$/.test(match[1]) ? match[1] : match[2] || match[1];
      if (!raw) continue;
      if (/^\d+$/.test(raw)) return Number(raw);
      const parsed = parseChineseNumber(raw);
      if (parsed != null) return parsed;
    }
    return null;
  }

  sorted.sort((a, b) => {
    // 按状态排序：进行中 > 待开始 > 已完成
    var so = { in_progress: 0, not_started: 1, completed: 2 }
    var sa = so[a.status] !== undefined ? so[a.status] : 0
    var sb = so[b.status] !== undefined ? so[b.status] : 0
    if (sa !== sb) return sa - sb
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    let cmp = 0;
    if (sortKey === "name") {
      const na = extractNum(a.name);
      const nb = extractNum(b.name);
      if (na !== null && nb !== null) { cmp = na - nb; }
      else { cmp = a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" }); }
    } else if (sortKey === "size") {
      const sa = a.folderSize != null ? a.folderSize : (a.size || 0);
      const sb = b.folderSize != null ? b.folderSize : (b.size || 0);
      cmp = sa - sb;
    } else if (sortKey === "born") {
      cmp = String(a.bornAt || "").localeCompare(String(b.bornAt || ""));
    } else if (sortKey === "date") {
      cmp = String(a.updatedAt || "").localeCompare(String(b.updatedAt || ""));
    }
    return sortAsc ? cmp : -cmp;
  });
  return sorted;
}

function toggleSort(key) {
  if (state.sortKey === key) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortKey = key;
    state.sortAsc = true;
  }
  updateSortButtons();
  renderCurrentDirectory();
}

function updateSortButtons() {
  document.querySelectorAll(".sort-th").forEach((th) => {
    const k = th.dataset.sort;
    const active = state.sortKey === k;
    th.classList.toggle("sort-active", active);
    th.classList.toggle("sort-desc", active && !state.sortAsc);
    ensureSortHeaderContent(th).textContent = SORT_LABELS[k];
  });
}

function renderCurrentDirectory() {
  closeStatusMenus();
  updateFilterByDir()
  renderBreadcrumb();
  if (state.searchQuery) {
    const items = sortItems(state.searchResults);
    const count = items.length;
    const suffix = items._stoppedEarly ? `（仅前 ${count} 项，请缩小搜索范围）` : count > 0 ? `（共 ${count} 项）` : "";
    showMessage(`搜索"${state.searchQuery}"${suffix}`, "info");
    renderRows(items, true);
  } else {
    renderRows(sortItems(getFilteredCurrentItems()), false);
  }
  updateToolbarButtons();
}

function makeSelectCheckbox(item) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "select-checkbox";
  input.checked = isSelected(item.path);
  input.title = "选择项目";
  input.setAttribute("aria-label", `选择 ${item.name}`);
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", (event) => {
    setSelected(item.path, event.target.checked);
    input.blur();
  });
  return input;
}

function validatePlainName(name, emptyMessage = "名称不能为空") {
  if (!name.trim()) return emptyMessage;
  if (/[<>:"/\\|?*]/.test(name)) return "名称不能包含这些字符：< > : \" / \\ | ? *";
  return "";
}

async function renameItem(item) {
  const isFile = item.type === "file";
  const extensionIndex = isFile ? item.name.lastIndexOf(".") : -1;
  const hasExtension = isFile && extensionIndex > 0;
  const baseName = hasExtension ? item.name.slice(0, extensionIndex) : item.name;
  const extension = hasExtension ? item.name.slice(extensionIndex) : "";
  const inputName = await openInputDialog({
    title: `重命名：${item.name}`,
    label: isFile ? "只修改主文件名，后缀会自动保留" : "请输入新的文件夹名称",
    value: baseName,
    suffix: extension,
    hint: hasExtension ? `最终名称会保留原后缀：${extension}` : "",
    confirmText: "重命名",
    validate: function(value) {
      var e = validatePlainName(value, "新名称不能为空")
      if (e) return e
      if (value.trim().startsWith(".")) return "名称不能以 . 开头"
      return ""
    }
  });
  if (inputName == null) return;
  let trimmedName = String(inputName).trim();
  if (!trimmedName) return;
  if (hasExtension && trimmedName.toLowerCase().endsWith(extension.toLowerCase())) {
    trimmedName = trimmedName.slice(0, -extension.length).trim();
  }
  if (!trimmedName) return;
  const newName = `${trimmedName}${extension}`;
  if (newName === item.name) return;
  const res = await apiFetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: item.path, newName })
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) {
    showMessage(data.error || "重命名失败", "error");
    return;
  }
  showMessage(`已重命名为：${newName}`, "success");
  await loadDir(state.currentDir);
}

async function deleteItems(paths, labelText) {
  const res = await apiFetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths })
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) {
    showMessage(data.error || "删除失败", "error");
    return false;
  }
  // 记录撤销信息
  const deletedItems = Array.isArray(data.deleted) && data.deleted.length > 0
    ? data.deleted.map((item) => ({
      id: item.id,
      name: item.name,
      originalPath: item.originalPath || item.path || ""
    }))
    : paths.map((itemPath) => ({
      id: "",
      name: itemPath.split("/").pop(),
      originalPath: itemPath
    }));
  pushUndo({ type: "delete", items: deletedItems, sourceDir: state.currentDir, user: state.nickname || "anonymous", timestamp: Date.now() });
  showMessage(`已移入回收站${labelText}`, "success");
  await loadRecycleItems();
  return true;
}

// ========== 右键菜单 ==========
var ctxMenu = null
function showContextMenu(items, x, y) {
  hideContextMenu()
  ctxMenu = document.createElement("div")
  ctxMenu.className = "ctx-menu"
  ctxMenu.style.left = x + "px"
  ctxMenu.style.top = y + "px"
  for (let i = 0; i < items.length; i++) {
    let item = items[i]
    if (item.sep) {
      var sep = document.createElement("div")
      sep.className = "ctx-sep"
      ctxMenu.appendChild(sep)
      continue
    }
    var btn = document.createElement("button")
    btn.className = "ctx-item" + (item.danger ? " ctx-danger" : "")
    btn.textContent = item.label
    btn.addEventListener("click", function() {
      hideContextMenu()
      item.action()
    })
    ctxMenu.appendChild(btn)
  }
  document.body.appendChild(ctxMenu)
  // 防止溢出
  var rect = ctxMenu.getBoundingClientRect()
  if (rect.right > window.innerWidth) ctxMenu.style.left = (x - rect.width) + "px"
  if (rect.bottom > window.innerHeight) ctxMenu.style.top = (y - rect.height) + "px"
}

function hideContextMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null }
}

document.addEventListener("click", hideContextMenu)
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape") hideContextMenu()
})
document.addEventListener("contextmenu", function(e) {
  var target = e.target.closest(".interactive-row, .grid-card")
  if (target) {
    e.preventDefault()
    var item = target.__itemData
    if (!item) return

  var menuItems = []
  const canWrite = can("files.write")
  const canDownload = can("files.download")
  if (item.type === "directory") {
    menuItems.push({ label: "打开", action: function() { loadDir(item.path) } })
    if (canWrite) {
      menuItems.push({ sep: true })
      menuItems.push({ label: "待开始", action: function() { setItemStatus(item, "not_started") } })
      menuItems.push({ label: "进行中", action: function() { setItemStatus(item, "in_progress") } })
      menuItems.push({ label: "已完成", action: function() { setItemStatus(item, "completed") } })
      menuItems.push({ sep: true })
      menuItems.push({ label: "重命名", action: function() { renameItem(item) } })
      menuItems.push({ label: "复制", action: function() { copyItem(item) } })
      menuItems.push({ label: "移动", action: function() { moveItem(item) } })
      menuItems.push({ sep: true })
      menuItems.push({ label: "删除", action: function() { deleteItem(item) }, danger: true })
    }
  } else {
    if (item.previewType !== "none") {
      menuItems.push({ label: "预览", action: function() { openPreview(item) } })
    }
    if (canDownload) {
      menuItems.push({ label: "下载", action: function() {
        var a = document.createElement("a")
        a.href = "/download?path=" + encodeURIComponent(item.path) + (state.nsfwMode ? "&nsfw=1" : "")
        a.click()
      }})
    }
    if (canWrite) {
      menuItems.push({ sep: true })
      menuItems.push({ label: "重命名", action: function() { renameItem(item) } })
      menuItems.push({ label: "复制", action: function() { copyItem(item) } })
      menuItems.push({ label: "移动", action: function() { moveItem(item) } })
      menuItems.push({ sep: true })
      menuItems.push({ label: "删除", action: function() { deleteItem(item) }, danger: true })
    }
  }
  showContextMenu(menuItems, e.clientX, e.clientY)
  } else if (!e.target.closest("input, textarea, button, a, select, label")) {
    e.preventDefault()
    showContextMenu([
      ...(can("files.write") ? [
        { label: "上传文件", action: function() { var b = document.querySelector("#fileInput"); if (b) b.click() } },
        { label: "上传文件夹", action: function() { var b = document.querySelector("#folderInput"); if (b) b.click() } },
        { sep: true },
        { label: "新建文件夹", action: function() { createFolder() } },
        { label: "新建项目", action: function() { var b = document.querySelector("#createProjectBtn"); if (b) b.click() } },
        { sep: true }
      ] : []),
      { label: "全选", action: function() { selectAll() } },
      ...(can("files.write") && state.clipboard.items.length ? [{ label: "粘贴", action: function() { pasteFromClipboard() } }] : []),
      { label: "刷新", action: function() { loadDir(state.currentDir) } },
      { label: "返回上级", action: function() { var b = document.querySelector("#upDirBtn"); if (b && !b.classList.contains("is-hidden")) b.click() } },
      { sep: true },
      { label: state.viewMode === "grid" ? "列表视图" : "宫格视图", action: function() { setViewMode(state.viewMode === "grid" ? "list" : "grid") } }
    ], e.clientX, e.clientY)
  }
})

async function setItemStatus(item, status) {
  var res = await apiFetch("/api/set-status", {
    method: "POST",
    body: JSON.stringify({ path: item.path, status: status })
  })
  if (res.error) { showMessage(res.error, "error"); return }
  item.status = status
  var row = document.querySelector('[data-item-path="' + item.path.replace(/"/g, '') + '"]')
  if (row) {
    row.classList.remove("is-completed", "is-in-progress")
    if (status === "completed") row.classList.add("is-completed")
    else if (status === "in_progress") row.classList.add("is-in-progress")
    var selEl = row.querySelector(".status-badge")
    if (selEl) {
      selEl.textContent = statusLabels[status] || "待开始"
      selEl.classList.remove("is-in-progress", "is-completed")
      if (status === "in_progress") selEl.classList.add("is-in-progress")
      if (status === "completed") selEl.classList.add("is-completed")
    }
  }
  renderWorkspaceOverview()
  loadInProgressProjects()
}

var _statusLabels = { completed: "已完成", in_progress: "进行中", not_started: "待开始" }
var statusLabels = _statusLabels
var _statusColors = { completed: "#22c55e", in_progress: "#3b82f6", not_started: "" }
function setStatusBadgeColor(el, status) {
  el.classList.remove("is-in-progress", "is-completed")
  if (status === "in_progress") el.classList.add("is-in-progress")
  if (status === "completed") el.classList.add("is-completed")
}

async function deleteItem(item) {
  const label = item.type === "directory" ? "文件夹" : "文件";
  const confirmed = await openConfirmDialog({
    title: `删除${label}`,
    message: "项目会先移入回收站，可以从回收站恢复。",
    items: [item.path],
    confirmText: "移入回收站",
    danger: true
  });
  if (!confirmed) return;
  if (await deleteItems([item.path], `：${item.name}`)) {
    state.selectedPaths.delete(item.path);
    await loadDir(state.currentDir);
  }
}

async function moveItems(paths, targetDir, forceOverwrite = false) {
  finishInternalMoveDragUi();
  let overwriteExisting = forceOverwrite;
  if (!overwriteExisting) {
    try {
      const conflicts = await checkConflicts({
        operation: "move",
        paths,
        targetDir
      });
      if (conflicts.length > 0) {
        const confirmed = await confirmOverwriteConflicts({
          title: "目标位置有同名项目",
          message: "确认后会覆盖目标位置的同名项目，旧项目会移入回收站；取消则不会移动任何文件。",
          conflicts,
          confirmText: "覆盖并移动"
        });
        if (!confirmed) {
          showMessage("已取消移动", "info");
          return false;
        }
        overwriteExisting = true;
      }
    } catch (error) {
      showMessage(error.message || "移动前检查失败", "error");
      return false;
    }
  }

  const res = await apiFetch("/api/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, targetDir, overwrite: overwriteExisting })
  });
  const data = await parseJsonResponse(res);
  if (!res.ok && res.status === 409 && Array.isArray(data.conflicts) && data.conflicts.length > 0 && !overwriteExisting) {
    const confirmed = await confirmOverwriteConflicts({
      title: "目标位置有同名项目",
      message: "确认后会覆盖目标位置的同名项目，旧项目会移入回收站；取消则不会移动任何文件。",
      conflicts: data.conflicts,
      confirmText: "覆盖并移动"
    });
    if (!confirmed) {
      showMessage("已取消移动", "info");
      return false;
    }
    return await moveItems(paths, targetDir, true);
  }
  if (!res.ok) {
    showMessage(data.error || "移动失败", "error");
    return false;
  }
  if (!Array.isArray(data.moved) || data.moved.length === 0) {
    showMessage("项目已在目标文件夹中，无需移动", "info");
    return false;
  }
  // 记录撤销信息
  pushUndo({ type: "move", items: paths, targetDir, sourceDir: state.currentDir, user: state.nickname || "anonymous", timestamp: Date.now() });
  return true;
}

function renderMoveBreadcrumb() {
  moveDialogBreadcrumb.innerHTML = "";
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = "crumb";
  rootButton.textContent = state.nsfwMode ? "shared_NSFW" : "shared";
  rootButton.onclick = () => loadMoveDialogDir("");
  moveDialogBreadcrumb.appendChild(rootButton);

  const parts = state.moveTargetDir ? state.moveTargetDir.split("/") : [];
  let acc = "";
  for (const part of parts) {
    const sep = document.createElement("span");
    sep.textContent = "/";
    sep.className = "sep";
    moveDialogBreadcrumb.appendChild(sep);
    acc = acc ? `${acc}/${part}` : part;
    const targetDir = acc;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "crumb";
    btn.textContent = part;
    btn.onclick = () => loadMoveDialogDir(targetDir);
    moveDialogBreadcrumb.appendChild(btn);
  }
}

function renderMoveDirectoryList() {
  moveDialogList.innerHTML = "";
  const keyword = state.moveFilter.trim().toLowerCase();

  if (state.moveTargetDir) {
    const upItem = document.createElement("button");
    upItem.type = "button";
    upItem.className = "move-folder-item up";
    upItem.textContent = ".. 返回上级";
    upItem.onclick = () => {
      const parts = state.moveTargetDir.split("/");
      parts.pop();
      loadMoveDialogDir(parts.join("/"));
    };
    moveDialogList.appendChild(upItem);
  }

  const directories = state.moveDirectories.filter((item) => item.name.toLowerCase().includes(keyword));
  if (!directories.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = keyword ? "没有匹配的子文件夹。" : "当前文件夹下没有子文件夹，可以直接移动到这里。";
    moveDialogList.appendChild(empty);
    return;
  }

  for (const item of directories) {
    const row = document.createElement("div");
    row.className = "move-folder-row";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "move-folder-item";
    name.textContent = item.name;
    name.onclick = () => loadMoveDialogDir(item.path);
    row.appendChild(name);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "button ghost";
    openBtn.textContent = "进入";
    openBtn.onclick = () => loadMoveDialogDir(item.path);
    row.appendChild(openBtn);

    moveDialogList.appendChild(row);
  }
}

async function loadMoveDialogDir(dir) {
  state.moveTargetDir = dir;
  state.moveFilter = "";
  moveSearchInput.value = "";
  moveDialogCurrent.textContent = `当前目标：shared${dir ? `/${dir}` : ""}`;
  moveDialogList.innerHTML = "";
  renderMoveBreadcrumb();
  showMoveDialogMessage("", "info");

  const res = await apiFetch(`/api/list?dir=${encodeURIComponent(dir)}`);
  const data = await res.json();
  if (!res.ok) {
    showMoveDialogMessage(data.error || "读取文件夹失败", "error");
    return;
  }

  state.moveDirectories = data.items.filter((item) => item.type === "directory");
  renderMoveDirectoryList();
}

async function openMoveDialog(paths, titleText) {
  state.movePaths = paths;
  moveDialogTitle.textContent = titleText;
  await loadMoveDialogDir(state.currentDir);
  if (typeof moveDialog.showModal === "function") {
    moveDialog.showModal();
  } else {
    moveDialog.setAttribute("open", "open");
  }
}

function closeMoveDialog() {
  if (moveDialog.open && typeof moveDialog.close === "function") {
    moveDialog.close();
  } else {
    moveDialog.removeAttribute("open");
  }
  state.movePaths = [];
  state.moveTargetDir = "";
  moveDialogList.innerHTML = "";
}

async function moveItem(item) {
  await openMoveDialog([item.path], `移动：${item.name}`);
}

async function deleteSelectedItems() {
  const paths = [...state.selectedPaths];
  if (paths.length === 0) return;
  const confirmed = await openConfirmDialog({
    title: `批量删除 ${paths.length} 项`,
    message: "以下项目会先移入回收站，可以从回收站恢复。",
    items: paths,
    confirmText: "批量移入回收站",
    danger: true
  });
  if (!confirmed) return;
  if (await deleteItems(paths, ` ${paths.length} 项`)) {
    clearSelections();
    await loadDir(state.currentDir);
  }
}

async function moveSelectedItems() {
  const paths = [...state.selectedPaths];
  if (paths.length === 0) return;
  await openMoveDialog(paths, `批量移动 ${paths.length} 项`);
}

async function createMoveTargetFolder() {
  const name = await openInputDialog({
    title: "新建目标文件夹",
    label: `创建位置：shared${state.moveTargetDir ? `/${state.moveTargetDir}` : ""}`,
    confirmText: "创建",
    validate: function(value) {
      var e = validatePlainName(value, "文件夹名称不能为空")
      if (e) return e
      if (value.trim().startsWith(".")) return "名称不能以 . 开头"
      return ""
    }
  });
  if (name == null) return;
  const res = await apiFetch("/api/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: state.moveTargetDir, name: name.trim() })
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) {
    showMoveDialogMessage(data.error || "新建目标文件夹失败", "error");
    return;
  }
  showMoveDialogMessage(`已创建目标文件夹：${name.trim()}`, "success");
  await loadMoveDialogDir(state.moveTargetDir);
}

async function downloadSelectedItems() {
  const paths = [...state.selectedPaths];
  if (paths.length === 0) return;

  const selectedItems = state.currentItems.filter((item) => state.selectedPaths.has(item.path));
  const hasDirectory = selectedItems.some((item) => item.type === "directory");
  const packingText = hasDirectory
    ? `正在准备 ${paths.length} 项下载（包含文件夹）...`
    : `正在准备 ${paths.length} 个文件下载...`;
  const startingText = "下载已开始，服务器正在打包传输...";

  showMessage(packingText, "info");
  setUploadProgress(15, "正在提交批量下载请求...");

  const res = await apiFetch("/api/download-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths })
  });

  setUploadProgress(65, "下载任务已创建，正在启动浏览器下载...");
  const data = await parseJsonResponse(res);
  if (!res.ok) {
    resetUploadProgress();
    showMessage(data.error || "批量下载失败", "error");
    return;
  }

  setUploadProgress(90, startingText, { indeterminate: true });
  const downloadLink = document.createElement("a");
  downloadLink.href = data.downloadUrl;
  downloadLink.style.display = "none";
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();

  setUploadProgress(100, "下载已开始，可在浏览器下载栏查看进度");
  const skippedCount = Array.isArray(data.skipped) ? data.skipped.length : 0;
  showMessage(skippedCount > 0
    ? `批量下载已开始，共 ${paths.length} 项，已跳过 ${skippedCount} 个不存在项目。`
    : `批量下载已开始，共 ${paths.length} 项。`, "success");
  window.setTimeout(resetUploadProgress, 1200);
}

function positionStatusMenu(menu) {
  var anchor = menu._statusAnchor;
  if (!anchor || !anchor.isConnected) return;
  var anchorRect = anchor.getBoundingClientRect();
  var menuRect = menu.getBoundingClientRect();
  var viewportGap = 8;
  var anchorGap = 4;
  var left = Math.max(viewportGap, Math.min(anchorRect.left, window.innerWidth - menuRect.width - viewportGap));
  var top = anchorRect.bottom + anchorGap;
  var topAbove = anchorRect.top - menuRect.height - anchorGap;
  if (top + menuRect.height > window.innerHeight - viewportGap && topAbove >= viewportGap) {
    top = topAbove;
  } else {
    top = Math.max(viewportGap, Math.min(top, window.innerHeight - menuRect.height - viewportGap));
  }
  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(top) + "px";
}

function setStatusMenuOpen(menu, isOpen) {
  var anchor = menu._statusAnchor;
  if (isOpen) {
    var owner = anchor ? anchor.closest(".op-cell, .grid-card") : null;
    menu._statusOwner = owner;
    if (owner) owner.classList.add("has-open-status-menu");
    if (!menu._statusHome) menu._statusHome = menu.parentElement;
    document.body.appendChild(menu);
    menu.classList.add("is-status-portal");
    menu.style.visibility = "hidden";
    menu.classList.remove("is-hidden");
    positionStatusMenu(menu);
    menu.style.visibility = "";
    return;
  }

  menu.classList.add("is-hidden");
  if (menu._statusOwner) menu._statusOwner.classList.remove("has-open-status-menu");
  menu._statusOwner = null;
  menu.classList.remove("is-status-portal");
  menu.style.removeProperty("left");
  menu.style.removeProperty("top");
  menu.style.removeProperty("visibility");
  if (menu._statusHome && menu._statusHome.isConnected) {
    menu._statusHome.appendChild(menu);
  } else if (menu.parentElement === document.body) {
    menu.remove();
  }
}

function closeStatusMenus(exceptMenu) {
  document.querySelectorAll(".status-badge-menu").forEach(function(menu) {
    if (menu !== exceptMenu) setStatusMenuOpen(menu, false);
  });
}

document.addEventListener("click", function() {
  closeStatusMenus();
});
window.addEventListener("resize", function() {
  closeStatusMenus();
});
document.addEventListener("scroll", function() {
  closeStatusMenus();
}, true);

function createActions(item) {
  const actions = document.createElement("div");
  actions.className = "grid-actions";
  actions.addEventListener("click", (event) => event.stopPropagation());
  actions.addEventListener("dblclick", (event) => event.stopPropagation());

  if (item.type === "directory") {
    const openBtn = document.createElement("button");
    openBtn.className = "link-button";
    openBtn.textContent = "打开";
    openBtn.onclick = () => loadDir(item.path);
    actions.appendChild(openBtn);
  } else {
    if (item.previewType !== "none") {
      const previewBtn = document.createElement("button");
      previewBtn.className = "link-button";
      previewBtn.textContent = "预览";
      previewBtn.onclick = () => openPreview(item);
      actions.appendChild(previewBtn);
    }
    if (can("files.download")) {
      const downloadLink = document.createElement("a");
      downloadLink.className = "link-button";
      downloadLink.textContent = "下载";
      downloadLink.href = `/download?path=${encodeURIComponent(item.path)}${state.nsfwMode ? "&nsfw=1" : ""}`;
      actions.appendChild(downloadLink);
    }
  }

  if (can("files.write")) {
    const renameBtn = document.createElement("button");
    renameBtn.className = "link-button";
    renameBtn.textContent = "重命名";
    renameBtn.onclick = () => renameItem(item);
    actions.appendChild(renameBtn);

    const moveBtn = document.createElement("button");
    moveBtn.className = "link-button";
    moveBtn.textContent = "移动";
    moveBtn.onclick = () => moveItem(item);
    actions.appendChild(moveBtn);
  }

  // 目录状态自定义下拉框
  if (can("files.write") && item.type === "directory" && (!state.currentDir || state.currentDir === "")) {
    var statusOpts = [
      { value: "not_started", label: "待开始" },
      { value: "in_progress", label: "进行中" },
      { value: "completed", label: "已完成" }
    ];
    var statusBtn = document.createElement("button");
    statusBtn.type = "button";
    statusBtn.className = "link-button status-badge";
    statusBtn.textContent = statusLabels[item.status] || "待开始";
    setStatusBadgeColor(statusBtn, item.status);

    var statusMenu = document.createElement("div");
    statusMenu.className = "status-badge-menu is-hidden";
    statusOpts.forEach(function(opt) {
      var optBtn = document.createElement("button");
      optBtn.type = "button";
      optBtn.className = "status-badge-opt";
      optBtn.textContent = opt.label;
      optBtn.dataset.value = opt.value;
      if (opt.value === item.status) optBtn.classList.add("active");
      optBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        setItemStatus(item, this.dataset.value);
        statusBtn.textContent = this.textContent;
        setStatusBadgeColor(statusBtn, this.dataset.value);
        statusMenu.querySelectorAll(".status-badge-opt").forEach(function(o) { o.classList.remove("active"); });
        this.classList.add("active");
        setStatusMenuOpen(statusMenu, false);
      });
      statusMenu.appendChild(optBtn);
    });

    statusBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      closeStatusMenus(statusMenu);
      setStatusMenuOpen(statusMenu, statusMenu.classList.contains("is-hidden"));
    });

    var wrap = document.createElement("span");
    wrap.style.position = "relative";
    wrap.style.display = "inline-flex";
    wrap.appendChild(statusBtn);
    wrap.appendChild(statusMenu);
    statusMenu._statusAnchor = statusBtn;
    statusMenu._statusHome = wrap;
    actions.appendChild(wrap);
  }

  if (can("files.write")) {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "link-button danger-button";
    deleteBtn.textContent = "删除";
    deleteBtn.onclick = () => deleteItem(item);
    actions.appendChild(deleteBtn);
  }
  return actions;
}

function parentDir(p) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "shared";
}

function createGridCard(item) {
  const searchDir = state.searchQuery ? parentDir(item.path) : "";
  const card = document.createElement("article");
  card.className = "grid-card";
  card.dataset.itemPath = item.path;
  card.classList.toggle("is-selected", isSelected(item.path));
  if (state.clipboard.mode === "cut" && state.clipboard.items.includes(item.path)) card.classList.add("cut-clip");
  else if (state.clipboard.mode === "copy" && state.clipboard.items.includes(item.path)) card.classList.add("copy-clip");
  if (item.status === "completed") card.classList.add("is-completed");
  else if (item.status === "in_progress") card.classList.add("is-in-progress");
  card.addEventListener("click", (event) => handleItemClick(event, item));
  card.addEventListener("dblclick", (event) => handleItemDoubleClick(event, item));

  // 拖拽支持 - 所有项目都可拖拽
  card.draggable = can("files.write");
  card.addEventListener("dragstart", (e) => {
    const paths = state.selectedPaths.size > 0 && state.selectedPaths.has(item.path)
      ? [...state.selectedPaths]
      : [item.path];
    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.setData("application/json", JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "move";
  });

  // 文件夹：拖拽悬浮时跳转
  if (item.type === "directory") {
    let navigateTimer = null;
    card.addEventListener("dragover", (e) => {
      if (!isInternalMoveDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      card.classList.add("drag-over");
      // 悬浮 800ms 后跳转到该目录
      if (!navigateTimer) {
        navigateTimer = setTimeout(() => {
          loadDir(item.path);
          navigateTimer = null;
        }, 800);
      }
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("drag-over");
      if (navigateTimer) { clearTimeout(navigateTimer); navigateTimer = null; }
    });
    card.addEventListener("drop", async (e) => {
      if (!isInternalMoveDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("drag-over");
      if (navigateTimer) { clearTimeout(navigateTimer); navigateTimer = null; }
      const paths = getInternalDragPaths(e.dataTransfer);
      if (paths.length && item.type === "directory") {
        const ok = await moveItems(paths, item.path);
        if (ok) { showMessage(`已移动 ${paths.length} 个项目`, "success"); loadDir(state.currentDir); }
      }
    });
  }

  const header = document.createElement("div");
  header.className = "grid-card-header";
  header.appendChild(makeSelectCheckbox(item));
  card.appendChild(header);

  const thumb = buildThumbnail(item, searchDir);
  thumb.classList.add("grid-name-wrap");
  card.appendChild(thumb);

  const meta = document.createElement("div");
  meta.className = "grid-meta";
  meta.innerHTML = `
    <div class="grid-type">${getFileType(item)}</div>
    <div class="grid-size">${formatItemSize(item)}</div>
    <div class="grid-born">${item.bornAt ? new Date(item.bornAt).toLocaleString("zh-CN") : ""}</div>
    <div class="grid-time">${new Date(item.updatedAt).toLocaleString("zh-CN")}</div>
  `;
  card.appendChild(meta);
  card.appendChild(createActions(item));
  return card;
}

function renderGrid(items) {
  gridView.innerHTML = "";
  for (const item of items) {
    var card = createGridCard(item);
    card.__itemData = item;
    gridView.appendChild(card);
  }
  if (!items.length && state.searchQuery) {
    const empty = document.createElement("div");
    empty.className = "grid-empty";
    empty.textContent = "没有匹配的项目。";
    gridView.appendChild(empty);
  } else if (!items.length && !state.currentDir) {
    const empty = document.createElement("div");
    empty.className = "grid-empty";
    empty.textContent = (state.nsfwMode ? "shared_NSFW" : "共享") + "目录为空，先上传文件、上传文件夹，或新建文件夹。";
    gridView.appendChild(empty);
  } else if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "grid-empty";
    empty.textContent = "当前目录为空。";
    gridView.appendChild(empty);
  }
}

function renderRows(items) {
  tableBody.innerHTML = "";
  if (state.viewMode === "grid") { renderGrid(items); return; }


  for (const item of items) {
    const searchDir = state.searchQuery ? parentDir(item.path) : "";
    const tr = rowTemplate.content.firstElementChild.cloneNode(true);
    tr.className = "interactive-row";
    tr.dataset.itemPath = item.path;
    tr.classList.toggle("is-selected", isSelected(item.path));
    if (state.clipboard.mode === "cut" && state.clipboard.items.includes(item.path)) tr.classList.add("cut-clip");
    else if (state.clipboard.mode === "copy" && state.clipboard.items.includes(item.path)) tr.classList.add("copy-clip");
    const wrap = document.createElement("div");
    wrap.className = "row-name-wrap";
    wrap.appendChild(makeSelectCheckbox(item));
    wrap.appendChild(buildThumbnail(item, searchDir));
    tr.querySelector(".name-cell").appendChild(wrap);
    tr.querySelector(".type-cell").textContent = getFileType(item);
    tr.querySelector(".size-cell").textContent = formatItemSize(item);
    tr.querySelector(".born-cell").textContent = item.bornAt ? new Date(item.bornAt).toLocaleString("zh-CN") : "";
    tr.querySelector(".time-cell").textContent = new Date(item.updatedAt).toLocaleString("zh-CN");
    tr.__itemData = item;
    if (item.status === "completed") tr.classList.add("is-completed");
    else if (item.status === "in_progress") tr.classList.add("is-in-progress");
    tr.addEventListener("click", (event) => handleItemClick(event, item));
    tr.addEventListener("dblclick", (event) => handleItemDoubleClick(event, item));
    tr.querySelector(".op-cell").appendChild(createActions(item));

    // 拖拽支持 - 所有项目都可拖拽
    tr.draggable = can("files.write");
    tr.addEventListener("dragstart", (e) => {
      const paths = state.selectedPaths.size > 0 && state.selectedPaths.has(item.path)
        ? [...state.selectedPaths]
        : [item.path];
      e.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(paths));
      e.dataTransfer.setData("application/json", JSON.stringify(paths));
      e.dataTransfer.effectAllowed = "move";
    });

    // 文件夹：拖拽悬浮时跳转
    if (item.type === "directory") {
      let navigateTimer = null;
      tr.addEventListener("dragover", (e) => {
        if (!isInternalMoveDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        tr.classList.add("drag-over");
        if (!navigateTimer) {
          navigateTimer = setTimeout(() => {
            loadDir(item.path);
            navigateTimer = null;
          }, 800);
        }
      });
      tr.addEventListener("dragleave", () => {
        tr.classList.remove("drag-over");
        if (navigateTimer) { clearTimeout(navigateTimer); navigateTimer = null; }
      });
      tr.addEventListener("drop", async (e) => {
        if (!isInternalMoveDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        tr.classList.remove("drag-over");
        if (navigateTimer) { clearTimeout(navigateTimer); navigateTimer = null; }
        const paths = getInternalDragPaths(e.dataTransfer);
        if (paths.length && item.type === "directory") {
          const ok = await moveItems(paths, item.path);
          if (ok) { showMessage(`已移动 ${paths.length} 个项目`, "success"); loadDir(state.currentDir); }
        }
      });
    }

    tableBody.appendChild(tr);
  }

  if (!items.length && !state.currentDir) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="6" class="empty">' + (state.nsfwMode ? "shared_NSFW" : "共享") + '目录为空，先上传文件、上传文件夹，或新建文件夹。</td>';
    tableBody.appendChild(tr);
  } else if (!items.length && state.searchQuery) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="6" class="empty">没有匹配的项目。</td>';
    tableBody.appendChild(tr);
  } else if (!items.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="6" class="empty">当前目录为空。</td>';
    tableBody.appendChild(tr);
  }
}

let _loadDirController = null;
let _folderSizePollTimer = null;
var _scrollPositions = {}

function clearFolderSizePolling() {
  if (_folderSizePollTimer) {
    clearTimeout(_folderSizePollTimer);
    _folderSizePollTimer = null;
  }
}

function getPendingFolderSizePaths() {
  return state.currentItems
    .filter((item) => item.type === "directory" && (item.folderSizeStatus === "pending" || item.folderSizeStatus === "stale"))
    .map((item) => item.path)
    .slice(0, 200);
}

function mergeFolderSizeResults(items) {
  const updates = new Map((items || []).map((item) => [item.path, item]));
  let changed = false;
  for (const item of state.currentItems) {
    const next = updates.get(item.path);
    if (!next) continue;
    const nextSize = next.folderSize == null ? null : Number(next.folderSize);
    if (item.folderSize !== nextSize) {
      item.folderSize = nextSize;
      changed = true;
    }
    if (item.folderSizeStatus !== next.folderSizeStatus) {
      item.folderSizeStatus = next.folderSizeStatus;
      changed = true;
    }
    if (item.folderSizeCachedAt !== next.folderSizeCachedAt) {
      item.folderSizeCachedAt = next.folderSizeCachedAt;
      changed = true;
    }
  }
  return changed;
}

function scheduleFolderSizePolling(delay = 800) {
  clearFolderSizePolling();
  if (state.searchQuery || getPendingFolderSizePaths().length === 0) return;
  _folderSizePollTimer = setTimeout(pollFolderSizes, delay);
}

async function pollFolderSizes() {
  _folderSizePollTimer = null;
  const paths = getPendingFolderSizePaths();
  if (state.searchQuery || paths.length === 0) return;

  const requestDir = state.currentDir;
  const params = new URLSearchParams();
  for (const itemPath of paths) params.append("path", itemPath);

  try {
    var fsUrl = "/api/folder-sizes?" + params.toString() + (state.nsfwMode ? "&nsfw=1" : "")
    const res = await fetch(fsUrl, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || requestDir !== state.currentDir) return;
    if (mergeFolderSizeResults(data.items)) {
      renderCurrentDirectory();
    }
  } catch {
    // 下一次目录刷新会重新触发计算状态查询。
  }

  if (requestDir === state.currentDir && getPendingFolderSizePaths().length > 0) {
    scheduleFolderSizePolling(1500);
  }
}

async function loadDir(dir) {
  if (_loadDirController) _loadDirController.abort();
  clearFolderSizePolling();
  // 保存当前目录的滚动位置
  if (state.currentDir != null) {
    var curScroll = document.querySelector(state.viewMode === "grid" ? "#gridView" : ".table-wrap")
    if (curScroll) _scrollPositions[state.currentDir] = curScroll.scrollTop
  }
  _loadDirController = new AbortController();
  const signal = _loadDirController.signal;
  clearMessage();
  clearSelections();
  state.fileOffset = 0;
  state.fileTotal = 0;
  state.loadingMore = false;
  let res, data;
  try {
    var listUrl = `/api/list?dir=${encodeURIComponent(dir)}&offset=0&limit=50`
    if (state.nsfwMode) listUrl += "&nsfw=1"
    res = await fetch(listUrl, { signal });
    data = await res.json();
  } catch (e) {
    if (e.name === "AbortError") return;
    showMessage("读取目录失败", "error");
    return;
  }
  if (!res.ok) {
    if (res.status === 401 && state.nsfwMode) {
      setNsfwModeUi(false);
      showMessage("海外剧会话已失效，请重新输入密码", "error");
      loadDir("");
      return;
    }
    showMessage(data.error || "读取目录失败", "error");
    return;
  }
  state.currentDir = data.currentDir;
  state.currentItems = data.items || [];
  state.fileTotal = data.total || state.currentItems.length;
  localStorage.setItem(CURRENT_DIR_KEY, data.currentDir);
  if (state.searchQuery) {
    state.searchQuery = "";
    state.searchResults = [];
    mainSearchInput.value = "";
  }
  renderCurrentDirectory();
  scheduleFolderSizePolling();
  // 恢复目标目录的滚动位置
  if (dir in _scrollPositions) {
    var restore = document.querySelector(state.viewMode === "grid" ? "#gridView" : ".table-wrap")
    if (restore) window.setTimeout(function() { restore.scrollTop = _scrollPositions[dir] }, 0)
  }
}

async function loadMore() {
  if (state.loadingMore || state.fileOffset + 50 >= state.fileTotal) return;
  state.loadingMore = true;
  state.fileOffset += 50;
  const el = document.querySelector(state.viewMode === "grid" ? "#gridView" : "#tableView");
  if (el) { const p = el.parentElement; if (p) p.style.paddingBottom = "40px"; }
  try {
    var loadMoreUrl = "/api/list?dir=" + encodeURIComponent(state.currentDir) + "&offset=" + state.fileOffset + "&limit=50"
    if (state.nsfwMode) loadMoreUrl += "&nsfw=1"
    const res = await fetch(loadMoreUrl);
    const data = await res.json();
    if (res.status === 401 && state.nsfwMode) {
      setNsfwModeUi(false);
      loadDir("");
    } else if (res.ok && data.items) {
      state.currentItems.push(...data.items);
      renderCurrentDirectory();
      state.fileTotal = data.total || state.currentItems.length;
      scheduleFolderSizePolling();
    }
  } catch {}
  state.loadingMore = false;
  if (el) { const p = el.parentElement; if (p) p.style.paddingBottom = ""; }
}

function setupScrollPagination() {
  const containers = [document.querySelector("#tableView"), document.querySelector("#gridView")];
  for (const c of containers) {
    if (!c) continue;
    c.addEventListener("scroll", () => {
      if (c.scrollTop + c.clientHeight >= c.scrollHeight - 200) loadMore();
    });
  }
}

function updateRecycleToolbar() {
  const count = state.recycleSelectedIds.size;
  recycleSelectedCount.textContent = `已选 ${count} 项`;
  recycleRestoreSelectedBtn.disabled = count === 0;
  recycleDeleteSelectedBtn.disabled = count === 0;
}

function toggleRecycleSelected(id, checked) {
  if (checked) state.recycleSelectedIds.add(id);
  else state.recycleSelectedIds.delete(id);
  updateRecycleToolbar();
}

function getRecycleSelectionItems(ids = [...state.recycleSelectedIds]) {
  const idSet = new Set(ids);
  return state.recycleItems.filter((item) => idSet.has(item.id));
}

function getFilteredRecycleItems() {
  const keyword = state.recycleFilter.trim().toLowerCase();
  return state.recycleItems.filter((item) => {
    if (!keyword) return true;
    return item.name.toLowerCase().includes(keyword) || item.originalPath.toLowerCase().includes(keyword);
  });
}

function selectAllFilteredRecycleItems() {
  for (const item of getFilteredRecycleItems()) {
    state.recycleSelectedIds.add(item.id);
  }
  renderRecycleItems();
}

function invertFilteredRecycleSelection() {
  for (const item of getFilteredRecycleItems()) {
    if (state.recycleSelectedIds.has(item.id)) {
      state.recycleSelectedIds.delete(item.id);
    } else {
      state.recycleSelectedIds.add(item.id);
    }
  }
  renderRecycleItems();
}

async function restoreRecycleIds(ids) {
  let restored = 0;
  for (const id of ids) {
    const response = await apiFetch("/api/recycle/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      showRecycleMessage(payload.error || "恢复失败", "error");
      break;
    }
    restored += 1;
  }
  if (restored > 0) {
    showRecycleMessage(`已恢复 ${restored} 项`, "success");
    await loadRecycleItems();
    await loadDir(state.currentDir);
  }
}

async function deleteRecycleIds(ids) {
  let deleted = 0;
  for (const id of ids) {
    const response = await apiFetch("/api/recycle/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      showRecycleMessage(payload.error || "彻底删除失败", "error");
      break;
    }
    deleted += 1;
  }
  if (deleted > 0) {
    showRecycleMessage(`已彻底删除 ${deleted} 项`, "success");
    await loadRecycleItems();
  }
}

function renderRecycleItems() {
  updateRecycleToolbar();
  recycleList.innerHTML = "";
  const items = getFilteredRecycleItems();

  if (items.length === 0) {
    recycleList.innerHTML = `<div class="recycle-empty">${state.recycleItems.length === 0 ? "回收站为空。" : "没有匹配的回收站项目。"}</div>`;
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "recycle-item";

    const main = document.createElement("div");
    main.className = "recycle-item-main";

    const head = document.createElement("div");
    head.className = "recycle-item-head";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "select-checkbox";
    checkbox.checked = state.recycleSelectedIds.has(item.id);
    checkbox.addEventListener("change", (event) => toggleRecycleSelected(item.id, event.target.checked));
    const name = document.createElement("div");
    name.className = "recycle-item-name";
    name.textContent = item.name;
    head.appendChild(checkbox);
    head.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "recycle-item-meta";
    meta.textContent = `${item.originalPath} · ${new Date(item.deletedAt).toLocaleString("zh-CN")} · ${item.itemType === "directory" ? "文件夹" : formatSize(item.size)}`;

    main.appendChild(head);
    main.appendChild(meta);
    row.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "recycle-actions";

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "link-button";
    restoreBtn.textContent = "恢复";
    restoreBtn.onclick = () => restoreRecycleIds([item.id]);
    actions.appendChild(restoreBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "link-button danger-button";
    deleteBtn.textContent = "彻底删除";
    deleteBtn.onclick = async () => {
      const confirmed = await openConfirmDialog({
        title: "彻底删除",
        message: "此操作不可恢复。",
        items: [item.originalPath],
        confirmText: "彻底删除",
        danger: true
      });
      if (confirmed) await deleteRecycleIds([item.id]);
    };
    actions.appendChild(deleteBtn);
    row.appendChild(actions);
    recycleList.appendChild(row);
  }
}

async function loadRecycleItems() {
  const res = await fetch("/api/recycle/list");
  const data = await res.json();
  if (!res.ok) {
    showRecycleMessage(data.error || "读取回收站失败", "error");
    return;
  }
  state.recycleItems = data.items;
  const validIds = new Set(data.items.map((item) => item.id));
  state.recycleSelectedIds = new Set([...state.recycleSelectedIds].filter((id) => validIds.has(id)));
  recycleCountBadge.textContent = String(data.items.length);
  renderRecycleItems();
}

async function restoreSelectedRecycleItems() {
  const ids = [...state.recycleSelectedIds];
  if (ids.length === 0) return;
  await restoreRecycleIds(ids);
  state.recycleSelectedIds.clear();
  updateRecycleToolbar();
}

async function deleteSelectedRecycleItems() {
  const ids = [...state.recycleSelectedIds];
  if (ids.length === 0) return;
  const items = getRecycleSelectionItems(ids).map((item) => item.originalPath);
  const confirmed = await openConfirmDialog({
    title: `彻底删除 ${ids.length} 项`,
    message: "这些项目会从回收站永久删除，无法恢复。",
    items,
    confirmText: "批量彻底删除",
    danger: true
  });
  if (!confirmed) return;
  await deleteRecycleIds(ids);
  state.recycleSelectedIds.clear();
  updateRecycleToolbar();
}

async function entriesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const webkitEntries = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (webkitEntries.length === 0) {
    return [...dataTransfer.files].map((file) => ({ file, relativePath: file.name }));
  }

  const results = [];
  function walk(entry, basePath = "") {
    return new Promise((resolve, reject) => {
      if (entry.isFile) {
        entry.file((file) => {
          results.push({ file, relativePath: basePath ? `${basePath}/${file.name}` : file.name });
          resolve();
        }, reject);
        return;
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
        const readAll = () => {
          reader.readEntries(async (entries) => {
            if (!entries.length) {
              resolve();
              return;
            }
            try {
              for (const child of entries) await walk(child, dirPath);
              readAll();
            } catch (error) {
              reject(error);
            }
          }, reject);
        };
        readAll();
        return;
      }
      resolve();
    });
  }

  for (const entry of webkitEntries) {
    await walk(entry, "");
  }
  return results;
}

async function uploadEntries(fileEntries, label = "文件") {
  if (!fileEntries.length) return;
  let overwriteExisting = false;
  try {
    const conflicts = await checkConflicts({
      operation: "upload",
      dir: state.currentDir,
      entries: fileEntries.map((entry) => entry.relativePath)
    });
    if (conflicts.length > 0) {
      const confirmed = await confirmOverwriteConflicts({
        title: "发现同名项目",
        message: "目标位置已经有同名文件或文件夹。确认后会覆盖，旧项目会移入回收站；取消则不会开始上传。",
        conflicts,
        confirmText: "覆盖上传"
      });
      if (!confirmed) {
        showMessage("已取消上传", "info");
        return;
      }
      overwriteExisting = true;
    }
  } catch (error) {
    showMessage(error.message || "上传前检查失败", "error");
    return;
  }

  const task = createUploadTask(label, fileEntries.length);
  showMessage(`正在上传${label}，请稍候...`, "info");
  updateUploadTask(task, { status: "pending", message: "正在初始化安全校验" });
  try {
    await ensureSecurity();
  } catch (error) {
    updateUploadTask(task, { status: "failed", message: error.message || "安全校验失败" });
    showMessage(error.message || "安全校验失败", "error");
    return;
  }
  if (task.cancelled) return;

  const formData = new FormData();
  formData.append("dir", state.currentDir);
  formData.append("overwrite", overwriteExisting ? "1" : "0");
  fileEntries.forEach(({ file, relativePath }, i) => {
    formData.append(`relativePath_${i}`, relativePath);
    formData.append("files", file, file.name);
  });

  setUploadProgress(0, `正在上传${label}...`);
  updateUploadTask(task, { status: "uploading", message: "正在上传", progress: 0 });

  let result;
  try {
    result = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    task.xhr = xhr;
    xhr.open("POST", "/api/upload" + (state.nsfwMode ? "?nsfw=1" : ""));
    xhr.setRequestHeader("X-CSRF-Token", state.csrfToken);
    if (state.nickname) xhr.setRequestHeader("X-Device-Name", encodeURIComponent(state.nickname));

    const speedSamples = [];

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 100;
      speedSamples.push({ loaded: event.loaded, time: performance.now() });
      if (speedSamples.length > 20) speedSamples.splice(0, speedSamples.length - 20);
      const speed = calculateUploadSpeed(speedSamples);
      const speedText = speed != null ? formatSpeed(speed) : "";
      setUploadProgress(percent, `正在上传${label}...`, { speed: speedText });
      updateUploadTask(task, { progress: percent, message: `正在上传 ${Math.round(percent)}%` });
    };

    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, data });
      } catch {
        reject(new Error("服务器返回格式错误"));
      }
    };

    xhr.onerror = () => reject(new Error("网络错误，上传失败"));
    xhr.onabort = () => reject(new Error("上传已取消"));
    xhr.send(formData);
    });
  } catch (error) {
    resetUploadProgress();
    updateUploadTask(task, { status: task.cancelled ? "cancelled" : "failed", message: error.message || "上传失败" });
    showMessage(error.message || "上传失败", task.cancelled ? "info" : "error");
    return;
  } finally {
    task.xhr = null;
  }

  if (!result.ok) {
    resetUploadProgress();
    updateUploadTask(task, { status: "failed", message: result.data.error || "上传失败" });
    showMessage(result.data.error || "上传失败", "error");
    return;
  }

  setUploadProgress(100, "上传完成");
  updateUploadTask(task, { status: "done", message: "上传完成", progress: 100 });
  showMessage(`上传完成，共 ${result.data.uploaded} 个文件。`, "success");
  await loadDir(state.currentDir);
  await Promise.all([loadWorkspaceStatus(), loadInProgressProjects()]);
  pollLogs();
  window.setTimeout(resetUploadProgress, 800);
  window.setTimeout(() => removeUploadTask(task.id), 4000);
}

async function uploadFiles(files, options = {}) {
  if (!files.length) return;
  const { keepRelativePath = false, label = "文件" } = options;
  const fileEntries = [...files].map((file) => ({
    file,
    relativePath: keepRelativePath ? (file.webkitRelativePath || file.name) : file.name
  }));
  await uploadEntries(fileEntries, label);
}

async function createFolder() {
  const name = await openInputDialog({
    title: "新建文件夹",
    label: `创建位置：shared${state.currentDir ? `/${state.currentDir}` : ""}`,
    value: "",
    confirmText: "创建",
    validate: function(value) {
      var e = validatePlainName(value, "文件夹名称不能为空")
      if (e) return e
      if (value.trim().startsWith(".")) return "名称不能以 . 开头"
      return ""
    }
  });
  if (name == null) return;
  const res = await apiFetch("/api/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: state.currentDir, name: name.trim() })
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) {
    showMessage(data.error || "新建文件夹失败", "error");
    return;
  }
  showMessage(`已创建文件夹：${name.trim()}`, "success");
  await loadDir(state.currentDir);
}

async function createProject() {
  const dialog = document.createElement("dialog");
  dialog.className = "preview-dialog form-dialog";
  dialog.innerHTML = `
    <div class="preview-header">
      <div>
        <div class="label">创建位置：shared${state.currentDir ? `/${state.currentDir}` : ""}</div>
        <div class="preview-title">新建项目</div>
      </div>
      <button class="button ghost" data-action="cancel" type="button">关闭</button>
    </div>
    <form class="form-dialog-body" method="dialog">
      <div class="input-row">
        <label style="min-width:6em;text-align:right">项目名称</label>
        <input class="field" name="projectName" autocomplete="off" placeholder="请输入项目名称" />
      </div>
      <div class="input-row" style="margin-top:.5em">
        <label style="min-width:6em;text-align:right">集数</label>
        <input class="field" name="episodes" type="number" min="1" value="1" autocomplete="off" style="width:6em" />
      </div>
      <div class="message"></div>
      <div class="dialog-actions">
        <button class="button ghost" data-action="cancel" type="button">取消</button>
        <button class="button primary" type="submit">创建</button>
      </div>
    </form>
  `;
  document.body.appendChild(dialog);

  const form = dialog.querySelector("form");
  const nameInput = dialog.querySelector("input[name='projectName']");
  const epsInput = dialog.querySelector("input[name='episodes']");
  const message = dialog.querySelector(".message");
  let resolved = false;
  let resolve;

  const finish = (result) => {
    if (resolved) return;
    resolved = true;
    closeDialog(dialog);
    dialog.remove();
    resolve(result);
  };

  dialog.addEventListener("mousedown", (e) => { dialog._downTarget = e.target; });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && dialog._downTarget === dialog || event.target.dataset.action === "cancel") finish(null);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(null);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const episodes = parseInt(epsInput.value, 10) || 1;
    if (!name) {
      message.textContent = "项目名称不能为空";
      message.className = "message error";
      return;
    }
    if (/[<>:"/\\|?*]/.test(name)) {
      message.textContent = "项目名称不能包含这些字符：<>:\"/\\|?*";
      message.className = "message error";
      return;
    }
    finish({ name, episodes: Math.max(1, episodes) });
  });

  nameInput.focus();
  showDialog(dialog);
  const result = await new Promise((r) => { resolve = r; });

  if (result == null) return;
  const res = await apiFetch("/api/create-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: result.name, episodes: result.episodes, parentDir: state.currentDir })
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) {
    showMessage(data.error || "创建项目失败", "error");
    return;
  }
  showMessage(`已创建项目：《${result.name}》`, "success");
  await loadDir(state.currentDir);
}

function setDropActive(active) {
  // 工具标签页下不显示拖拽覆盖层，由工具自身处理
  if (active) {
    var t = document.querySelector(".tab.active");
    if (t && (t.dataset.tab === "audio" || t.dataset.tab === "video")) return;
  }
  document.body.classList.toggle("drag-active", active);
}

fileInput.addEventListener("change", async (event) => {
  uploadMenu.classList.remove("open");
  try {
    await uploadFiles(event.target.files, { keepRelativePath: false, label: "文件" });
  } finally {
    fileInput.value = "";
  }
});

folderInput.addEventListener("change", async (event) => {
  uploadMenu.classList.remove("open");
  try {
    await uploadFiles(event.target.files, { keepRelativePath: true, label: "文件夹" });
  } finally {
    folderInput.value = "";
  }
});

uploadBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  uploadMenu.classList.toggle("open");
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".upload-group")) uploadMenu.classList.remove("open");
});

document.addEventListener("dragover", (event) => {
  if (_draggingChar) return;
  // 工具 iframe 区域仍需 preventDefault 以允许拖放，
  // 但不显示覆盖层
  if (event.target.closest && event.target.closest("#tab-audio, #tab-video")) {
    event.preventDefault();
    setDropActive(false);
    return;
  }
  // 内部拖拽（文件/文件夹/面包屑）显示取消区域
  if (isInternalMoveDrag(event)) {
    event.preventDefault();
    updateDragAutoScroll(event);
    showDragCancelZone();
    return;
  }
  if (!isExternalFileDrag(event)) return;
  event.preventDefault();
  setDropActive(true);
});

document.addEventListener("dragleave", (event) => {
  if (_draggingChar) return;
  if (event.target.closest && event.target.closest("#tab-audio, #tab-video")) return;
  if (event.clientX === 0 && event.clientY === 0) {
    setDropActive(false);
    stopDragAutoScroll();
    hideDragCancelZone();
  }
});

document.addEventListener("drop", async (event) => {
  if (_draggingChar) return;
  finishInternalMoveDragUi();
  // 工具 iframe 区域由工具自身处理
  if (event.target.closest && event.target.closest("#tab-audio, #tab-video")) {
    setDropActive(false);
    return;
  }
  if (isInternalMoveDrag(event)) {
    event.preventDefault();
    return;
  }
  if (!isExternalFileDrag(event)) {
    return;
  }
  event.preventDefault();
  if (!can("files.write")) {
    showMessage("游客不能上传文件", "error");
    setDropActive(false);
    return;
  }
  try {
    const entries = await entriesFromDataTransfer(event.dataTransfer);
    await uploadEntries(entries, "拖拽内容");
  } catch (error) {
    showMessage(error.message || "拖拽上传失败", "error");
  }
});

document.addEventListener("dragend", () => {
  finishInternalMoveDragUi();
});

// 取消区域拖拽支持
var dragCancelZone = document.querySelector("#dragCancelZone");
if (dragCancelZone) {
  dragCancelZone.addEventListener("dragover", (e) => {
    if (!isInternalMoveDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    stopDragAutoScroll();
    positionDragCancelZone();
    e.dataTransfer.dropEffect = "none";
    dragCancelZone.classList.add("drag-over");
  });
  dragCancelZone.addEventListener("dragleave", () => dragCancelZone.classList.remove("drag-over"));
  dragCancelZone.addEventListener("drop", (e) => {
    if (!isInternalMoveDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    finishInternalMoveDragUi();
    showMessage("已取消拖拽操作", "info");
  });
}

// --- Account name and display effects ---

const GLOW_COLORS = [
  { label: "无", color: "" },
  { label: "墨灰", color: "#57503f" },
  { label: "松石", color: "#0f766e" },
  { label: "琥珀", color: "#a87b24" },
  { label: "藏蓝", color: "#2f6db3" },
  { label: "苔绿", color: "#3e7c4f" },
  { label: "赭红", color: "#b23b3b" },
  { label: "岩灰", color: "#6b7280" },
  { label: "天蓝", color: "#0a84ff" },
  { label: "翠绿", color: "#34c759" },
  { label: "自定义", color: "custom" }
];

const CURSOR_EFFECTS = [
  { key: "classic", label: "墨印" },
  { key: "ribbon", label: "墨痕" },
  { key: "spark", label: "墨澜" },
  { key: "comet", label: "墨篆" },
  { key: "stain", label: "墨染" }
];

function changeNickname() {
  const selColor = state.glowColor;
  const selEffect = state.cursorEffect || "comet";
  const d = document.createElement("dialog");
  d.className = "preview-dialog form-dialog";
  d.style.maxWidth = "560px";
  d.innerHTML = `
    <div class="preview-header">
      <div>
        <div class="label">姓名与显示效果</div>
        <div class="preview-title">调整工作区显示</div>
      </div>
      <button class="button ghost" data-action="cancel" type="button">关闭</button>
    </div>
    <form class="form-dialog-body" method="dialog">
      <div class="input-row">
        <input class="field" name="value" autocomplete="off" placeholder="例如：张三" value="${escapeHtml(state.nickname)}" style="color:var(--text);background:var(--panel-strong)" />
      </div>
      <div style="font-size:13px;color:var(--muted);margin-top:4px">墨砚</div>
      <div id="colorPicker" style="display:flex;gap:4px;flex-wrap:wrap;padding:4px 0">
        ${GLOW_COLORS.map((c, i) => {
          if (c.color === "custom") {
            return `<label style="width:32px;height:32px;border:1px solid var(--line);border-radius:2px;cursor:pointer;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center">
              <input type="color" id="customColor" value="${selColor || "#57503f"}" style="position:absolute;inset:-10px;cursor:pointer;opacity:0" />
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text)" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            </label>`;
          }
          const isActive = (!c.color && !selColor) || (c.color && c.color === selColor);
          return `<div data-idx="${i}" class="color-swatch ${isActive ? "active" : ""}" style="width:32px;height:32px;border:1px solid ${isActive ? "var(--text)" : "var(--line)"};border-radius:2px;cursor:pointer;background:${c.color || "transparent"};display:flex;align-items:center;justify-content:center;font-size:14px;transition:border-color 120ms ease">${c.color ? "" : "✕"}</div>`;
        }).join("")}
      </div>
      <div style="font-size:13px;color:var(--muted);margin-top:8px">鼠标特效</div>
      <div id="effectPicker" style="display:flex;gap:8px;flex-wrap:wrap;padding:4px 0 2px">
        ${CURSOR_EFFECTS.map((effect) => `
          <button
            type="button"
            data-effect="${effect.key}"
            class="button ghost${effect.key === selEffect ? " is-active" : ""}"
            style="padding:8px 14px"
          >${effect.label}</button>
        `).join("")}
      </div>
      <div class="message-area" style="margin:0"></div>
      <div class="dialog-actions">
        <button class="button ghost" data-action="cancel" type="button">取消</button>
        <button class="button primary" type="submit">确定</button>
      </div>
    </form>`;
  document.body.appendChild(d);
  const form = d.querySelector("form");
  const input = d.querySelector("input");
  const msg = d.querySelector(".message-area");
  const colorPicker = d.querySelector("#colorPicker");
  const effectPicker = d.querySelector("#effectPicker");
  let selectedColor = selColor;
  let selectedEffect = selEffect;
  let resolved = false;

  colorPicker.addEventListener("click", (e) => {
    const swatch = e.target.closest("[data-idx]");
    if (!swatch) return;
    const idx = parseInt(swatch.dataset.idx);
    const c = GLOW_COLORS[idx];
    if (c.color === "custom") return;
    selectedColor = c.color;
    colorPicker.querySelectorAll("[data-idx]").forEach(el => el.classList.remove("active"));
    swatch.classList.add("active");
  });

  const customInput = d.querySelector("#customColor");
  if (customInput) {
    customInput.addEventListener("input", () => {
      selectedColor = customInput.value;
      colorPicker.querySelectorAll("[data-idx]").forEach(el => el.classList.remove("active"));
    });
  }

  effectPicker.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-effect]");
    if (!btn) return;
    selectedEffect = btn.dataset.effect;
    effectPicker.querySelectorAll("[data-effect]").forEach((el) => el.classList.remove("is-active"));
    btn.classList.add("is-active");
  });

  const finish = (v) => {
    if (resolved) return;
    resolved = true;
    closeDialog(d);
    d.remove();
    if (v) finishChange(v, selectedColor, state.floatSpeed, selectedEffect);
  };
  input.focus();
  input.select();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) { msg.textContent = "姓名不能为空"; msg.className = "message-area error"; input.focus(); return; }
    finish(name);
  });
  d.addEventListener("mousedown", (e) => { d._downTarget = e.target; });
  d.addEventListener("click", (e) => { if (e.target === d && d._downTarget === d || e.target.dataset.action === "cancel") finish(null); });
  d.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
  showDialog(d);
}

function finishChange(name, color, speed, cursorEffect = state.cursorEffect) {
  const oldName = state.nickname || "";
  state.nickname = name;
  state.glowColor = color || "";
  state.cursorEffect = cursorEffect !== undefined ? cursorEffect : (state.cursorEffect || "comet");
  state.floatSpeed = speed || 1;
  localStorage.setItem(NICKNAME_KEY, name);
  localStorage.setItem(NICKNAME_GLOW_COLOR_KEY, state.glowColor);
  localStorage.setItem(CURSOR_EFFECT_KEY, state.cursorEffect);
  localStorage.setItem(FLOAT_SPEED_KEY, String(state.floatSpeed));
  updateNicknameDisplay();
  apiFetch("/api/nickname", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName, newName: name })
  }).then(parseJsonResponse).then((data) => {
    if (data.user) {
      state.currentUser = data.user;
      state.permissions = data.user.permissions || state.permissions;
      updateAccountSummary();
      updateNicknameDisplay();
    }
  }).catch(() => {});
  showMessage("姓名与显示效果已修改", "success");
}

function updateNicknameDisplay() {
  if (!nicknameDisplay) return;
  const roleLabel = state.currentUser?.roleLabel;
  nicknameDisplay.textContent = roleLabel
    ? `${state.nickname || state.currentUser.username} · ${roleLabel}`
    : (state.nickname || "账户");
  nicknameDisplay.title = "打开账户中心";
  const hasGlow = !!state.glowColor;
  nicknameDisplay.classList.toggle("nickname-glow", hasGlow);
  if (hasGlow) {
    nicknameDisplay.style.setProperty("--glow-color", state.glowColor);
    nicknameDisplay.style.setProperty("--glow-filter-peak", `drop-shadow(0 0 4px ${state.glowColor}) drop-shadow(0 0 12px ${state.glowColor})`);
    nicknameDisplay.style.setProperty("--glow-filter-valley", `drop-shadow(0 0 6px ${state.glowColor}) drop-shadow(0 0 20px ${state.glowColor})`);
  }
}

function openAccountCenter() {
  updateAccountSummary();
  setAccountMessage("");
  if (accountCurrentPassword) accountCurrentPassword.value = "";
  if (accountNewPassword) accountNewPassword.value = "";
  showDialog(accountDialog);
}

function formatAccountDate(value) {
  if (!value) return "尚未登录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function setAccountInviteMessage(text, isError = false) {
  if (!accountInviteMessage) return;
  accountInviteMessage.textContent = text || "";
  accountInviteMessage.classList.toggle("is-error", Boolean(isError));
}

async function loadAdminInvite() {
  if (!accountInviteForm || !accountInviteCode || !accountInviteState || !accountInviteDisable) return;
  accountInviteForm.querySelectorAll("input, button").forEach((element) => {
    element.disabled = true;
  });
  accountInviteState.textContent = "读取中";
  accountInviteState.classList.remove("is-enabled");
  setAccountInviteMessage("");
  try {
    const response = await fetch("/api/admin/invite", { cache: "no-store" });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "邀请码读取失败");
    accountInviteCode.value = data.code || "";
    accountInviteState.textContent = data.enabled ? "已启用" : data.configured ? "已停用" : "未设置";
    accountInviteState.classList.toggle("is-enabled", Boolean(data.enabled));
    accountInviteDisable.disabled = !data.enabled;
    if (data.updatedAt) {
      const updater = data.updatedBy?.name || "管理员";
      setAccountInviteMessage(`最后更新：${formatAccountDate(data.updatedAt)} · ${updater}`);
    }
  } catch (error) {
    accountInviteState.textContent = "读取失败";
    setAccountInviteMessage(error.message || "邀请码读取失败", true);
    accountInviteDisable.disabled = true;
  } finally {
    accountInviteCode.disabled = false;
    const submitButton = accountInviteForm.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = false;
  }
}

async function loadAdminUsers() {
  if (!accountUsersList) return;
  accountUsersList.innerHTML = '<div class="workspace-empty">正在读取账号…</div>';
  const response = await fetch("/api/admin/users", { cache: "no-store" });
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    accountUsersList.innerHTML = "";
    const error = document.createElement("div");
    error.className = "workspace-empty";
    error.textContent = data.error || "账号列表读取失败";
    accountUsersList.appendChild(error);
    return;
  }
  accountUsersList.innerHTML = "";
  for (const user of data.users || []) {
    const row = document.createElement("div");
    row.className = "account-user-row";
    const main = document.createElement("div");
    main.className = "account-user-main";
    const name = document.createElement("div");
    name.className = "account-user-name";
    name.textContent = user.name;
    if (user.isSelf) {
      const self = document.createElement("span");
      self.className = "account-user-self";
      self.textContent = "当前账号";
      name.appendChild(self);
    }
    if (user.protectedAdmin) {
      const protectedLabel = document.createElement("span");
      protectedLabel.className = "account-user-self account-user-protected";
      protectedLabel.textContent = "初始管理员 · 已锁定";
      name.appendChild(protectedLabel);
    }
    const detail = document.createElement("div");
    detail.className = "account-user-detail";
    detail.textContent = `@${user.username} · 最近登录 ${formatAccountDate(user.lastLoginAt)} · ${user.sessionCount} 个会话`;
    main.append(name, detail);

    const select = document.createElement("select");
    select.className = "account-role-select";
    select.setAttribute("aria-label", `设置 ${user.name} 的角色`);
    select.disabled = Boolean(user.protectedAdmin);
    if (user.protectedAdmin) select.title = "本机初始管理员的权限不可修改";
    for (const optionData of [
      ["guest", "游客"],
      ["editor", "可编辑"],
      ["admin", "管理员"]
    ]) {
      const option = document.createElement("option");
      option.value = optionData[0];
      option.textContent = optionData[1];
      option.selected = user.role === optionData[0];
      select.appendChild(option);
    }
    select.addEventListener("change", async () => {
      if (user.protectedAdmin) return;
      const previousRole = user.role;
      select.disabled = true;
      try {
        const roleResponse = await apiFetch("/api/admin/users/role", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, role: select.value })
        });
        const roleData = await parseJsonResponse(roleResponse);
        if (!roleResponse.ok) throw new Error(roleData.error || "角色修改失败");
        showMessage(`${user.name} 已调整为${roleData.roleLabel}`, "success");
        if (user.isSelf) {
          await loadCurrentAccount();
          if (!can("*")) {
            closeDialog(accountUsersDialog);
            return;
          }
        }
        await loadAdminUsers();
      } catch (error) {
        select.value = previousRole;
        select.disabled = false;
        showMessage(error.message || "角色修改失败", "error");
      }
    });

    const controls = document.createElement("div");
    controls.className = "account-user-controls";
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "button ghost account-user-rename";
    renameButton.textContent = "修改姓名";
    renameButton.disabled = Boolean(user.isSelf);
    renameButton.title = user.isSelf
      ? "自己的姓名请在账户中心修改"
      : `修改账号 @${user.username} 的姓名`;
    renameButton.addEventListener("click", async () => {
      if (user.isSelf) return;
      const nextName = await openInputDialog({
        title: `修改姓名：@${user.username}`,
        label: "真实姓名",
        value: user.name,
        hint: "姓名会同步用于账号、论坛、聊天和已关联的文件创建者显示。",
        confirmText: "保存姓名",
        autocomplete: "name",
        validate: (value) => {
          const length = Array.from(value).length;
          return length < 1 || length > 20 ? "姓名必须为 1–20 个字符" : "";
        }
      });
      if (nextName === null || nextName === user.name) return;
      renameButton.disabled = true;
      try {
        const renameResponse = await apiFetch("/api/admin/users/name", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, name: nextName })
        });
        const renameData = await parseJsonResponse(renameResponse);
        if (!renameResponse.ok) throw new Error(renameData.error || "姓名修改失败");
        if (renameData.changedSelf) await loadCurrentAccount();
        showMessage(`账号 @${user.username} 的姓名已修改为 ${renameData.name}`, "success");
        await loadAdminUsers();
      } catch (error) {
        renameButton.disabled = false;
        showMessage(error.message || "姓名修改失败", "error");
      }
    });
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "button ghost account-user-reset";
    resetButton.textContent = "重置密码";
    resetButton.disabled = Boolean(user.protectedAdmin || user.isSelf);
    resetButton.title = user.protectedAdmin
      ? "本机初始管理员密码不可由其他管理员重置"
      : user.isSelf
        ? "请在账户中心验证当前密码后修改"
        : `重置账号 @${user.username} 的密码`;
    resetButton.addEventListener("click", async () => {
      if (user.protectedAdmin || user.isSelf) return;
      const newPassword = await openInputDialog({
        title: `重置密码：${user.name}`,
        label: `@${user.username}`,
        hint: "设置 6–16 位新密码；保存后该账号会从所有设备退出。",
        confirmText: "重置密码",
        inputType: "password",
        autocomplete: "new-password",
        trimValue: false,
        validate: (value) => {
          const length = Array.from(value).length;
          return length < 6 || length > 16 ? "新密码必须为 6–16 个字符" : "";
        }
      });
      if (newPassword === null) return;
      resetButton.disabled = true;
      try {
        const resetResponse = await apiFetch("/api/admin/users/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, newPassword })
        });
        const resetData = await parseJsonResponse(resetResponse);
        if (!resetResponse.ok) throw new Error(resetData.error || "密码重置失败");
        showMessage(`账号 @${user.username} 的密码已重置，现有会话已退出`, "success");
        await loadAdminUsers();
      } catch (error) {
        resetButton.disabled = false;
        showMessage(error.message || "密码重置失败", "error");
      }
    });
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "button ghost danger-button account-user-delete";
    deleteButton.textContent = user.protectedAdmin ? "不可删除" : "删除";
    deleteButton.disabled = Boolean(user.protectedAdmin);
    deleteButton.title = user.protectedAdmin
      ? "本机初始管理员账号不可删除"
      : `删除账号 @${user.username}`;
    deleteButton.addEventListener("click", async () => {
      if (user.protectedAdmin) return;
      const confirmed = await openConfirmDialog({
        title: `删除账号：${user.name}`,
        message: user.isSelf
          ? "这是当前登录账号。删除后会立即退出登录，账号及其所有登录会话无法恢复。"
          : "账号及其所有登录会话会被永久删除；已经发布的帖子和楼层内容会作为历史记录保留。",
        items: [`@${user.username} · ${user.roleLabel}`],
        confirmText: "删除账号",
        danger: true
      });
      if (!confirmed) return;
      deleteButton.disabled = true;
      try {
        const deleteResponse = await apiFetch("/api/admin/users/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id })
        });
        const deleteData = await parseJsonResponse(deleteResponse);
        if (!deleteResponse.ok) throw new Error(deleteData.error || "账号删除失败");
        if (deleteData.deletedSelf) {
          location.replace("/login");
          return;
        }
        showMessage(`账号 @${user.username} 已删除`, "success");
        await loadAdminUsers();
      } catch (error) {
        deleteButton.disabled = false;
        showMessage(error.message || "账号删除失败", "error");
      }
    });
    controls.append(select, renameButton, resetButton, deleteButton);
    row.append(main, controls);
    accountUsersList.appendChild(row);
  }
}

if (nicknameDisplay) {
  nicknameDisplay.addEventListener("click", openAccountCenter);
}
closeAccountBtn?.addEventListener("click", () => closeDialog(accountDialog));
closeAccountUsersBtn?.addEventListener("click", () => closeDialog(accountUsersDialog));
accountAppearanceBtn?.addEventListener("click", () => {
  closeDialog(accountDialog);
  changeNickname();
});
accountManageUsersBtn?.addEventListener("click", async () => {
  if (!can("*")) return;
  showDialog(accountUsersDialog);
  await Promise.all([loadAdminInvite(), loadAdminUsers()]);
});
accountInviteForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = accountInviteCode.value.trim();
  const length = Array.from(code).length;
  if (length < 6 || length > 32) {
    setAccountInviteMessage("邀请码必须为 6–32 个字符", true);
    accountInviteCode.focus();
    return;
  }
  if (/\s/u.test(code)) {
    setAccountInviteMessage("邀请码不能包含空格", true);
    accountInviteCode.focus();
    return;
  }
  const submitButton = accountInviteForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  accountInviteCode.disabled = true;
  setAccountInviteMessage("正在保存…");
  try {
    const response = await apiFetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "邀请码保存失败");
    await loadAdminInvite();
    setAccountInviteMessage("邀请码已启用；更换或停用前可重复使用。");
  } catch (error) {
    setAccountInviteMessage(error.message || "邀请码保存失败", true);
  } finally {
    submitButton.disabled = false;
    accountInviteCode.disabled = false;
  }
});
accountInviteDisable?.addEventListener("click", async () => {
  const confirmed = await openConfirmDialog({
    title: "停用可编辑邀请码",
    message: "停用后，当前邀请码立即失效；已经通过邀请码注册的可编辑账号不会受到影响。",
    confirmText: "停用邀请码",
    danger: true
  });
  if (!confirmed) return;
  accountInviteDisable.disabled = true;
  try {
    const response = await apiFetch("/api/admin/invite/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "邀请码停用失败");
    await loadAdminInvite();
    setAccountInviteMessage("邀请码已停用。重新保存即可再次启用。");
  } catch (error) {
    accountInviteDisable.disabled = false;
    setAccountInviteMessage(error.message || "邀请码停用失败", true);
  }
});
accountProfileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = accountProfileForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await apiFetch("/api/auth/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: accountNameInput.value })
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "姓名保存失败");
    state.currentUser = data.user;
    state.permissions = data.user.permissions || state.permissions;
    state.nickname = data.user.name;
    localStorage.setItem(NICKNAME_KEY, state.nickname);
    updateNicknameDisplay();
    updateAccountSummary();
    setAccountMessage("姓名已保存");
  } catch (error) {
    setAccountMessage(error.message || "姓名保存失败", true);
  } finally {
    submitButton.disabled = false;
  }
});
accountPasswordForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = accountPasswordForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await apiFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: accountCurrentPassword.value,
        newPassword: accountNewPassword.value
      })
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "密码修改失败");
    accountPasswordForm.reset();
    setAccountMessage("密码已更新，其他设备上的登录已退出");
  } catch (error) {
    setAccountMessage(error.message || "密码修改失败", true);
  } finally {
    submitButton.disabled = false;
  }
});
accountLogoutBtn?.addEventListener("click", async () => {
  accountLogoutBtn.disabled = true;
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } finally {
    location.replace("/login");
  }
});
accountDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog(accountDialog);
});
accountUsersDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog(accountUsersDialog);
});

// --- Log panel ---

function renderLogEntries() {
  if (!logList) return;
  const entries = state.logEntries;
  if (!entries.length) {
    logList.innerHTML = '<div class="log-empty">暂无记录</div>';
    return;
  }
  logList.innerHTML = entries.map((e, idx) => {
    const localCls = e.clientIp && (e.clientIp === "127.0.0.1" || e.clientIp === "::1") ? " is-local" : "";
    const hasItems = e.items && e.items.length > 0;
    const listId = `log-items-${idx}`;
    let detailHtml = escapeHtml(e.detail);
    if (hasItems) {
      const show = e.items.slice(0, 3);
      const remain = e.items.length - show.length;
      detailHtml += ` ${show.map(i => escapeHtml(i)).join("、")}${remain > 0 ? ` <span class="log-expand" data-target="${listId}">+${remain}</span>` : ""}`;
    }
    return `<div class="log-entry${localCls}">
      <span class="log-time">${escapeHtml(e.time)}</span>
      <span class="log-name">${escapeHtml(e.deviceName)}${e.clientIp ? `<span class="log-ip"> ${escapeHtml(e.clientIp)}</span>` : ""}</span>
      <span class="log-action">${escapeHtml(e.action)}</span>
      <span class="log-detail">${detailHtml}</span>
      ${hasItems ? `<div id="${listId}" class="log-items is-collapsed">${e.items.map(i => `<div>${escapeHtml(i)}</div>`).join("")}</div>` : ""}
    </div>`;
  }).join("");
  logList.scrollTop = logList.scrollHeight;
}

let lastLogSnapshot = "";
let lastLogLength = 0;
let firstPoll = true;

async function pollLogs() {
  try {
    const res = await fetch("/api/logs", { cache: "no-store" });
    const data = await res.json();
    if (res.ok && data.entries) {
      // Skip spawning old events on first load
      if (firstPoll) {
        firstPoll = false;
        lastLogLength = data.entries.length;
        lastLogSnapshot = JSON.stringify(data.entries);
        state.logEntries = data.entries;
        if (!logPanel.classList.contains("is-hidden")) renderLogEntries();
        return;
      }
      const snap = JSON.stringify(data.entries);
      // Detect new entries to spawn floating file names
      if (data.entries.length > lastLogLength) {
        const newCount = data.entries.length - lastLogLength;
        const newEntries = data.entries.slice(-newCount);
        for (const e of newEntries) {
          if ((e.action === "上传" || e.action === "删除" || e.action === "下载") && e.items && e.items.length > 0) {
            spawnFileEventChars(e.items.slice(0, 3), e.action);
          }
        }
      }
      if (snap === lastLogSnapshot) return;
      lastLogSnapshot = snap;
      lastLogLength = data.entries.length;
      state.logEntries = data.entries;
      if (!logPanel.classList.contains("is-hidden")) renderLogEntries();
    }
  } catch {}
}

if (logToggleBtn) {
  logToggleBtn.addEventListener("click", () => {
    recycleDrawer.classList.add("is-hidden")
    const hidden = logPanel.classList.toggle("is-hidden");
    if (!hidden) {
      renderLogEntries();
      pollLogs();
    }
  });
}
if (closeLogBtn) {
  closeLogBtn.addEventListener("click", () => logPanel.classList.add("is-hidden"));
}
// Delegated click for log expand/collapse (bound once)
if (logList) {
  logList.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.classList.contains("log-expand")) {
      const target = document.getElementById(t.dataset.target);
      if (!target) return;
      const collapsed = target.classList.toggle("is-collapsed");
      t.textContent = collapsed ? "展开" : "收起";
    }
  });
}

// --- Background ---
function setBgDisplay(src, isVideo) {
  const el = document.querySelector("#bgOverlay");
  if (!el) return;
  el.innerHTML = "";
  if (isVideo) {
    const v = document.createElement("video");
    v.src = src; v.muted = true; v.loop = true; v.playsInline = true;
    v.autoplay = true;
    el.appendChild(v);
    v.play().catch(() => {});
  } else {
    const i = document.createElement("img");
    i.src = src; i.alt = "";
    el.appendChild(i);
  }
}

function initBackground() {}

let _bgBlobUrl = null;
const bgBtn = document.querySelector("#bgUploadBtn");
const bgInput = document.querySelector("#bgFileInput");
if (bgBtn && bgInput) {
  bgBtn.addEventListener("click", () => bgInput.click());
  bgInput.addEventListener("change", () => {
    const file = bgInput.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    if (_bgBlobUrl) { URL.revokeObjectURL(_bgBlobUrl); _bgBlobUrl = null; }
    const url = URL.createObjectURL(file);
    _bgBlobUrl = url;
    setBgDisplay(url, isVideo);
    bgInput.value = "";
  });
  bgBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (_bgBlobUrl) { URL.revokeObjectURL(_bgBlobUrl); _bgBlobUrl = null; }
    const el = document.querySelector("#bgOverlay");
    if (el) el.innerHTML = "";
  });
}

// --- Hide UI toggle ---
const hideBtn = document.querySelector("#hideUiBtn");
if (hideBtn) {
  let uiHidden = false;
  const hideIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const showIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  function updateHideButton() {
    hideBtn.innerHTML = uiHidden ? showIcon : hideIcon;
    hideBtn.title = uiHidden ? "显示界面" : "隐藏界面，纯享背景";
    hideBtn.setAttribute("aria-label", uiHidden ? "显示界面" : "隐藏界面");
    hideBtn.classList.toggle("is-active", uiHidden);
  }
  updateHideButton();
  hideBtn.addEventListener("click", () => {
    uiHidden = !uiHidden;
    const els = [
      document.querySelector(".version-badge"),
      document.querySelector(".hero"),
      document.querySelector(".panel"),
      document.querySelector("#logToggleBtn"),
      document.querySelector("#themeToggleBtn"),
      document.querySelector("#recycleToggleBtn"),
      document.querySelector("#logPanel"),
      document.querySelector("#recycleDrawer"),
      document.querySelector("#floatControl"),
      document.querySelector("#workspaceRail"),
      document.querySelector("#tab-audio"),
      document.querySelector("#tab-video"),
    ];
    for (const el of els) {
      if (!el) continue;
      if (uiHidden) {
        el.dataset.origDisplay = el.style.display || "";
        el.style.display = "none";
      } else {
        el.style.display = el.dataset.origDisplay || "";
        delete el.dataset.origDisplay;
      }
    }
    updateHideButton();
  });
}

// --- Float controls (size + speed) ---

const floatControl = document.querySelector("#floatControl");
const floatSizeSlider = document.querySelector("#floatSizeSlider");
const floatSpeedSlider = document.querySelector("#floatSpeedSlider");

if (floatSizeSlider) {
  floatSizeSlider.value = state.floatSize;
  floatSizeSlider.addEventListener("input", () => {
    state.floatSize = Number(floatSizeSlider.value);
    localStorage.setItem(FLOAT_SIZE_KEY, String(state.floatSize));
    if (state.glowColor && state.nickname) {
      stopFloatingChars();
      startFloatingChars();
    }
  });
}
if (floatSpeedSlider) {
  floatSpeedSlider.value = state.floatSpeed;
  floatSpeedSlider.addEventListener("input", () => {
    state.floatSpeed = Number(floatSpeedSlider.value);
    localStorage.setItem(FLOAT_SPEED_KEY, String(state.floatSpeed));
    if (state.glowColor && state.nickname) {
      stopFloatingChars();
      startFloatingChars();
    }
  });
}

// --- Init ---

updateNicknameDisplay();

mkdirBtn.addEventListener("click", createFolder);
document.querySelector("#createProjectBtn").addEventListener("click", createProject);
refreshBtn.addEventListener("click", () => loadDir(state.currentDir));
var upDirBtn = document.querySelector("#upDirBtn");
if (upDirBtn) {
  upDirBtn.addEventListener("click", () => {
    var parts = state.currentDir.split("/");
    parts.pop();
    loadDir(parts.join("/"));
  });
}
async function performSearch(query) {
  if (state.searchTimeout) {
    clearTimeout(state.searchTimeout);
    state.searchTimeout = null;
  }
  state.searchTimeout = setTimeout(async () => {
    state.searchTimeout = null;
    try {
      var sUrl = "/api/search?q=" + encodeURIComponent(query) + (state.nsfwMode ? "&nsfw=1" : "")
      const res = await fetch(sUrl);
      const data = await res.json();
      if (res.status === 401 && state.nsfwMode) {
        setNsfwModeUi(false);
        loadDir("");
        return;
      }
      if (!res.ok) throw new Error(data.error || "搜索失败");
      state.searchResults = data.items || [];
      state.searchResults._stoppedEarly = data.stoppedEarly;
      renderCurrentDirectory();
    } catch (error) {
      showMessage(error.message, "error");
    }
  }, 300);
}

mainSearchInput.addEventListener("input", (event) => {
  state.searchQuery = event.target.value;
  if (state.searchQuery) {
    performSearch(state.searchQuery);
  } else {
    if (state.searchTimeout) {
      clearTimeout(state.searchTimeout);
      state.searchTimeout = null;
    }
    state.searchResults = [];
    renderCurrentDirectory();
  }
});
listViewBtn.addEventListener("click", () => setViewMode("list"));
gridViewBtn.addEventListener("click", () => setViewMode("grid"));

// 状态筛选自定义下拉框
var filterSwitchBtn = document.getElementById("filterSwitchBtn")
var filterSwitchMenu = document.getElementById("filterSwitchMenu")
if (filterSwitchBtn && filterSwitchMenu) {
  filterSwitchBtn.addEventListener("click", function(e) {
    e.stopPropagation()
    filterSwitchMenu.classList.toggle("is-hidden")
  })
  filterSwitchMenu.querySelectorAll(".filter-opt").forEach(function(opt) {
    opt.addEventListener("click", function() {
      var val = this.dataset.value
      state.filterStatus = val
      filterSwitchBtn.textContent = this.textContent
      filterSwitchMenu.querySelectorAll(".filter-opt").forEach(function(o) { o.classList.remove("active") })
      this.classList.add("active")
      filterSwitchMenu.classList.add("is-hidden")
      renderCurrentDirectory()
    })
  })
  document.addEventListener("click", function() { filterSwitchMenu.classList.add("is-hidden") })
}
function updateFilterByDir() {
  var sw = document.getElementById("filterSwitch")
  if (!sw) return
  sw.style.display = (!state.currentDir || state.currentDir === "") ? "" : "none"
}
updateFilterByDir()
document.querySelectorAll(".sort-th").forEach((th) => {
  th.addEventListener("click", () => toggleSort(th.dataset.sort));
});
closePreviewBtn.addEventListener("click", closePreview);
previewDialog.addEventListener("click", (event) => {
  if (event.target === previewDialog) closePreview();
});
document.addEventListener("keydown", (event) => {
  if (!previewDialog.open) return;
  if (event.key === "ArrowLeft") { event.preventDefault(); navigatePreview(-1); }
  if (event.key === "ArrowRight") { event.preventDefault(); navigatePreview(1); }
  if (event.key === "Escape") { closePreview(); }
});
var previewPrevBtn = document.querySelector("#previewPrevBtn");
var previewNextBtn = document.querySelector("#previewNextBtn");
if (previewPrevBtn) previewPrevBtn.addEventListener("click", () => navigatePreview(-1));
if (previewNextBtn) previewNextBtn.addEventListener("click", () => navigatePreview(1));
recycleToggleBtn.addEventListener("click", () => {
  logPanel.classList.add("is-hidden")
  recycleDrawer.classList.toggle("is-hidden");
  loadRecycleItems();
});
closeRecycleBtn.addEventListener("click", () => recycleDrawer.classList.add("is-hidden"));

recycleSearchInput.addEventListener("input", (event) => {
  state.recycleFilter = event.target.value;
  renderRecycleItems();
});
recycleSelectAllBtn.addEventListener("click", selectAllFilteredRecycleItems);
recycleInvertSelectionBtn.addEventListener("click", invertFilteredRecycleSelection);
recycleRestoreSelectedBtn.addEventListener("click", restoreSelectedRecycleItems);
recycleDeleteSelectedBtn.addEventListener("click", deleteSelectedRecycleItems);
closeMoveDialogBtn.addEventListener("click", closeMoveDialog);
moveSearchInput.addEventListener("input", (event) => {
  state.moveFilter = event.target.value;
  renderMoveDirectoryList();
});
moveCreateFolderBtn.addEventListener("click", createMoveTargetFolder);
moveDialog.addEventListener("click", (event) => {
  if (event.target === moveDialog) closeMoveDialog();
});
moveHereBtn.addEventListener("click", async () => {
  if (!state.movePaths.length) return;
  if (!(await moveItems(state.movePaths, state.moveTargetDir))) return;
  const movedCount = state.movePaths.length;
  const movedPaths = [...state.movePaths];
  closeMoveDialog();
  for (const itemPath of movedPaths) {
    state.selectedPaths.delete(itemPath);
  }
  updateToolbarButtons();
  showMessage(movedCount === 1 ? "已移动项目" : `已移动 ${movedCount} 项`, "success");
  await loadDir(state.currentDir);
});


updateToolbarButtons();
updateSortButtons();
initColumnResize();

// Tab switching
document.querySelectorAll(".tab").forEach(function(t) {
  t.addEventListener("click", function() {
    var tab = t.dataset.tab;
    document.querySelectorAll(".tab").forEach(function(x) { x.classList.remove("active"); });
    t.classList.add("active");
    document.querySelectorAll(".tab-content").forEach(function(x) { x.classList.remove("active"); });
    var target = document.getElementById("tab-" + tab);
    if (target) target.classList.add("active");
  });
});

// Theme toggle button init
const themeToggleBtn = document.querySelector("#themeToggleBtn");
if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", toggleTheme);
}
document.body.dataset.uiStyle = "editorial";
applyThemePos(state.themePos);
initBackground();
setViewMode(state.viewMode);
async function initializeFileView() {
  const user = await accountReady;
  if (!user) return;
  await restoreNsfwSession();
  await loadInProgressProjects();
  const savedDir = localStorage.getItem(CURRENT_DIR_KEY) || "";
  await loadDir(savedDir);
  if (can("recycle.read")) await loadRecycleItems();
  if (can("*")) {
    pollLogs();
    setInterval(pollLogs, 3000);
  }
}
initializeFileView();
setupScrollPagination();

// --- 宽屏工作区：目录/选中项概览 + 协作动态 ---
function formatWorkspaceTime(value) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function getWorkspaceItemBytes(item) {
  if (!item) return null;
  if (item.type === "directory") return Number.isFinite(item.folderSize) ? item.folderSize : null;
  return Number.isFinite(item.size) ? item.size : null;
}

function isWorkspaceDateToday(value) {
  const date = new Date(value);
  const now = new Date();
  return !Number.isNaN(date.getTime())
    && date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function formatWorkspaceProjectTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
  if (isWorkspaceDateToday(date)) return `今天 ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${time}`;
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function renderWorkspaceWorkSummary() {
  if (!state.workspaceProjectsLoaded) {
    return '<div class="workspace-work-loading">正在读取工作概况…</div>';
  }
  const projects = state.workspaceProjects;
  const notStarted = projects.filter((project) => project.status === "not_started").length;
  const inProgress = projects.filter((project) => project.status === "in_progress").length;
  const completed = projects.filter((project) => project.status === "completed").length;
  const activity = state.workspaceStatus && state.workspaceStatus.activity;
  const uploadedToday = activity ? Number(activity.uploadedFiles) || 0 : null;
  const uploadedBytesToday = activity ? Number(activity.uploadedBytes) || 0 : null;
  const downloadedToday = activity ? Number(activity.downloadedFiles) || 0 : null;
  const downloadedBytesToday = activity ? Number(activity.downloadedBytes) || 0 : null;
  const deletedToday = activity ? Number(activity.deletedItems) || 0 : null;
  const deletedBytesToday = activity ? Number(activity.deletedBytes) || 0 : null;
  const activeDevices = activity ? Number(activity.activeDevices) || 0 : null;
  const projectCount = Math.max(1, projects.length);
  const pendingWidth = notStarted / projectCount * 100;
  const progressWidth = inProgress / projectCount * 100;
  const completedWidth = completed / projectCount * 100;
  return `
    <section class="workspace-work-summary" aria-label="工作概况">
      <div class="workspace-projects-head">
        <span>工作概况</span>
        <strong>${projects.length ? `最近活动 ${formatWorkspaceProjectTime(Math.max(...projects.map((project) => new Date(project.updatedAt).getTime() || 0)))}` : "暂无项目"}</strong>
      </div>
      <div class="workspace-stat-grid workspace-work-grid">
        <div class="workspace-stat"><span>项目总数</span><strong>${projects.length} 项</strong></div>
        <div class="workspace-stat workspace-activity-stat" title="文件项数 · 数据量"><span>今日上传</span><strong>${uploadedToday == null ? "读取中" : `${uploadedToday} 项 · ${formatWorkspaceActivitySize(uploadedBytesToday, activity.uploadedBytesComplete)}`}</strong></div>
        <div class="workspace-stat workspace-activity-stat" title="文件项数 · 数据量"><span>今日下载 / 删除</span><strong class="workspace-activity-values">${downloadedToday == null || deletedToday == null ? "读取中" : `<b>下载 ${downloadedToday} 项 · ${formatWorkspaceActivitySize(downloadedBytesToday, activity.downloadedBytesComplete)}</b><b>删除 ${deletedToday} 项 · ${formatWorkspaceActivitySize(deletedBytesToday, activity.deletedBytesComplete)}</b>`}</strong></div>
        <div class="workspace-stat"><span>在线设备</span><strong>${activeDevices == null ? "读取中" : `${activeDevices} 台`}</strong></div>
      </div>
      <div class="workspace-progress" aria-label="待开始 ${notStarted} 项，进行中 ${inProgress} 项，已完成 ${completed} 项">
        <div class="workspace-progress-track">
          <span class="is-pending" style="width:${pendingWidth.toFixed(2)}%"></span>
          <span class="is-progress" style="width:${progressWidth.toFixed(2)}%"></span>
          <span class="is-completed" style="width:${completedWidth.toFixed(2)}%"></span>
        </div>
        <div class="workspace-progress-legend">
          <span><i class="is-pending"></i>待开始 ${notStarted}</span>
          <span><i class="is-progress"></i>进行中 ${inProgress}</span>
          <span><i class="is-completed"></i>完成 ${completed}</span>
        </div>
      </div>
    </section>
  `;
}

function renderInProgressProjects() {
  const projects = [...state.inProgressProjects].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
  const rows = !state.workspaceProjectsLoaded
    ? '<div class="workspace-project-empty">正在读取进行中的项目…</div>'
    : projects.length
      ? projects.map((project) => {
        const size = getWorkspaceItemBytes(project);
        const meta = `${formatWorkspaceProjectTime(project.updatedAt)}${size == null ? "" : ` · ${formatSize(size)}`}`;
        return `
        <button class="workspace-project-link" type="button" data-workspace-project-path="${escapeHtml(project.path)}" title="${escapeHtml(project.path)}">
          <span>${escapeHtml(project.name)}</span>
          <small>${escapeHtml(meta)}</small>
        </button>
      `;
      }).join("")
      : '<div class="workspace-project-empty">暂无进行中的项目</div>';
  return `
    <div class="workspace-projects">
      <div class="workspace-projects-head">
        <span>进行中的项目</span>
        <strong>${projects.length} 项</strong>
      </div>
      <div class="workspace-project-list">${rows}</div>
    </div>
  `;
}

function renderWorkspaceStorage() {
  const data = state.workspaceStatus;
  if (!data || !data.storage) {
    return `
      <div class="workspace-storage">
        <div class="workspace-storage-head"><span>存储空间</span><strong>读取中…</strong></div>
        ${renderInProgressProjects()}
      </div>
    `;
  }
  const storage = data.storage;
  const total = Number(storage.totalBytes) || 0;
  const used = Number(storage.usedBytes) || 0;
  const free = Number(storage.freeBytes) || 0;
  const usedPercent = total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : 0;
  return `
    <div class="workspace-storage">
      <div class="workspace-storage-head">
        <span>${escapeHtml(storage.volume || "共享盘")} 存储</span>
        <strong>剩余 ${formatSize(free)} / ${formatSize(total)}</strong>
      </div>
      <div class="workspace-storage-bar" aria-label="磁盘已用 ${Math.round(usedPercent)}%">
        <span style="width:${usedPercent.toFixed(2)}%"></span>
      </div>
      ${renderInProgressProjects()}
    </div>
  `;
}

function getWorkspaceSelectedItems() {
  const source = state.searchQuery ? state.searchResults : state.currentItems;
  return source.filter((item) => state.selectedPaths.has(item.path));
}

function renderWorkspaceSingleItem(item) {
  const size = getWorkspaceItemBytes(item);
  const status = item.type === "directory" ? (statusLabels[item.status] || "待开始") : "—";
  const creator = item.creator || "—";
  const createdTime = item.createdByAt || item.bornAt;
  let preview = escapeHtml(getFileType(item));
  if (item.previewType === "image" || item.previewType === "video") {
    const src = `/api/thumb?path=${encodeURIComponent(item.path)}&w=240${state.nsfwMode ? "&nsfw=1" : ""}`;
    preview = `<img src="${src}" alt="" loading="lazy" />`;
  } else if (item.previewType === "audio") {
    preview = "AUDIO";
  } else if (item.type === "directory") {
    preview = "DIR";
  }
  return `
    <div class="workspace-selected-head">
      <div class="workspace-selected-preview">${preview}</div>
      <div class="workspace-selected-title">
        <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(getFileType(item))}${item.isProject ? " · 项目目录" : ""}</span>
        <span class="workspace-selected-uploader" title="创建者：${escapeHtml(creator)}">创建者 · ${escapeHtml(creator)}</span>
      </div>
    </div>
    <dl class="workspace-detail-list">
      <div class="workspace-detail-row"><dt>路径</dt><dd title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</dd></div>
      <div class="workspace-detail-pair">
        <div><dt>大小</dt><dd>${size == null ? "计算中或未知" : formatSize(size)}</dd></div>
        <div><dt>状态</dt><dd>${escapeHtml(status)}</dd></div>
      </div>
      <div class="workspace-detail-pair">
        <div><dt>创建</dt><dd>${formatWorkspaceTime(createdTime)}</dd></div>
        <div><dt>修改</dt><dd>${formatWorkspaceTime(item.updatedAt)}</dd></div>
      </div>
    </dl>
    ${renderWorkspaceStorage()}
  `;
}

function renderWorkspaceMultipleItems(items) {
  const folders = items.filter((item) => item.type === "directory").length;
  const files = items.length - folders;
  const knownBytes = items.reduce((total, item) => {
    const size = getWorkspaceItemBytes(item);
    return total + (size == null ? 0 : size);
  }, 0);
  const previewNames = items.slice(0, 4).map((item) => item.name).join("、");
  return `
    <div class="workspace-path" title="${escapeHtml(previewNames)}">${escapeHtml(previewNames)}${items.length > 4 ? "…" : ""}</div>
    <div class="workspace-stat-grid">
      <div class="workspace-stat"><span>已选择</span><strong>${items.length} 项</strong></div>
      <div class="workspace-stat"><span>已知大小</span><strong>${formatSize(knownBytes)}</strong></div>
      <div class="workspace-stat"><span>文件夹</span><strong>${folders}</strong></div>
      <div class="workspace-stat"><span>文件</span><strong>${files}</strong></div>
    </div>
    ${renderWorkspaceStorage()}
  `;
}

function renderWorkspaceDirectory() {
  return `${renderWorkspaceWorkSummary()}${renderWorkspaceStorage()}`;
}

function renderWorkspaceOverview() {
  if (!workspaceOverviewBody || !workspaceModeLabel) return;
  const selectedItems = getWorkspaceSelectedItems();
  if (selectedItems.length === 1) {
    workspaceModeLabel.textContent = "项目详情";
    workspaceOverviewBody.innerHTML = renderWorkspaceSingleItem(selectedItems[0]);
  } else if (selectedItems.length > 1) {
    workspaceModeLabel.textContent = "批量选择";
    workspaceOverviewBody.innerHTML = renderWorkspaceMultipleItems(selectedItems);
  } else {
    workspaceModeLabel.textContent = "项目概览";
    workspaceOverviewBody.innerHTML = renderWorkspaceDirectory();
  }
}

if (workspaceOverviewBody) {
  workspaceOverviewBody.addEventListener("click", (event) => {
    const projectButton = event.target.closest("[data-workspace-project-path]");
    if (!projectButton) return;
    loadDir(projectButton.dataset.workspaceProjectPath || "");
  });
  workspaceOverviewBody.addEventListener("contextmenu", (event) => {
    const projectButton = event.target.closest("[data-workspace-project-path]");
    if (!projectButton) return;
    event.preventDefault();
    event.stopPropagation();
    const projectPath = projectButton.dataset.workspaceProjectPath || "";
    const project = state.inProgressProjects.find((item) => item.path === projectPath);
    if (!project) return;
    showContextMenu([
      { label: "打开", action: function() { loadDir(project.path); } },
      { sep: true },
      { label: "待开始", action: function() { setItemStatus(project, "not_started"); } },
      { label: "进行中", action: function() { setItemStatus(project, "in_progress"); } },
      { label: "已完成", action: function() { setItemStatus(project, "completed"); } },
      { sep: true },
      { label: "重命名", action: async function() { await renameItem(project); loadInProgressProjects(); } },
      { label: "复制", action: function() { copyItem(project); } },
      { label: "移动", action: async function() { await moveItem(project); loadInProgressProjects(); } },
      { sep: true },
      { label: "删除", action: async function() { await deleteItem(project); loadInProgressProjects(); }, danger: true }
    ], event.clientX, event.clientY);
  });
}

async function loadWorkspaceStatus() {
  try {
    const response = await fetch("/api/workspace/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取工作区状态失败");
    state.workspaceStatus = data;
    renderWorkspaceOverview();
  } catch {
    state.workspaceStatus = null;
    renderWorkspaceOverview();
  }
}

let workspaceProjectSizeTimer = null;

async function refreshWorkspaceProjectSizes(attempt = 0) {
  if (workspaceProjectSizeTimer) {
    clearTimeout(workspaceProjectSizeTimer);
    workspaceProjectSizeTimer = null;
  }
  const pendingProjects = state.workspaceProjects.filter(
    (project) => project.folderSizeStatus === "pending" || project.folderSizeStatus === "stale"
  );
  if (!pendingProjects.length) return;
  const params = new URLSearchParams();
  pendingProjects.slice(0, 200).forEach((project) => params.append("path", project.path));
  try {
    let url = `/api/folder-sizes?${params.toString()}`;
    if (state.nsfwMode) url += "&nsfw=1";
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) return;
    const updates = new Map((data.items || []).map((item) => [item.path, item]));
    state.workspaceProjects.forEach((project) => {
      const next = updates.get(project.path);
      if (!next) return;
      project.folderSize = next.folderSize == null ? null : Number(next.folderSize);
      project.folderSizeStatus = next.folderSizeStatus;
      project.folderSizeCachedAt = next.folderSizeCachedAt;
    });
    renderWorkspaceOverview();
    const stillPending = state.workspaceProjects.some(
      (project) => project.folderSizeStatus === "pending" || project.folderSizeStatus === "stale"
    );
    if (stillPending && attempt < 12) {
      workspaceProjectSizeTimer = setTimeout(() => refreshWorkspaceProjectSizes(attempt + 1), 1500);
    }
  } catch {
    // 下一次工作区刷新会重新请求项目大小。
  }
}

async function loadInProgressProjects() {
  try {
    let url = "/api/list?dir=&offset=0&limit=200";
    if (state.nsfwMode) url += "&nsfw=1";
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取进行中项目失败");
    state.workspaceProjects = (data.items || []).filter((item) => item.type === "directory");
    state.inProgressProjects = state.workspaceProjects.filter((item) => item.status === "in_progress");
    state.workspaceProjectsLoaded = true;
    renderWorkspaceOverview();
    refreshWorkspaceProjectSizes();
  } catch {
    state.inProgressProjects = [];
    state.workspaceProjects = [];
    state.workspaceProjectsLoaded = true;
    renderWorkspaceOverview();
  }
}

function renderForumReplies(container, replies, {
  append = false,
  total = replies.length,
  hasMore = false,
  postId
} = {}) {
  container.querySelector(".forum-floor-load-more")?.remove();
  const previousLoadedCount = append ? Number(container.dataset.loadedCount || 0) : 0;
  if (!append) container.innerHTML = "";
  if (!replies.length && previousLoadedCount === 0) {
    const empty = document.createElement("div");
    empty.className = "forum-reply forum-reply-empty";
    empty.textContent = "还没有回复";
    container.appendChild(empty);
  } else if (append) {
    container.querySelector(".forum-reply-empty")?.remove();
  }
  replies.forEach((reply) => {
    const item = document.createElement("div");
    item.className = "forum-reply";
    item.dataset.replyId = String(reply.id);
    const meta = document.createElement("div");
    meta.className = "forum-reply-meta";
    const metaLabel = document.createElement("span");
    metaLabel.textContent = `${reply.floorNumber}F · ${reply.author} · ${formatWorkspaceTime(reply.createdAt)}`;
    const floorReplyButton = document.createElement("button");
    floorReplyButton.type = "button";
    floorReplyButton.className = "forum-floor-reply-button";
    floorReplyButton.textContent = "回复";
    floorReplyButton.setAttribute("aria-label", `回复 ${reply.floorNumber}F ${reply.author}`);
    floorReplyButton.addEventListener("click", () => {
      container.dispatchEvent(new CustomEvent("forum-reply-target", {
        detail: {
          id: Number(reply.id),
          floorNumber: Number(reply.floorNumber),
          author: String(reply.author || "匿名")
        }
      }));
    });
    meta.append(metaLabel, floorReplyButton);
    let reference = null;
    if (reply.parentReplyId && reply.replyToFloor) {
      reference = document.createElement("button");
      reference.type = "button";
      reference.className = "forum-reply-reference";
      reference.textContent = `回复 ${reply.replyToFloor}F · @${reply.replyToAuthor || "匿名"}`;
      reference.addEventListener("click", () => {
        const target = container.querySelector(`[data-reply-id="${Number(reply.parentReplyId)}"]`);
        if (!target) return;
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        target.classList.add("is-referenced");
        setTimeout(() => target.classList.remove("is-referenced"), 1200);
      });
    }
    const content = document.createElement("div");
    content.className = "forum-reply-content";
    content.textContent = reply.content;
    item.appendChild(meta);
    if (reference) item.appendChild(reference);
    item.appendChild(content);
    container.appendChild(item);
  });
  const loadedCount = previousLoadedCount + replies.length;
  container.dataset.loadedCount = String(loadedCount);
  container.dataset.total = String(total);
  if (hasMore) {
    const loadMore = document.createElement("div");
    loadMore.className = "forum-floor-load-more";
    const remaining = Math.max(0, total - loadedCount);
    const hint = document.createElement("span");
    hint.className = "forum-floor-load-more-count";
    hint.textContent = remaining > 0 ? `还有 ${remaining} 楼` : "还有更多楼层";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "forum-floor-load-more-button";
    const label = document.createElement("span");
    label.className = "forum-floor-load-more-label";
    label.textContent = "加载更多";
    button.append(hint, label);
    button.addEventListener("click", async () => {
      button.disabled = true;
      label.textContent = "加载中…";
      await loadForumReplies(postId, container, { append: true, limit: 5 });
    });
    loadMore.appendChild(button);
    container.appendChild(loadMore);
  }
}

async function loadForumReplies(postId, container, { append = false, limit = 4 } = {}) {
  if (!append) {
    container.innerHTML = '<div class="forum-reply">正在读取回复…</div>';
    container.dataset.loadedCount = "0";
  }
  try {
    const offset = append ? Number(container.dataset.loadedCount || 0) : 0;
    const response = await fetch(
      `/api/forum/replies?postId=${encodeURIComponent(postId)}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
      { cache: "no-store" }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取回复失败");
    renderForumReplies(container, data.replies || [], {
      append,
      total: Number(data.total) || 0,
      hasMore: Boolean(data.hasMore),
      postId
    });
    container.dataset.loaded = "1";
  } catch (error) {
    if (append) {
      renderForumReplies(container, [], {
        append: true,
        total: Number(container.dataset.total || 0),
        hasMore: true,
        postId
      });
      showMessage(error.message || "更多楼层加载失败", "error");
      return;
    }
    container.innerHTML = "";
    const item = document.createElement("div");
    item.className = "forum-reply";
    item.textContent = error.message || "回复读取失败";
    container.appendChild(item);
  }
}

function getSelectedForumPosts() {
  return state.forumPosts.filter(
    (post) => post.canDelete && state.forumSelectedPostIds.has(post.id)
  );
}

function updateForumManagementUi() {
  const deletableIds = new Set(state.forumPosts.filter((post) => post.canDelete).map((post) => post.id));
  for (const postId of state.forumSelectedPostIds) {
    if (!deletableIds.has(postId)) state.forumSelectedPostIds.delete(postId);
  }
  if (!deletableIds.size) {
    state.forumManageMode = false;
    state.forumSelectedPostIds.clear();
  }
  if (forumManageToggle) {
    forumManageToggle.classList.toggle("is-hidden", !deletableIds.size);
    forumManageToggle.textContent = state.forumManageMode ? "完成" : "多选";
    forumManageToggle.setAttribute("aria-expanded", String(state.forumManageMode));
  }
  if (forumPostList) forumPostList.classList.toggle("is-managing", state.forumManageMode);
  if (forumBatchBar) forumBatchBar.classList.toggle("is-hidden", !state.forumManageMode);
  const selectedCount = getSelectedForumPosts().length;
  if (forumBatchCount) forumBatchCount.textContent = `已选择 ${selectedCount} 条`;
  if (forumSelectAllToggle) {
    const allSelected = deletableIds.size > 0
      && [...deletableIds].every((postId) => state.forumSelectedPostIds.has(postId));
    forumSelectAllToggle.textContent = allSelected ? "取消全选" : "全选";
    forumSelectAllToggle.disabled = deletableIds.size === 0;
  }
  if (forumBatchDelete) forumBatchDelete.disabled = selectedCount === 0;
  document.querySelectorAll(".forum-post-select").forEach((selectionControl) => {
    const selected = state.forumSelectedPostIds.has(Number(selectionControl.dataset.postId));
    selectionControl.classList.toggle("is-checked", selected);
    selectionControl.setAttribute("aria-checked", String(selected));
  });
}

async function confirmAndDeleteForumPosts(posts, exitManageMode = false) {
  const targets = posts.filter((post) => post && post.canDelete);
  if (!targets.length) return false;
  const isBatch = targets.length > 1;
  const confirmed = await openConfirmDialog({
    title: isBatch ? `删除 ${targets.length} 条动态` : "删除动态",
    message: isBatch
      ? "所选动态及其全部回复将被永久删除。"
      : "这条动态及其全部回复将被永久删除。",
    items: targets.map((post) => post.title),
    confirmText: isBatch ? "批量删除" : "删除",
    danger: true
  });
  if (!confirmed) return false;
  if (forumBatchDelete) forumBatchDelete.disabled = true;
  try {
    const response = await apiFetch(isBatch ? "/api/forum/posts/delete-batch" : "/api/forum/posts/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isBatch ? { ids: targets.map((post) => post.id) } : { id: targets[0].id })
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "删除失败");
    targets.forEach((post) => state.forumSelectedPostIds.delete(post.id));
    if (exitManageMode) {
      state.forumManageMode = false;
      state.forumSelectedPostIds.clear();
    }
    await loadForumPosts();
    showMessage(isBatch ? `已删除 ${targets.length} 条动态` : "动态已删除", "success");
    return true;
  } catch (error) {
    showMessage(error.message || "删除失败", "error");
    return false;
  } finally {
    updateForumManagementUi();
  }
}

function closeForumReactionPickers() {
  if (forumReactionPickerPortal) {
    forumReactionPickerPortal.classList.add("is-hidden");
    forumReactionPickerPortal.classList.remove("is-reaction-overflow");
    forumReactionPickerPortal.innerHTML = "";
    forumReactionPickerPortal.dataset.anchorKey = "";
  }
}

function ensureForumReactionPickerPortal() {
  if (!forumReactionPickerPortal) {
    forumReactionPickerPortal = document.createElement("span");
    forumReactionPickerPortal.className = "forum-reaction-picker is-forum-reaction-portal is-hidden";
    forumReactionPickerPortal.addEventListener("pointerdown", (event) => event.stopPropagation());
    forumReactionPickerPortal.addEventListener("click", (event) => event.stopPropagation());
    document.body.appendChild(forumReactionPickerPortal);
  }
  return forumReactionPickerPortal;
}

function positionForumReactionPicker(anchor) {
  const anchorRect = anchor.getBoundingClientRect();
  const pickerRect = forumReactionPickerPortal.getBoundingClientRect();
  const pageGap = 8;
  const left = Math.min(
    Math.max(pageGap, anchorRect.left),
    Math.max(pageGap, window.innerWidth - pickerRect.width - pageGap)
  );
  const topAbove = anchorRect.top - pickerRect.height - 6;
  const top = topAbove >= pageGap
    ? topAbove
    : Math.min(window.innerHeight - pickerRect.height - pageGap, anchorRect.bottom + 6);
  forumReactionPickerPortal.style.left = `${Math.round(left)}px`;
  forumReactionPickerPortal.style.top = `${Math.round(Math.max(pageGap, top))}px`;
}

function openForumReactionPicker(post, container, anchor) {
  ensureForumReactionPickerPortal();
  forumReactionPickerPortal.classList.remove("is-reaction-overflow");
  forumReactionPickerPortal.innerHTML = "";
  FORUM_REACTION_EMOJIS.forEach((emoji) => {
    const emojiButton = document.createElement("button");
    emojiButton.type = "button";
    emojiButton.textContent = emoji;
    emojiButton.title = `添加 ${emoji} 反应`;
    emojiButton.setAttribute("aria-label", `添加 ${emoji} 反应`);
    emojiButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeForumReactionPickers();
      toggleForumReaction(post, emoji, container, emojiButton);
    });
    forumReactionPickerPortal.appendChild(emojiButton);
  });
  forumReactionPickerPortal.classList.remove("is-hidden");
  forumReactionPickerPortal.dataset.anchorKey = `add:${post.id}`;
  positionForumReactionPicker(anchor);
}

async function toggleForumReaction(post, emoji, container, control) {
  if (!FORUM_REACTION_EMOJIS.includes(emoji)) return;
  if (control) control.disabled = true;
  try {
    const response = await apiFetch("/api/forum/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId: post.id, emoji })
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "表情反应失败");
    post.reactions = Array.isArray(data.reactions) ? data.reactions : [];
    renderForumReactionControls(post, container);
  } catch (error) {
    showMessage(error.message || "表情反应失败", "error");
    if (control && control.isConnected) control.disabled = false;
  }
}

function renderForumReactionControls(post, container) {
  container.innerHTML = "";
  const emojiOrder = new Map(FORUM_REACTION_EMOJIS.map((emoji, index) => [emoji, index]));
  const reactions = (Array.isArray(post.reactions) ? post.reactions : [])
    .filter((reaction) => FORUM_REACTION_EMOJIS.includes(reaction.emoji) && Number(reaction.count) > 0)
    .sort((left, right) =>
      Number(right.count) - Number(left.count)
      || emojiOrder.get(left.emoji) - emojiOrder.get(right.emoji)
    );
  const chipsWrap = document.createElement("span");
  chipsWrap.className = "forum-reaction-chips";
  for (const reaction of reactions) {
    const emoji = reaction.emoji;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `forum-reaction-chip${reaction.reacted ? " is-active" : ""}`;
    chip.textContent = `${emoji} ${reaction.count}`;
    chip.title = reaction.reacted ? `取消 ${emoji} 反应` : `添加 ${emoji} 反应`;
    chip.setAttribute("aria-pressed", String(Boolean(reaction.reacted)));
    chip.disabled = !can("forum.write");
    chip.addEventListener("pointerdown", (event) => event.stopPropagation());
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleForumReaction(post, emoji, container, chip);
    });
    chipsWrap.appendChild(chip);
  }

  const addWrap = document.createElement("span");
  addWrap.className = "forum-reaction-add";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "forum-reaction-add-button";
  addButton.textContent = "☺";
  addButton.title = "添加表情反应";
  addButton.setAttribute("aria-label", "添加表情反应");
  addButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  addButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const anchorKey = `add:${post.id}`;
    const isSameAnchor = forumReactionPickerPortal?.dataset.anchorKey === anchorKey
      && !forumReactionPickerPortal.classList.contains("is-hidden");
    closeForumReactionPickers();
    if (!isSameAnchor) openForumReactionPicker(post, container, addButton);
  });
  addWrap.appendChild(addButton);
  if (can("forum.write")) container.append(addWrap, chipsWrap);
  else container.append(chipsWrap);
}

function renderForumPosts() {
  if (!forumPostList) return;
  const preservedOpenPosts = new Map(
    [...forumPostList.querySelectorAll("details[open][data-post-id]")].map((details) => {
      const replyForm = details.querySelector(".forum-reply-form");
      const replies = details.querySelector(".forum-replies");
      return [
        Number(details.dataset.postId),
        {
          draft: replyForm?.querySelector("input")?.value || "",
          loadedCount: replies?.dataset.loaded === "1"
            ? Math.max(0, Number(replies.dataset.loadedCount) || 0)
            : 0,
          replyTarget: replyForm?.dataset.parentReplyId
            ? {
                id: Number(replyForm.dataset.parentReplyId),
                floorNumber: Number(replyForm.dataset.replyToFloor),
                author: replyForm.dataset.replyToAuthor || "匿名"
              }
            : null
        }
      ];
    })
  );
  forumPostList.innerHTML = "";
  if (forumPostCount) forumPostCount.textContent = `${state.forumPosts.length} 帖`;
  if (!state.forumPosts.length) {
    forumPostList.innerHTML = '<div class="workspace-empty">小论坛还是空的<br />发布第一条动态吧。</div>';
    updateForumManagementUi();
    return;
  }

  const fragment = document.createDocumentFragment();
  state.forumPosts.forEach((post, index) => {
    const details = document.createElement("details");
    details.className = "forum-post";
    if (index === 0) details.classList.add("is-latest");
    if (post.canDelete) details.classList.add("can-delete");
    details.dataset.postId = String(post.id);

    const summary = document.createElement("summary");
    const replyIndicator = document.createElement("span");
    replyIndicator.className = "forum-post-reply-indicator";
    replyIndicator.hidden = !hasUnreadForumReplies(post);
    replyIndicator.title = `${post.replyCount || 0} 条回复`;
    summary.appendChild(replyIndicator);
    if (post.canDelete) {
      const selectInput = document.createElement("button");
      selectInput.type = "button";
      selectInput.className = "forum-post-select";
      selectInput.dataset.postId = String(post.id);
      selectInput.classList.toggle("is-checked", state.forumSelectedPostIds.has(post.id));
      selectInput.setAttribute("role", "checkbox");
      selectInput.setAttribute("aria-checked", String(state.forumSelectedPostIds.has(post.id)));
      selectInput.setAttribute("aria-label", `选择动态：${post.title}`);
      selectInput.addEventListener("pointerdown", (event) => event.stopPropagation());
      selectInput.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.forumSelectedPostIds.has(post.id)) {
          state.forumSelectedPostIds.delete(post.id);
        } else {
          state.forumSelectedPostIds.add(post.id);
        }
        updateForumManagementUi();
      });
      summary.appendChild(selectInput);
    }
    const summaryMain = document.createElement("span");
    summaryMain.className = "forum-post-summary-main";
    const title = document.createElement("span");
    title.className = "forum-post-title";
    title.textContent = post.title;
    const meta = document.createElement("span");
    meta.className = "forum-post-meta";
    const author = document.createElement("span");
    author.textContent = post.author;
    const time = document.createElement("span");
    time.textContent = formatWorkspaceTime(post.createdAt);
    const replyCount = document.createElement("span");
    replyCount.className = "forum-post-reply-count";
    replyCount.textContent = `${post.replyCount || 0} 回复`;
    meta.append(author, time, replyCount);
    summaryMain.append(title, meta);
    summary.appendChild(summaryMain);
    const reactionControls = document.createElement("span");
    reactionControls.className = "forum-post-reactions";
    renderForumReactionControls(post, reactionControls);
    summary.appendChild(reactionControls);
    if (post.canDelete) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "forum-post-remove";
      removeButton.textContent = "删除";
      removeButton.title = "删除动态";
      removeButton.setAttribute("aria-label", `删除动态：${post.title}`);
      removeButton.addEventListener("pointerdown", (event) => event.stopPropagation());
      removeButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeButton.disabled = true;
        await confirmAndDeleteForumPosts([post]);
        if (removeButton.isConnected) removeButton.disabled = false;
      });
      summary.appendChild(removeButton);
    }
    const expandButton = document.createElement("button");
    expandButton.type = "button";
    expandButton.className = "forum-post-expand";
    expandButton.textContent = "展开";
    expandButton.setAttribute("aria-label", `展开动态：${post.title}`);
    expandButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    expandButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      details.open = !details.open;
    });
    summary.appendChild(expandButton);

    const body = document.createElement("div");
    body.className = "forum-post-body";
    const bodyLabel = document.createElement("div");
    bodyLabel.className = "forum-post-body-label";
    bodyLabel.textContent = "1F · 楼主";
    const content = document.createElement("p");
    content.className = "forum-post-content";
    content.textContent = post.content;
    const replies = document.createElement("div");
    replies.className = "forum-replies";

    const replyForm = document.createElement("form");
    replyForm.className = "forum-reply-form";
    replyForm.classList.toggle("is-hidden", !can("forum.write"));
    const replyInput = document.createElement("input");
    replyInput.type = "text";
    replyInput.maxLength = 500;
    replyInput.placeholder = "回复这条动态…";
    replyInput.setAttribute("aria-label", `回复：${post.title}`);
    const replyTargetBar = document.createElement("div");
    replyTargetBar.className = "forum-reply-target is-hidden";
    const replyTargetLabel = document.createElement("span");
    const clearReplyTargetButton = document.createElement("button");
    clearReplyTargetButton.type = "button";
    clearReplyTargetButton.textContent = "取消";
    clearReplyTargetButton.setAttribute("aria-label", "取消楼层回复");
    replyTargetBar.append(replyTargetLabel, clearReplyTargetButton);
    const replyButton = document.createElement("button");
    replyButton.type = "submit";
    replyButton.className = "workspace-text-button";
    replyButton.textContent = "回复";
    const setReplyTarget = (target, { focus = true } = {}) => {
      if (!target || !Number.isInteger(Number(target.id)) || Number(target.id) <= 0) {
        delete replyForm.dataset.parentReplyId;
        delete replyForm.dataset.replyToFloor;
        delete replyForm.dataset.replyToAuthor;
        replyTargetBar.classList.add("is-hidden");
        replyTargetLabel.textContent = "";
        replyInput.placeholder = "回复这条动态…";
        return;
      }
      replyForm.dataset.parentReplyId = String(target.id);
      replyForm.dataset.replyToFloor = String(target.floorNumber);
      replyForm.dataset.replyToAuthor = String(target.author || "匿名");
      replyTargetLabel.textContent = `回复 ${target.floorNumber}F · @${target.author || "匿名"}`;
      replyTargetBar.classList.remove("is-hidden");
      replyInput.placeholder = `回复 ${target.floorNumber}F…`;
      if (focus) replyInput.focus();
    };
    replyForm._setReplyTarget = setReplyTarget;
    clearReplyTargetButton.addEventListener("click", () => {
      setReplyTarget(null);
      replyInput.focus();
    });
    replies.addEventListener("forum-reply-target", (event) => setReplyTarget(event.detail));
    replyForm.append(replyTargetBar, replyInput, replyButton);
    replyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const replyText = replyInput.value.trim();
      if (!replyText) return;
      const loadedCountBeforeReply = Math.max(0, Number(replies.dataset.loadedCount) || 0);
      const totalBeforeReply = Math.max(0, Number(replies.dataset.total) || 0);
      const wasFullyLoaded = replies.dataset.loaded === "1"
        && loadedCountBeforeReply >= totalBeforeReply;
      const parentReplyId = Number(replyForm.dataset.parentReplyId) || null;
      replyButton.disabled = true;
      try {
        const response = await apiFetch("/api/forum/replies", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Device-Name": encodeURIComponent(state.nickname || "匿名") },
          body: JSON.stringify({ postId: post.id, parentReplyId, content: replyText })
        });
        const data = await parseJsonResponse(response);
        if (!response.ok) throw new Error(data.error || "回复失败");
        replyInput.value = "";
        post.replyCount = Number(post.replyCount || 0) + 1;
        const reloadLimit = wasFullyLoaded
          ? Math.max(4, loadedCountBeforeReply + 1)
          : Math.max(4, loadedCountBeforeReply);
        await loadForumReplies(post.id, replies, { limit: reloadLimit });
        replyCount.textContent = `${post.replyCount} 回复`;
        setReplyTarget(null);
        markForumPostRepliesRead(post);
        replyIndicator.hidden = true;
        replyIndicator.title = `${post.replyCount} 条回复`;
      } catch (error) {
        showMessage(error.message || "回复失败", "error");
      } finally {
        replyButton.disabled = false;
      }
    });

    body.append(bodyLabel, content);
    body.append(replies, replyForm);
    details.append(summary, body);
    details.addEventListener("toggle", () => {
      expandButton.textContent = details.open ? "收起" : "展开";
      expandButton.setAttribute("aria-label", `${details.open ? "收起" : "展开"}动态：${post.title}`);
      if (details.open) {
        markForumPostRepliesRead(post);
        replyIndicator.hidden = true;
      }
      if (details.open && replies.dataset.loaded !== "1") {
        loadForumReplies(post.id, replies);
      }
    });
    fragment.appendChild(details);
  });
  forumPostList.appendChild(fragment);
  for (const [postId, preserved] of preservedOpenPosts) {
    const details = forumPostList.querySelector(`details[data-post-id="${postId}"]`);
    if (!details) continue;
    const replies = details.querySelector(".forum-replies");
    if (replies && preserved.loadedCount > 0) replies.dataset.loaded = "1";
    details.open = true;
    const replyInput = details.querySelector(".forum-reply-form input");
    if (replyInput) replyInput.value = preserved.draft;
    const replyForm = details.querySelector(".forum-reply-form");
    if (preserved.replyTarget && replyForm?._setReplyTarget) {
      replyForm._setReplyTarget(preserved.replyTarget, { focus: false });
    }
    if (replies && preserved.loadedCount > 0) {
      loadForumReplies(postId, replies, { limit: Math.max(4, preserved.loadedCount) });
    }
  }
  updateForumManagementUi();
}

document.addEventListener("click", () => closeForumReactionPickers());
window.addEventListener("resize", () => closeForumReactionPickers());
window.addEventListener("scroll", () => closeForumReactionPickers(), true);

function updateForumPostsLive(previousReplyCounts) {
  if (forumPostCount) forumPostCount.textContent = `${state.forumPosts.length} 帖`;
  state.forumPosts.forEach((post) => {
    const details = forumPostList.querySelector(`details[data-post-id="${post.id}"]`);
    if (!details) return;
    const replyCount = Number(post.replyCount || 0);
    const replyIndicator = details.querySelector(".forum-post-reply-indicator");
    if (replyIndicator) {
      replyIndicator.hidden = !hasUnreadForumReplies(post);
      replyIndicator.title = `${replyCount} 条回复`;
    }
    const replyCountLabel = details.querySelector(".forum-post-reply-count");
    if (replyCountLabel) replyCountLabel.textContent = `${replyCount} 回复`;
    const reactionControls = details.querySelector(".forum-post-reactions");
    if (reactionControls) renderForumReactionControls(post, reactionControls);

    if (!details.open || previousReplyCounts.get(post.id) === replyCount) return;
    const replies = details.querySelector(".forum-replies");
    if (!replies || replies.dataset.loaded !== "1") return;
    const loadedCount = Number(replies.dataset.loadedCount || 0);
    const previousTotal = Number(replies.dataset.total || 0);
    const wasFullyLoaded = loadedCount >= previousTotal;
    const limit = wasFullyLoaded ? Math.max(4, replyCount) : Math.max(4, loadedCount);
    loadForumReplies(post.id, replies, { limit });
  });
}

async function loadForumPosts({ background = false } = {}) {
  if (!forumPostList) return;
  try {
    const response = await fetch("/api/forum/posts?limit=16", {
      cache: "no-store",
      headers: { "X-Device-Name": encodeURIComponent(state.nickname || "匿名") }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取动态失败");
    const incomingPosts = Array.isArray(data.posts) ? data.posts : [];
    const previousReplyCounts = new Map(
      state.forumPosts.map((post) => [post.id, Number(post.replyCount || 0)])
    );
    const previousById = new Map(state.forumPosts.map((post) => [post.id, post]));
    const sameStructure = incomingPosts.length === state.forumPosts.length
      && incomingPosts.every((post, index) =>
        post.id === state.forumPosts[index]?.id
        && Boolean(post.canDelete) === Boolean(state.forumPosts[index]?.canDelete)
      );
    state.forumPosts = incomingPosts.map((post) => {
      const existingPost = previousById.get(post.id);
      if (!existingPost) return post;
      Object.assign(existingPost, post);
      return existingPost;
    });
    if (background && sameStructure) {
      updateForumPostsLive(previousReplyCounts);
    } else {
      renderForumPosts();
    }
  } catch (error) {
    if (background) return;
    forumPostList.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "workspace-empty";
    empty.textContent = error.message || "动态读取失败";
    forumPostList.appendChild(empty);
  }
}

if (forumManageToggle) {
  forumManageToggle.addEventListener("click", () => {
    state.forumManageMode = !state.forumManageMode;
    if (!state.forumManageMode) state.forumSelectedPostIds.clear();
    updateForumManagementUi();
  });
}

if (forumBatchCancel) {
  forumBatchCancel.addEventListener("click", () => {
    state.forumManageMode = false;
    state.forumSelectedPostIds.clear();
    updateForumManagementUi();
  });
}

if (forumSelectAllToggle) {
  forumSelectAllToggle.addEventListener("click", () => {
    const deletableIds = state.forumPosts.filter((post) => post.canDelete).map((post) => post.id);
    const allSelected = deletableIds.length > 0
      && deletableIds.every((postId) => state.forumSelectedPostIds.has(postId));
    deletableIds.forEach((postId) => {
      if (allSelected) {
        state.forumSelectedPostIds.delete(postId);
      } else {
        state.forumSelectedPostIds.add(postId);
      }
    });
    updateForumManagementUi();
  });
}

if (forumBatchDelete) {
  forumBatchDelete.addEventListener("click", async () => {
    await confirmAndDeleteForumPosts(getSelectedForumPosts(), true);
  });
}

if (forumComposeToggle && forumComposeForm) {
  forumComposeToggle.addEventListener("click", () => {
    if (!can("forum.write")) return;
    const opening = forumComposeForm.classList.contains("is-hidden");
    forumComposeForm.classList.toggle("is-hidden", !opening);
    forumComposeToggle.setAttribute("aria-expanded", String(opening));
    forumComposeToggle.textContent = opening ? "收起" : "发布";
    forumComposeMessage.textContent = "";
    forumComposeMessage.classList.remove("is-error");
    if (opening) forumPostTitle.focus();
  });

  forumComposeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!can("forum.write")) return;
    const title = forumPostTitle.value.trim();
    const content = forumPostContent.value.trim();
    if (!title || !content) return;
    const submitButton = forumComposeForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    forumComposeMessage.textContent = "正在发布…";
    forumComposeMessage.classList.remove("is-error");
    try {
      const response = await apiFetch("/api/forum/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Name": encodeURIComponent(state.nickname || "匿名") },
        body: JSON.stringify({ title, content })
      });
      const data = await parseJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "发布失败");
      forumComposeForm.reset();
      forumComposeForm.classList.add("is-hidden");
      forumComposeToggle.setAttribute("aria-expanded", "false");
      forumComposeToggle.textContent = "发布";
      forumComposeMessage.textContent = "";
      await loadForumPosts();
    } catch (error) {
      forumComposeMessage.textContent = error.message || "发布失败";
      forumComposeMessage.classList.add("is-error");
    } finally {
      submitButton.disabled = false;
    }
  });
}

accountReady.then((user) => {
  if (!user) return;
  renderWorkspaceOverview();
  loadWorkspaceStatus();
  loadForumPosts();
});
setInterval(() => {
  if (document.visibilityState === "visible") loadWorkspaceStatus();
}, 3000);
setInterval(() => {
  if (document.visibilityState === "visible") loadInProgressProjects();
}, 10000);
window.addEventListener("focus", () => {
  loadWorkspaceStatus();
  loadInProgressProjects();
});
setInterval(() => {
  if (!forumPostList || document.visibilityState !== "visible") return;
  if (state.forumManageMode) return;
  if (forumReactionPickerPortal && !forumReactionPickerPortal.classList.contains("is-hidden")) return;
  loadForumPosts({ background: true });
}, 3000);

// --- Floating characters (per-character bounce) + cursor particles + click burst ---

let floatChars = [];
let floatAnimId = null;
let cursorParticleCanvas = null;
let cursorCtx = null;
let cursorParticles = [];
let cursorAnimId = null;
let _cursorResize = null, _cursorMouseMove = null, _cursorClick = null;
let collisionParticles = [];
let dragChar = null;
let _floatMouseDown = null, _floatMouseUp = null, _floatDragStart = null, _floatSelectStart = null;

function startFloatingChars() {
  stopFloatingChars();
  if (!state.glowColor || !state.nickname) return;

  const chars = [...state.nickname];
  const fontSize = state.floatSize;
  const elW = fontSize * 1.1;
  const elH = fontSize * 1.3;

  const firstColor = state.glowColor.split(",")[0] || state.glowColor || "#7c6cf0";
  floatChars = chars.map((ch, i) => {
    const el = document.createElement("div");
    el.className = "float-char";
    el.textContent = ch;
    el.style.cssText = `
      position: fixed; z-index: 0; pointer-events: none; user-select: none;
      font-size: ${fontSize}px; font-weight: 900; line-height: ${fontSize}px;
      width: ${elW}px; height: ${elH}px; display: flex; align-items: center; justify-content: center;
      color: ${firstColor}; opacity: 0.15;
      text-shadow: 0 0 15px ${firstColor}40, 0 0 40px ${firstColor}20;
      transition: opacity 0.5s;
    `;
    document.body.prepend(el);
    const mw = window.innerWidth, mh = window.innerHeight;
    return {
      el,
      x: Math.random() * (mw - elW * 2) + elW,
      y: Math.random() * (mh - elH * 2) + elH,
      vx: (Math.random() - 0.5) * 1.5 * state.floatSpeed,
      vy: (Math.random() - 0.5) * 1.5 * state.floatSpeed,
      w: elW, h: elH,
      r: fontSize * 0.4
    };
  });

  // Mouse interaction for floating chars
  const floatMouse = { x: -9999, y: -9999, lastMove: 0, idle: false };
  const floatAttractDist = 200;
  dragChar = null;
  let dragOffsetX = 0, dragOffsetY = 0;
  let dragLastX = 0, dragLastY = 0;
  let dragReleaseVx = 0, dragReleaseVy = 0;

  _floatMouseMove = (e) => {
    floatMouse.x = e.clientX;
    floatMouse.y = e.clientY;
    floatMouse.lastMove = performance.now();
    floatMouse.idle = false;
    // Drag: move grabbed char
    if (dragChar) {
      dragChar.x = e.clientX - dragOffsetX;
      dragChar.y = e.clientY - dragOffsetY;
      dragChar.vx = e.clientX - dragLastX;
      dragChar.vy = e.clientY - dragLastY;
      dragLastX = e.clientX;
      dragLastY = e.clientY;
    }
  };
  _floatMouseLeave = () => {
    floatMouse.x = -9999;
    floatMouse.y = -9999;
    floatMouse.idle = false;
    if (dragChar) { dragChar = null; }
  };
  document.addEventListener("mousemove", _floatMouseMove);
  document.addEventListener("mouseleave", _floatMouseLeave);

  // Drag start (mousedown near a char)
  _floatMouseDown = (e) => {
    if (!state.glowColor) return;
    let closest = null, minDist = 40;
    for (const c of floatChars) {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      const d = Math.hypot(cx - e.clientX, cy - e.clientY);
      if (d < minDist) { minDist = d; closest = c; }
    }
    if (closest) {
      e.preventDefault();
      _draggingChar = true;
      dragChar = closest;
      dragOffsetX = e.clientX - closest.x;
      dragOffsetY = e.clientY - closest.y;
      dragLastX = e.clientX;
      dragLastY = e.clientY;
      dragReleaseVx = 0;
      dragReleaseVy = 0;
      closest.el.style.opacity = "0.35";
      closest.el.style.transition = "opacity 0.2s";
    }
  };
  document.addEventListener("mousedown", _floatMouseDown);
  _floatMouseUp = (e) => {
    if (dragChar) {
      dragChar.vx = dragChar.vx || 0;
      dragChar.vy = dragChar.vy || 0;
      dragChar.el.style.opacity = "0.15";
      dragChar = null;
    }
    _draggingChar = false;
  };
  document.addEventListener("mouseup", _floatMouseUp);

  // Click ripple
  const floatRipples = [];
  _floatClick = (e) => {
    if (!state.glowColor) return;
    floatRipples.push({ x: e.clientX, y: e.clientY, r: 0, life: 1 });
    for (const c of floatChars) {
      const dx = (c.x + c.w / 2) - e.clientX;
      const dy = (c.y + c.h / 2) - e.clientY;
      if (Math.hypot(dx, dy) < 300) {
        c.el.style.opacity = "0.5";
        c.el.style.transition = "opacity 0.3s";
        setTimeout(() => { if (c.el && c !== dragChar) c.el.style.opacity = "0.15"; }, 200);
      }
    }
  };
  document.addEventListener("click", _floatClick);
  // Prevent text selection during drag
  _floatDragStart = (e) => { if (dragChar) e.preventDefault(); };
  document.addEventListener("dragstart", _floatDragStart);
  _floatSelectStart = (e) => { if (dragChar) e.preventDefault(); };
  document.addEventListener("selectstart", _floatSelectStart);

  function animate() {
    const now = performance.now();
    const mw = window.innerWidth, mh = window.innerHeight;

    // Idle detection
    if (now - floatMouse.lastMove > 600 && floatMouse.x > -5000) {
      floatMouse.idle = true;
    }

    for (const c of floatChars) {
      if (c !== dragChar) {
        const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
        const mdx = cx - floatMouse.x;
        const mdy = cy - floatMouse.y;
        const mDist = Math.hypot(mdx, mdy);

        // Mouse attract (停留时吸引)
        if (mDist < floatAttractDist && mDist > 5 && floatMouse.idle && !dragChar) {
          const force = 0.015 * state.floatSpeed * 0.3;
          c.vx += (-mdx / mDist) * force;
          c.vy += (-mdy / mDist) * force;
        }

        c.x += c.vx;
        c.y += c.vy;

        // Damping
        c.vx *= 0.997;
        c.vy *= 0.997;

        // Wall bounce — normal collision
        if (c.x + c.w > mw) { c.x = mw - c.w; c.vx = -c.vx; }
        if (c.x < 0) { c.x = 0; c.vx = -c.vx; }
        if (c.y + c.h > mh) { c.y = mh - c.h; c.vy = -c.vy; }
        if (c.y < 0) { c.y = 0; c.vy = -c.vy; }

        // Life decay for temp event chars
        if (c.maxLife) {
          c.life -= 1 / 60 / c.maxLife;
          if (c.life <= 0) { c.life = 0; c.el.style.opacity = "0"; c.dead = true; }
        }
      }

      c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
    }
    // Remove dead chars
    for (let i = floatChars.length - 1; i >= 0; i--) {
      if (floatChars[i].dead) { floatChars[i].el.remove(); floatChars.splice(i, 1); }
    }

    // Click ripples (点击波纹)
    for (let i = floatRipples.length - 1; i >= 0; i--) {
      const ri = floatRipples[i];
      ri.r += 4;
      ri.life -= 0.025;
      if (ri.life <= 0) { floatRipples.splice(i, 1); continue; }
      // Draw ripple on cursor canvas if available
      const rCanvas = document.querySelector("#cursorParticleCanvas");
      if (rCanvas) {
        const ctx = rCanvas.getContext("2d");
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = state.glowColor || "#7c6cf0";
        ctx.globalAlpha = ri.life * 0.2;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ri.x, ri.y, ri.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // Character-character collision
    for (let i = 0; i < floatChars.length; i++) {
      for (let j = i + 1; j < floatChars.length; j++) {
        const a = floatChars[i], b = floatChars[j];
        const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
        const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.r + b.r;
        if (dist < minDist && dist > 0) {
          const overlap = (minDist - dist) / 2;
          const nx = dx / dist, ny = dy / dist;
          a.x += nx * overlap; a.y += ny * overlap;
          b.x -= nx * overlap; b.y -= ny * overlap;
          const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
          const dvn = dvx * nx + dvy * ny;
          if (dvn < 0) {
            a.vx -= dvn * nx * 0.8;
            a.vy -= dvn * ny * 0.8;
            b.vx += dvn * nx * 0.8;
            b.vy += dvn * ny * 0.8;
            // Collision spark: particles + flash
            if (!a.isEvent && !b.isEvent) {
              const force = Math.abs(dvn);
              if (force > 0.5) {
                const cx = (a.x + a.w/2 + b.x + b.w/2) / 2;
                const cy = (a.y + a.h/2 + b.y + b.h/2) / 2;
                const col = state.glowColor || "#7c6cf0";
                const now = new Date();
                const ts = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,"0")}/${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
                const tsEl = document.createElement("div");
                tsEl.textContent = ts;
                tsEl.style.cssText = `
                  position:fixed;z-index:0;pointer-events:none;user-select:none;
                  font-size:11px;font-weight:600;white-space:nowrap;
                  color:${col};opacity:0.6;
                `;
                tsEl.style.left = cx + "px";
                tsEl.style.top = cy + "px";
                document.body.appendChild(tsEl);
                if (collisionParticles.length < 3) {
                  collisionParticles.push({ el: tsEl, y: cy, opacity: 0.6 });
                } else {
                  tsEl.remove();
                }
                a.el.style.transform = `translate(${a.x}px, ${a.y}px) scale(1.15)`;
                b.el.style.transform = `translate(${b.x}px, ${b.y}px) scale(1.15)`;
                a.el.style.opacity = "0.35";
                b.el.style.opacity = "0.35";
                setTimeout(() => {
                  if (a.el && !a.dead) { a.el.style.transform = `translate(${a.x}px, ${a.y}px)`; a.el.style.opacity = "0.15"; }
                  if (b.el && !b.dead) { b.el.style.transform = `translate(${b.x}px, ${b.y}px)`; b.el.style.opacity = "0.15"; }
                }, 120);
              }
            }
          }
        }
      }
    }

    // Collision timestamp labels
    for (let i = collisionParticles.length - 1; i >= 0; i--) {
      const cp = collisionParticles[i];
      cp.y -= 0.3;
      cp.opacity -= 0.005;
      cp.el.style.top = cp.y + "px";
      cp.el.style.opacity = Math.max(0, cp.opacity);
      if (cp.opacity <= 0) { cp.el.remove(); collisionParticles.splice(i, 1); }
    }

    floatAnimId = requestAnimationFrame(animate);
  }
  animate();
  // Random velocity kick every 30s
  const _kickTimer = setInterval(() => {
    const spd = 1.5 * state.floatSpeed;
    for (const c of floatChars) {
      if (c === dragChar) continue;
      const ang = Math.random() * Math.PI * 2;
      c.vx = Math.cos(ang) * spd;
      c.vy = Math.sin(ang) * spd;
    }
  }, 30000);
  startFloatingChars._kickTimer = _kickTimer;
}

let _floatMouseMove = null, _floatMouseLeave = null, _floatClick = null;
let _draggingChar = false;

function stopFloatingChars() {
  dragChar = null; _draggingChar = false;
  if (startFloatingChars._kickTimer) { clearInterval(startFloatingChars._kickTimer); startFloatingChars._kickTimer = null; }
  if (floatAnimId) { cancelAnimationFrame(floatAnimId); floatAnimId = null; }
  if (_floatMouseMove) { document.removeEventListener("mousemove", _floatMouseMove); _floatMouseMove = null; }
  if (_floatMouseLeave) { document.removeEventListener("mouseleave", _floatMouseLeave); _floatMouseLeave = null; }
  if (_floatClick) { document.removeEventListener("click", _floatClick); _floatClick = null; }
  if (_floatMouseDown) { document.removeEventListener("mousedown", _floatMouseDown); _floatMouseDown = null; }
  if (_floatMouseUp) { document.removeEventListener("mouseup", _floatMouseUp); _floatMouseUp = null; }
  if (_floatDragStart) { document.removeEventListener("dragstart", _floatDragStart); _floatDragStart = null; }
  if (_floatSelectStart) { document.removeEventListener("selectstart", _floatSelectStart); _floatSelectStart = null; }
  for (const c of floatChars) c.el.remove();
  floatChars = [];
  for (const cp of collisionParticles) cp.el.remove();
  collisionParticles = [];
}

function complementColor(hex) {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0,2), 16), g = parseInt(c.slice(2,4), 16), b = parseInt(c.slice(4,6), 16);
  return `#${(255-r).toString(16).padStart(2,"0")}${(255-g).toString(16).padStart(2,"0")}${(255-b).toString(16).padStart(2,"0")}`;
}

function clearEventChars() {
  for (let i = floatChars.length - 1; i >= 0; i--) {
    if (floatChars[i].isEvent) { floatChars[i].el.remove(); floatChars.splice(i, 1); }
  }
}

function spawnFileEventChars(names, action) {
  if (!state.glowColor || !names.length) return;
  clearEventChars();
  const fontSize = Math.min(state.floatSize * 0.55, 50);
  const compColor = complementColor(state.glowColor);
  const mw = window.innerWidth;
  const actionLabel = action === "上传" ? "成功上传" : action === "删除" ? "成功删除" : action || "";
  const newChars = names.map((name) => {
    const text = `${actionLabel} ${name}`;
    const el = document.createElement("div");
    el.className = "float-char float-char-event";
    el.textContent = text;
    el.style.cssText = `
      position: fixed; z-index: 0; pointer-events: none; user-select: none;
      font-size: ${fontSize}px; font-weight: 700; line-height: 1.3;
      white-space: nowrap; color: ${compColor}; opacity: 0;
    `;
    document.body.prepend(el);
    const w = text.length * fontSize * 0.55;
    const h = fontSize * 1.4;
    return {
      el,
      x: Math.random() * (mw - w * 1.5),
      y: Math.random() * (window.innerHeight - h * 1.5),
      vx: (Math.random() - 0.5) * 1.0 * state.floatSpeed,
      vy: (Math.random() - 0.5) * 1.0 * state.floatSpeed,
      w, h, r: fontSize * 0.35,
      life: 1, maxLife: 6 + Math.random() * 3, isEvent: true
    };
  });
  floatChars.push(...newChars);
  requestAnimationFrame(() => newChars.forEach(c => c.el.style.opacity = "0.15"));
  setTimeout(() => newChars.forEach(c => { c.dead = true; }), 8000);
}

function startCursorParticles() {
  if (cursorParticleCanvas) return;
  cursorParticleCanvas = document.createElement("canvas");
  cursorParticleCanvas.id = "cursorParticleCanvas";
  cursorParticleCanvas.style.cssText = "position:fixed;inset:0;z-index:9998;pointer-events:none";
  document.body.appendChild(cursorParticleCanvas);
  cursorCtx = cursorParticleCanvas.getContext("2d");

  let w = cursorParticleCanvas.width = window.innerWidth;
  let h = cursorParticleCanvas.height = window.innerHeight;
  let lastX = 0, lastY = 0;
  const trail = [], mode = state.cursorEffect || "";

  _cursorResize = () => {
    w = cursorParticleCanvas.width = window.innerWidth;
    h = cursorParticleCanvas.height = window.innerHeight;
  };
  window.addEventListener("resize", _cursorResize);

  _cursorMouseMove = (e) => {
    if (!state.glowColor) return;

    if (mode === "classic") {
      if (Math.random() < 0.2) {
        cursorParticles.push({
          x: e.clientX + (Math.random() - 0.5) * 6, y: e.clientY,
          vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6 - 0.3,
          r: 1.2 + Math.random() * 2, life: 0.6,
          decay: 0.015 + Math.random() * 0.01,
          color: state.glowColor
        });
      }
      return;
    }

    if (mode === "ribbon") {
      trail.push({ x: e.clientX, y: e.clientY, life: 1 });
      if (trail.length > 60) trail.shift();
      return;
    }

    if (mode === "spark") {
      if (Math.random() < 0.3) {
        cursorParticles.push({
          x: e.clientX, y: e.clientY, vx: 0, vy: 0,
          r: 12, life: 0.7,
          decay: 0.01 + Math.random() * 0.006,
          color: state.glowColor, ripple: true
        });
      }
      return;
    }

    if (mode === "comet") {
      trail.push({ x: e.clientX, y: e.clientY, life: 1 });
      if (trail.length > 40) trail.shift();
      return;
    }

    if (mode === "stain") {
      if (Math.random() < 0.08) {
        cursorParticles.push({
          x: e.clientX + (Math.random() - 0.5) * 20, y: e.clientY + (Math.random() - 0.5) * 20,
          vx: 0, vy: 0,
          r: 3 + Math.random() * 6, life: 0.7,
          decay: 0.004 + Math.random() * 0.003,
          color: state.glowColor, bloom: true
        });
      }
      return;
    }
  };
  document.addEventListener("mousemove", _cursorMouseMove);

  _cursorClick = (e) => {
    if (!state.glowColor) return;
    const c = state.glowColor;

    if (mode === "classic") {
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 8, life: 0.9, decay: 0.028, ripple: true, color: c });
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 8, life: 0.6, decay: 0.04, ripple: true, color: c });
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 8, life: 0.35, decay: 0.06, ripple: true, color: c });
      return;
    }
    if (mode === "ribbon") {
      for (let i = 0; i < 3; i++) {
        cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 8 + i * 15, life: 0.7, decay: 0.035, ring: true, color: c });
      }
      return;
    }
    if (mode === "spark") {
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 20, life: 0.85, decay: 0.016, ripple: true, color: c });
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 20, life: 0.55, decay: 0.028, ripple: true, color: c });
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 12, life: 0.4, decay: 0.035, ripple: true, color: c });
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 12, life: 0.25, decay: 0.05, ripple: true, color: c });
      return;
    }
    if (mode === "comet") {
      for (let i = 0; i < 20; i++) {
        const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 6;
        cursorParticles.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 0.4 + Math.random() * 1.0, life: 0.7, decay: 0.04 + Math.random() * 0.03, color: c });
      }
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI / 4) + (Math.PI / 2) * i;
        cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 16, life: 0.5, decay: 0.06, stroke: true, color: c, angle: a });
      }
      return;
    }
    if (mode === "stain") {
      for (let i = 0; i < 9; i++) {
        cursorParticles.push({
          x: e.clientX + (Math.random() - 0.5) * 40, y: e.clientY + (Math.random() - 0.5) * 40,
          vx: 0, vy: 0, r: 3 + Math.random() * 8, life: 0.9,
          decay: 0.003 + Math.random() * 0.002, bloom: true, color: c
        });
      }
      return;
    }
  };
  document.addEventListener("click", _cursorClick);

  (function animate() {
    cursorCtx.clearRect(0, 0, w, h);
    cursorCtx.globalCompositeOperation = "source-over";

    if ((mode === "ribbon" || mode === "comet") && trail.length > 1) {
      for (let i = trail.length - 1; i >= 0; i--) {
        trail[i].life -= mode === "ribbon" ? 0.02 : 0.03;
        if (trail[i].life <= 0) { trail.splice(i, 1); continue; }
      }
      if (trail.length > 1) {
        cursorCtx.strokeStyle = state.glowColor;
        cursorCtx.lineCap = "round"; cursorCtx.lineJoin = "round";
        if (mode === "ribbon") {
          cursorCtx.globalAlpha = 0.45;
          for (let i = 1; i < trail.length; i++) {
            var t = trail[i], p = trail[i-1];
            cursorCtx.lineWidth = t.life * 5 + 1;
            cursorCtx.beginPath();
            cursorCtx.moveTo(p.x, p.y);
            cursorCtx.quadraticCurveTo(p.x, p.y, (p.x + t.x) / 2, (p.y + t.y) / 2);
            cursorCtx.stroke();
          }
        } else {
          cursorCtx.globalAlpha = 0.55;
          cursorCtx.lineCap = "butt";
          for (let i = 1; i < trail.length; i++) {
            var t = trail[i], p = trail[i-1];
            cursorCtx.lineWidth = 0.6 + t.life * 1.2;
            cursorCtx.beginPath();
            cursorCtx.moveTo(p.x, p.y);
            cursorCtx.lineTo(t.x, t.y);
            cursorCtx.stroke();
          }
        }
        cursorCtx.globalAlpha = 1;
      }
    }

    for (let i = cursorParticles.length - 1; i >= 0; i--) {
      var p = cursorParticles[i];
      p.x += p.vx; p.y += p.vy;
      if (p.bounce && p.y + p.r > h) { p.y = h - p.r; p.vy *= -0.5; p.vx *= 0.7; }
      p.life -= p.decay;
      if (p.life <= 0) { cursorParticles.splice(i, 1); continue; }
      var alpha = p.life * 0.55;

      if (p.ring) {
        cursorCtx.strokeStyle = p.color;
        cursorCtx.globalAlpha = alpha * 0.4;
        cursorCtx.lineWidth = 1.5;
        cursorCtx.beginPath();
        cursorCtx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
        cursorCtx.stroke();
      } else if (p.ripple) {
        var rr = p.r / p.life;
        cursorCtx.strokeStyle = p.color;
        cursorCtx.globalAlpha = alpha * 0.5;
        cursorCtx.lineWidth = 2.5;
        cursorCtx.beginPath();
        cursorCtx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        cursorCtx.stroke();
      } else if (p.stroke) {
        var ex = p.x + Math.cos(p.angle) * p.r * p.life;
        var ey = p.y + Math.sin(p.angle) * p.r * p.life;
        cursorCtx.strokeStyle = p.color;
        cursorCtx.globalAlpha = alpha * 0.5;
        cursorCtx.lineWidth = Math.max(1, p.life * 5);
        cursorCtx.lineCap = "round";
        cursorCtx.beginPath();
        cursorCtx.moveTo(p.x, p.y);
        cursorCtx.lineTo(ex, ey);
        cursorCtx.stroke();
      } else if (p.bloom) {
        var br = p.r / p.life;
        var grad = cursorCtx.createRadialGradient(p.x, p.y, br * 0.1, p.x, p.y, br);
        grad.addColorStop(0, p.color);
        grad.addColorStop(0.6, p.color);
        grad.addColorStop(1, "transparent");
        cursorCtx.fillStyle = grad;
        cursorCtx.globalAlpha = alpha * 0.4;
        cursorCtx.beginPath();
        cursorCtx.arc(p.x, p.y, br, 0, Math.PI * 2);
        cursorCtx.fill();
      } else {
        cursorCtx.fillStyle = p.color;
        cursorCtx.globalAlpha = alpha;
        cursorCtx.beginPath();
        cursorCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        cursorCtx.fill();
      }
    }
    cursorCtx.globalAlpha = 1;
    if (cursorParticles.length > 500) cursorParticles.splice(0, cursorParticles.length - 500);
    cursorAnimId = requestAnimationFrame(animate);
  })();
}
function stopCursorParticles() {
  if (cursorAnimId) {
    cancelAnimationFrame(cursorAnimId);
    cursorAnimId = null;
  }
  if (_cursorResize) { window.removeEventListener("resize", _cursorResize); _cursorResize = null; }
  if (_cursorMouseMove) { document.removeEventListener("mousemove", _cursorMouseMove); _cursorMouseMove = null; }
  if (_cursorClick) { document.removeEventListener("click", _cursorClick); _cursorClick = null; }
  if (cursorParticleCanvas) {
    cursorParticleCanvas.remove();
    cursorParticleCanvas = null;
    cursorCtx = null;
  }
  cursorParticles = [];
}

// Hook into updateNicknameDisplay
const origUpdate = updateNicknameDisplay;
updateNicknameDisplay = function() {
  origUpdate();
  const fc = document.querySelector("#floatControl");
  if (state.glowColor) {
    startFloatingChars();
    stopCursorParticles();
    startCursorParticles();
    const cs = document.querySelector("#cursorParticleCanvas");
    if (cs) cs.style.display = "block";
    if (fc) fc.classList.remove("is-hidden");
  } else {
    stopFloatingChars();
    stopCursorParticles();
    if (fc) fc.classList.add("is-hidden");
  }
};

// Init if glow already on
if (state.glowColor) {
  startFloatingChars();
  stopCursorParticles();
  startCursorParticles();
  const fc = document.querySelector("#floatControl");
  if (fc) fc.classList.remove("is-hidden");
}

// --- 键盘快捷键：Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+A / Delete / Escape ---

document.addEventListener("keydown", async (e) => {
  // 忽略输入框内的按键
  const tag = (e.target.tagName || "").toLowerCase()
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return

  // Ctrl+A 全选
  if (e.ctrlKey && e.key === "a") {
    e.preventDefault()
    selectAll()
    return
  }

  // Delete 删除选中
  if (e.key === "Delete") {
    if (state.selectedPaths.size > 0) {
      e.preventDefault()
      deleteSelectedItems()
    }
    return
  }

  // Escape 取消选中
  if (e.key === "Escape") {
    if (state.selectedPaths.size > 0) {
      e.preventDefault()
      clearSelections()
      renderCurrentDirectory()
      showMessage("已取消选中", "info")
    }
    return
  }

  // Ctrl+C 复制
  if (e.ctrlKey && e.key === "c") {
    const paths = [...state.selectedPaths]
    if (paths.length === 0) return
    e.preventDefault()
    state.clipboard = { items: paths, mode: "copy" }
    showMessage(`已复制 ${paths.length} 个项目到剪贴板`, "success")
    renderCurrentDirectory()
    return
  }

  // Ctrl+X 剪切
  if (e.ctrlKey && e.key === "x") {
    const paths = [...state.selectedPaths]
    if (paths.length === 0) return
    e.preventDefault()
    state.clipboard = { items: paths, mode: "cut" }
    showMessage(`已剪切 ${paths.length} 个项目到剪贴板`, "success")
    renderCurrentDirectory()
    return
  }

  // Ctrl+V 粘贴
  if (e.ctrlKey && e.key === "v") {
    if (!state.clipboard.items.length) return
    e.preventDefault()
    const { items, mode } = state.clipboard
    const targetDir = state.currentDir
    try {
      if (mode === "copy") {
        const res = await apiFetch("/api/copy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: items, targetDir })
        })
        const data = await parseJsonResponse(res)
        if (!res.ok) {
          showMessage(data.error || "粘贴失败", "error")
          return
        }
        showMessage(`已粘贴 ${data.copied} 个项目`, "success")
      } else if (mode === "cut") {
        const ok = await moveItems(items, targetDir)
        if (ok) {
          showMessage(`已粘贴 ${items.length} 个项目`, "success")
        }
      }
    } catch (err) {
      showMessage(err.message || "粘贴失败", "error")
    }
    state.clipboard = { items: [], mode: null }
    await loadDir(state.currentDir)
    return
  }

  // Ctrl+Z 撤销
  if (e.ctrlKey && e.key === "z") {
    e.preventDefault()
    await undoLastAction()
    return
  }
})


// ── 操作提示系统 ────────────────────────────────
;(function initTips() {
  var tips = [
    "Ctrl+A 一键全选，强迫症福音~",
    "Delete 删文件？别怕，回收站兜底呢",
    "Ctrl+C/V 复制粘贴，老快捷键了",
    "Ctrl+X 剪切 + Ctrl+V = 移动文件",
    "Ctrl+Z 撤销，手滑了也不怕",
    "拖文件到文件夹 = 移动，拖到面包屑 = 跳目录",
    "点表头排序，找文件快人一步",
    "双击图片/视频全屏看，左右键切换下一张",
    "新建项目一键生成影视目录，省时省力",
    "上传时有速度显示，网速一目了然",
    "右上角滑块切主题，日间夜间随心换",
    "右下角可以换背景，也可以隐藏界面只看背景"
  ]

  var tipBar = document.createElement("div")
  tipBar.className = "tips-bar"
  document.body.appendChild(tipBar)

  var tipIndex = 0
  var tipTimer = null

  function showTip() {
    tipBar.textContent = tips[tipIndex]
    tipIndex = (tipIndex + 1) % tips.length
  }

  function startRotation() {
    clearInterval(tipTimer)
    tipTimer = setInterval(showTip, 6000)
  }

  // 点击切换下一条
  tipBar.addEventListener("click", function() {
    showTip()
  })

  showTip()
  startRotation()
})()

// --- 聊天 ---
var chatPanel = document.getElementById("chatPanel")
var chatList = document.getElementById("chatList")
var chatInput = document.getElementById("chatInput")
var chatSendBtn = document.getElementById("chatSendBtn")
var chatCloseBtn = document.getElementById("chatCloseBtn")
var chatLastId = 0

// 拖动
// 恢复上次尺寸位置
var chatSaved = localStorage.getItem("lan_chat_layout")
if (chatSaved) {
  try {
    var s = JSON.parse(chatSaved)
    chatPanel.style.right = "auto"; chatPanel.style.bottom = "auto"
    chatPanel.style.left = s.l + "px"; chatPanel.style.top = s.t + "px"
    chatPanel.style.width = s.w + "px"; chatPanel.style.height = s.h + "px"
  } catch(e) {}
}

function chatSaveLayout() {
  var r = chatPanel.getBoundingClientRect()
  localStorage.setItem("lan_chat_layout", JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height }))
}

var chatHead = chatPanel ? chatPanel.querySelector(".chat-head") : null
var dragOffX = 0, dragOffY = 0, dragging = false, dragH = 0
if (chatHead) {
  chatHead.addEventListener("mousedown", function(e) {
    dragging = true
    var r = chatPanel.getBoundingClientRect()
    dragOffX = e.clientX - r.left; dragOffY = e.clientY - r.top; dragH = r.height
    chatPanel.style.transition = "none"; chatPanel.style.userSelect = "none"
    chatPanel.style.right = "auto"; chatPanel.style.bottom = "auto"
    chatPanel.style.height = dragH + "px"
  })
  document.addEventListener("mousemove", function(e) {
    if (!dragging) return
    chatPanel.style.left = (e.clientX - dragOffX) + "px"
    chatPanel.style.top = (e.clientY - dragOffY) + "px"
  })
  document.addEventListener("mouseup", function() {
    if (dragging) { dragging = false; chatPanel.style.transition = ""; chatPanel.style.userSelect = ""; chatSaveLayout() }
  })
  chatHead.style.cursor = "move"
}

var resizeHandle = null; var resizing = false, resizeH = 0, resizeW = 0, resizeY = 0, resizeX = 0, resizeL = 0, resizeT = 0, resizeDir = ""
var dirs = [
  {e:"nw",c:"nwse-resize",t:0,l:0},{e:"n",c:"ns-resize",t:0,l:14,r:14},
  {e:"ne",c:"nesw-resize",t:0,r:0},{e:"w",c:"ew-resize",t:14,b:14,l:0},
  {e:"e",c:"ew-resize",t:14,b:14,r:0},{e:"sw",c:"nesw-resize",b:0,l:0},
  {e:"s",c:"ns-resize",b:0,l:14,r:14},{e:"se",c:"nwse-resize",b:0,r:0}
]
dirs.forEach(function(d) {
  var h = document.createElement("div")
  var css = "position:absolute;"
  if (d.l != null) css += "left:" + d.l + "px;"; else if (d.r != null) css += "right:" + d.r + "px;"
  if (d.t != null) css += "top:" + d.t + "px;"; else if (d.b != null) css += "bottom:" + d.b + "px;"
  css += d.l == null && d.r == null ? "width:100%;height:14px;" : d.t == null && d.b == null ? "width:14px;height:100%;" : "width:14px;height:14px;"
  css += "cursor:" + d.c + ";z-index:10"
  h.style.cssText = css
  h.addEventListener("mousedown", function(e) {
    e.stopPropagation(); resizing = true; resizeDir = d.e
    var r = chatPanel.getBoundingClientRect()
    resizeY = e.clientY; resizeX = e.clientX; resizeH = r.height; resizeW = r.width; resizeL = r.left; resizeT = r.top
    chatPanel.style.transition = "none"; chatPanel.style.userSelect = "none"
    chatPanel.style.right = "auto"; chatPanel.style.bottom = "auto"
    chatPanel.style.left = resizeL + "px"; chatPanel.style.top = resizeT + "px"
    chatPanel.style.width = resizeW + "px"; chatPanel.style.height = resizeH + "px"
  })
  chatPanel.appendChild(h)
})
document.addEventListener("mousemove", function(e) {
  if (!resizing) return
  var dy = e.clientY - resizeY, dx = e.clientX - resizeX
  if (resizeDir.indexOf("s") >= 0) chatPanel.style.height = Math.max(200, resizeH + dy) + "px"
  if (resizeDir.indexOf("n") >= 0) { var nh = Math.max(200, resizeH - dy); chatPanel.style.top = (resizeT + resizeH - nh) + "px"; chatPanel.style.height = nh + "px" }
  if (resizeDir.indexOf("e") >= 0) chatPanel.style.width = Math.max(300, resizeW + dx) + "px"
  if (resizeDir.indexOf("w") >= 0) { var nw = Math.max(300, resizeW - dx); chatPanel.style.left = (resizeL + resizeW - nw) + "px"; chatPanel.style.width = nw + "px" }
})
document.addEventListener("mouseup", function() {
  if (resizing) { resizing = false; chatPanel.style.transition = ""; chatPanel.style.userSelect = ""; chatSaveLayout() }
})

function chatRender(msgs) {
  if (!msgs || !msgs.length) return
  msgs.forEach(function(m) {
    // 收到清除标记时清理本地列表
    if (m.clear) {
      chatList.querySelectorAll(".chat-msg").forEach(function(el) { el.remove() })
      chatLastId = 0
      // 已叉掉的不再显示
      var dismissed = JSON.parse(localStorage.getItem("lan_chat_clear_dismiss") || "[]")
      if (dismissed.indexOf(m.id) !== -1) return
      // 移除旧通知，显示新通知
      var oldTip = chatList.querySelector(".chat-clear-tip")
      if (oldTip) oldTip.remove()
      var tip2 = document.createElement("div")
      tip2.className = "chat-clear-tip"
      tip2.textContent = "聊天记录已清除"
      tip2.addEventListener("click", function() {
        tip2.remove()
        var ds = JSON.parse(localStorage.getItem("lan_chat_clear_dismiss") || "[]")
        ds.push(m.id)
        localStorage.setItem("lan_chat_clear_dismiss", JSON.stringify(ds))
      })
      chatList.appendChild(tip2)
      return
    }
    var div = document.createElement("div")
    div.className = "chat-msg"
    if (m.system) {
      div.className = "chat-msg chat-sys"
      div.innerHTML = '<span class="chat-text">' + escapeHtml(m.text) + '</span><span class="chat-sys-dismiss">✕</span>'
      div.querySelector(".chat-sys-dismiss").addEventListener("click", function() { div.remove() })
    } else {
      div.innerHTML = '<span class="chat-user">' + escapeHtml(m.user) + '</span><span class="chat-time">' + escapeHtml(m.time) + '</span><span class="chat-text">' + escapeHtml(m.text) + '</span>'
    }
    chatList.appendChild(div)
  })
  chatList.scrollTop = chatList.scrollHeight
}

async function chatFetch() {
  try {
    var r = await fetch("/api/chat/messages?since=" + chatLastId)
    var d = await r.json()
    if (d && d.length) { chatRender(d); chatLastId = d[d.length - 1].id }
  } catch(e) {}
}
setInterval(chatFetch, 1000)
chatFetch()

async function chatSend() {
  var text = chatInput.value.trim()
  if (!text) return
  chatInput.value = ""
  try {
    await apiFetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Name": encodeURIComponent(state.nickname || "匿名") },
      body: JSON.stringify({ text: text })
    })
    chatFetch()
  } catch(e) {}
}
if (chatSendBtn) chatSendBtn.addEventListener("click", chatSend)
if (chatInput) chatInput.addEventListener("keydown", function(e) { if (e.key === "Enter") { e.preventDefault(); chatSend() } })
if (chatCloseBtn) chatCloseBtn.addEventListener("click", function() { chatPanel.classList.add("is-hidden") })
var chatClearBtn = document.getElementById("chatClearBtn")
if (chatClearBtn) {
  chatClearBtn.addEventListener("click", async function() {
    var r = await apiFetch("/api/chat/clear", { method: "POST" })
    var d = await r.json()
    if (d.ok) {
      chatList.querySelectorAll(".chat-msg").forEach(function(el) { el.remove() })
      chatLastId = d.nextId - 1
      var tip = document.createElement("div")
      tip.className = "chat-clear-tip"
      tip.textContent = "聊天记录已清除"
      tip.addEventListener("click", function() { tip.remove() })
      chatList.appendChild(tip)
    }
  })
  chatClearBtn.style.display = can("*") ? "" : "none"
}
var chatTripleCount = 0, chatTripleTimer = null
document.addEventListener("keydown", function(e) {
  if (e.ctrlKey && !e.shiftKey && e.key === "ArrowUp") {
    e.preventDefault()
    if (chatPanel.classList.contains("is-hidden")) {
      chatTripleCount++
      if (chatTripleCount >= 3) {
        chatTripleCount = 0
        chatPanel.classList.remove("is-hidden")
        chatList.scrollTop = chatList.scrollHeight
        if (chatInput) chatInput.focus()
        chatFetch()
      }
      clearTimeout(chatTripleTimer)
      chatTripleTimer = setTimeout(function() { chatTripleCount = 0 }, 2000)
    } else {
      chatPanel.classList.add("is-hidden")
    }
  }
  if (e.key === "Escape") chatPanel.classList.add("is-hidden")
})

// ========== 海外剧 ==========
if (typeof state.nsfwMode === "undefined") state.nsfwMode = false
var nsfwBar = document.getElementById("nsfwBar")
var nsfwInput = document.getElementById("nsfwInput")
var _nsfwSet = null

if (nsfwBar) {
  nsfwBar.addEventListener("click", async function() {
    try {
      await apiFetch("/api/nsfw/logout", { method: "POST" })
    } catch {}
    setNsfwModeUi(false)
    loadDir("")
  })
}

if (nsfwInput) {
  _nsfwSet = document.createElement("button")
  _nsfwSet.className = "nsfw-act"
  _nsfwSet.textContent = "密"
  _nsfwSet.title = "修改密码"
  _nsfwSet.addEventListener("click", function() {
    openInputDialog({
      title: "修改密码",
      label: "输入新密码",
      confirmText: "修改",
      validate: function(v) { return v.trim() ? "" : "密码不能为空" }
    }).then(function(p) {
      if (!p) return
      return apiFetch("/api/nsfw/setpwd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: p }) })
        .then(function(r) { return r.json() })
        .then(function(d) { showMessage(d.ok ? "密码已修改" : (d.error || "失败"), d.ok ? "info" : "error") })
    })
  })
  nsfwInput.parentNode.insertBefore(_nsfwSet, nsfwInput.nextSibling)
  _nsfwSet.style.display = can("*") && !state.nsfwMode ? "" : "none"
}

if (nsfwInput) {
  nsfwInput.addEventListener("keydown", function(e) {
    if (e.key !== "Enter") return
    var _v = this.value
    apiFetch("/api/nsfw/auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: _v })
    }).then(function(r) { return r.json() }).then(function(d) {
      if (d.ok) {
        nsfwInput.value = ""
        setNsfwModeUi(true)
        loadDir("")
      } else {
        showMessage("密码错误", "error")
      }
    })
  })
}
