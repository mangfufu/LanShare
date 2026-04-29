const VIEW_MODE_KEY = "lan_file_server_view_mode";
const THEME_KEY = "lan_file_server_theme";
const THEME_POS_KEY = "lan_file_server_theme_pos";
const NICKNAME_KEY = "lan_file_server_nickname";
const NICKNAME_GLOW_COLOR_KEY = "lan_file_server_nickname_glow_color";
const FLOAT_SPEED_KEY = "lan_file_server_float_speed";
const FLOAT_SIZE_KEY = "lan_file_server_float_size";
const CURRENT_DIR_KEY = "lan_file_server_current_dir";
const CURSOR_EFFECT_KEY = "lan_file_server_cursor_effect";

const state = {
  currentDir: "",
  viewMode: localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "list",
  theme: localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light",
  themePos: Number(localStorage.getItem(THEME_POS_KEY)) || 0,
  currentItems: [],
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
  uploadTasks: [],
  nextUploadTaskId: 1,
  csrfToken: "",
  csrfPromise: null,
  nickname: localStorage.getItem(NICKNAME_KEY) || "",
  glowColor: localStorage.getItem(NICKNAME_GLOW_COLOR_KEY) || (() => {
    const colors = ["#7c6cf0","#0a84ff","#00c7be","#34c759","#ffd60a","#ff9f0a","#ff3b30","#ff375f","#bf5af2"];
    const picked = colors[Math.floor(Math.random() * colors.length)];
    localStorage.setItem(NICKNAME_GLOW_COLOR_KEY, picked);
    return picked;
  })(),
  cursorEffect: localStorage.getItem(CURSOR_EFFECT_KEY) !== null ? localStorage.getItem(CURSOR_EFFECT_KEY) : "comet",
  floatSpeed: Number(localStorage.getItem(FLOAT_SPEED_KEY)) || 10,
  floatSize: Number(localStorage.getItem(FLOAT_SIZE_KEY)) || 200,
  logEntries: []
};

const tableBody = document.querySelector("#fileTableBody");
const tableView = document.querySelector("#tableView");
const gridView = document.querySelector("#gridView");
const breadcrumb = document.querySelector("#breadcrumb");
const messageBox = document.querySelector("#message");
const fileInput = document.querySelector("#fileInput");
const folderInput = document.querySelector("#folderInput");
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
const uploadProgressPercent = document.querySelector("#uploadProgressPercent");
const uploadProgressFill = document.querySelector("#uploadProgressFill");
const uploadQueue = document.querySelector("#uploadQueue");
const nicknameDisplay = document.querySelector("#nicknameDisplay");
const logToggleBtn = document.querySelector("#logToggleBtn");
const logPanel = document.querySelector("#logPanel");
const logList = document.querySelector("#logList");
const closeLogBtn = document.querySelector("#closeLogBtn");

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

function showMessage(text, type = "info") {
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
  const res = await fetch(url, { ...options, headers });
  if (res.ok && (options.method === "POST" || options.method === undefined)) pollLogs();
  return res;
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

function openInputDialog({ title, label, value = "", suffix = "", hint = "", confirmText = "确定", validate }) {
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

    input.value = value;
    input.focus();
    input.select();

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog || event.target.dataset.action === "cancel") finish(null);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const nextValue = input.value.trim();
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
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog || event.target.dataset.action === "cancel") finish(false);
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
}

function resetUploadProgress() {
  uploadProgress.classList.add("is-hidden");
  uploadProgress.classList.remove("is-indeterminate");
  uploadProgressText.textContent = "准备上传...";
  uploadProgressPercent.textContent = "0%";
  uploadProgressFill.style.width = "0%";
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
        <div class="upload-task-title">${escapeHtml(task.label)} · ${task.count} 项</div>
        <div class="upload-task-message">${escapeHtml(task.message)}</div>
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
}

function formatSize(size) {
  if (size == null) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getSelectionCount() {
  return state.selectedPaths.size;
}

function updateToolbarButtons() {
  let moveBtn = document.querySelector("#batchMoveBtn");
  if (!moveBtn) {
    moveBtn = document.createElement("button");
    moveBtn.id = "batchMoveBtn";
    moveBtn.type = "button";
    moveBtn.className = "button ghost";
    moveBtn.addEventListener("click", moveSelectedItems);
    document.querySelector(".toolbar-actions").insertBefore(moveBtn, refreshBtn);
  }

  let deleteBtn = document.querySelector("#batchDeleteBtn");
  if (!deleteBtn) {
    deleteBtn = document.createElement("button");
    deleteBtn.id = "batchDeleteBtn";
    deleteBtn.type = "button";
    deleteBtn.className = "button ghost danger-button";
    deleteBtn.addEventListener("click", deleteSelectedItems);
    document.querySelector(".toolbar-actions").insertBefore(deleteBtn, refreshBtn);
  }

  let downloadBtn = document.querySelector("#batchDownloadBtn");
  if (!downloadBtn) {
    downloadBtn = document.createElement("button");
    downloadBtn.id = "batchDownloadBtn";
    downloadBtn.type = "button";
    downloadBtn.className = "button ghost";
    downloadBtn.addEventListener("click", downloadSelectedItems);
    document.querySelector(".toolbar-actions").insertBefore(downloadBtn, deleteBtn);
  }

  const count = getSelectionCount();
  moveBtn.textContent = count > 0 ? `批量移动 (${count})` : "批量移动";
  deleteBtn.textContent = count > 0 ? `批量删除 (${count})` : "批量删除";
  downloadBtn.textContent = count > 0 ? `批量下载 (${count})` : "批量下载";
  moveBtn.disabled = count === 0;
  deleteBtn.disabled = count === 0;
  downloadBtn.disabled = count === 0;
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
  rootButton.textContent = "shared";
  rootButton.onclick = () => loadDir("");
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
    breadcrumb.appendChild(btn);
  }
}

function buildThumbnail(item, searchDir) {
  const wrapper = document.createElement("div");
  wrapper.className = "name-wrap";

  const thumb = document.createElement("div");
  thumb.className = `thumb ${item.type === "directory" ? "folder" : item.previewType}`;

  if (item.type === "directory") {
    thumb.textContent = "DIR";
  } else if (item.previewType === "image") {
    const img = document.createElement("img");
    img.src = `/file?path=${encodeURIComponent(item.path)}`;
    img.alt = item.name;
    img.loading = "lazy";
    thumb.appendChild(img);
  } else if (item.previewType === "video") {
    const poster = document.createElement("div");
    poster.className = "video-thumb-placeholder";
    poster.textContent = "VIDEO";
    thumb.appendChild(poster);
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

function openPreview(item) {
  if (item.type === "directory") {
    loadDir(item.path);
    return;
  }
  if (item.previewType === "none") {
    window.open(`/file?path=${encodeURIComponent(item.path)}`, "_blank", "noopener");
    return;
  }

  previewTitle.textContent = item.name;
  previewBody.innerHTML = "";
  const src = `/file?path=${encodeURIComponent(item.path)}`;

  if (item.previewType === "image") {
    const img = document.createElement("img");
    img.className = "preview-image";
    img.src = src;
    img.alt = item.name;
    previewBody.appendChild(img);
  } else if (item.previewType === "video") {
    const video = document.createElement("video");
    video.className = "preview-video";
    video.src = src;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    previewBody.appendChild(video);
  } else if (item.previewType === "audio") {
    previewBody.innerHTML = `
      <div class="audio-preview">
        <div class="audio-art">♪</div>
        <div class="audio-name">${escapeHtml(item.name)}</div>
        <audio class="preview-audio" src="${src}" controls autoplay></audio>
      </div>
    `;
  }

  if (typeof previewDialog.showModal === "function") {
    previewDialog.showModal();
  } else {
    previewDialog.setAttribute("open", "open");
  }
}

function closePreview() {
  previewBody.innerHTML = "";
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
}

// Theme color pairs for interpolation [light, dark]
const THEME_COLORS = {
  "--bg":           ["#f3efe5", "#13171d"],
  "--panel":        ["#fffcf5", "#171c23"],
  "--panel-strong": ["#ffffff", "#1e252e"],
  "--panel-hover":  ["#fff8eb", "#28343c"],
  "--panel-soft":   ["#fff7e7", "#222a34"],
  "--line":         ["#d3c6ac", "#33404c"],
  "--text":         ["#1f1d1a", "#e9edf2"],
  "--muted":        ["#6e6657", "#9aa7b4"],
  "--accent":       ["#1f6f5f", "#7bd1bf"],
  "--floating-bg":  ["#1f1d1a", "#f2f5f8"],
  "--floating-text":["#ffffff", "#16202b"]
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

function applyThemePos(pos) {
  state.themePos = pos;
  state.theme = pos < 50 ? "light" : "dark";
  localStorage.setItem(THEME_POS_KEY, String(pos));
  localStorage.setItem(THEME_KEY, state.theme);
  const t = pos / 100;
  const vars = {};
  for (const [key, [light, dark]] of Object.entries(THEME_COLORS)) {
    vars[key] = lerpColor(light, dark, t);
  }
  document.body.style.setProperty("--bg", vars["--bg"]);
  document.body.style.setProperty("--panel", vars["--panel"]);
  document.body.style.setProperty("--panel-strong", vars["--panel-strong"]);
  document.body.style.setProperty("--line", vars["--line"]);
  document.body.style.setProperty("--text", vars["--text"]);
  document.body.style.setProperty("--muted", vars["--muted"]);
  document.body.style.setProperty("--accent", vars["--accent"]);
  document.body.style.setProperty("--floating-bg", vars["--floating-bg"]);
  document.body.style.setProperty("--floating-text", vars["--floating-text"]);
  document.body.style.setProperty("--panel-hover", vars["--panel-hover"]);
  document.body.style.setProperty("--panel-soft", vars["--panel-soft"]);
}

function applyTheme(theme) {
  const pos = theme === "dark" ? 100 : 0;
  const slider = document.querySelector("#themeSlider");
  if (slider) slider.value = pos;
  applyThemePos(pos);
}

function toggleTheme() {
  const newPos = state.themePos < 50 ? 100 : 0;
  const slider = document.querySelector("#themeSlider");
  if (slider) slider.value = newPos;
  applyThemePos(newPos);
}

function isSelected(path) {
  return state.selectedPaths.has(path);
}

function toggleSelected(path, checked) {
  if (checked) state.selectedPaths.add(path);
  else state.selectedPaths.delete(path);
  updateToolbarButtons();
}

function clearSelections() {
  state.selectedPaths.clear();
  updateToolbarButtons();
}

function getFilteredCurrentItems() {
  const keyword = state.searchFilter.trim().toLowerCase();
  if (!keyword) return state.currentItems;
  return state.currentItems.filter((item) => item.name.toLowerCase().includes(keyword) || item.path.toLowerCase().includes(keyword));
}

function renderCurrentDirectory() {
  renderBreadcrumb();
  if (state.searchQuery) {
    const items = state.searchResults;
    const count = items.length;
    const suffix = items._stoppedEarly ? `（仅前 ${count} 项，请缩小搜索范围）` : count > 0 ? `（共 ${count} 项）` : "";
    showMessage(`搜索“${state.searchQuery}”${suffix}`, "info");
    renderRows(items, true);
  } else {
    renderRows(getFilteredCurrentItems(), false);
  }
}

function makeSelectCheckbox(item) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "select-checkbox";
  input.checked = isSelected(item.path);
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", (event) => toggleSelected(item.path, event.target.checked));
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
    validate: (value) => validatePlainName(value, "新名称不能为空")
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
  showMessage(`已移入回收站${labelText}`, "success");
  await loadRecycleItems();
  return true;
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

async function moveItems(paths, targetDir) {
  const res = await apiFetch("/api/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, targetDir })
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) {
    showMessage(data.error || "移动失败", "error");
    return false;
  }
  return true;
}

function renderMoveBreadcrumb() {
  moveDialogBreadcrumb.innerHTML = "";
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = "crumb";
  rootButton.textContent = "shared";
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

  const res = await fetch(`/api/list?dir=${encodeURIComponent(dir)}`);
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
    validate: (value) => validatePlainName(value, "文件夹名称不能为空")
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

function createActions(item) {
  const actions = document.createElement("div");
  actions.className = "grid-actions";

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
    const downloadLink = document.createElement("a");
    downloadLink.className = "link-button";
    downloadLink.textContent = "下载";
    downloadLink.href = `/download?path=${encodeURIComponent(item.path)}`;
    actions.appendChild(downloadLink);
  }

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

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "link-button danger-button";
  deleteBtn.textContent = "删除";
  deleteBtn.onclick = () => deleteItem(item);
  actions.appendChild(deleteBtn);
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
  card.ondblclick = () => openPreview(item);

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
    <div class="grid-type">${item.type === "directory" ? "文件夹" : "文件"}</div>
    <div class="grid-size">${formatSize(item.size)}</div>
    <div class="grid-time">${new Date(item.updatedAt).toLocaleString("zh-CN")}</div>
  `;
  card.appendChild(meta);
  card.appendChild(createActions(item));
  return card;
}

function renderGrid(items) {
  gridView.innerHTML = "";
  if (state.searchQuery) {
    // search mode — no up button
  } else if (state.currentDir) {
    const upCard = document.createElement("article");
    upCard.className = "grid-card up-card";
    upCard.innerHTML = '<div class="up-icon">..</div><div class="up-label">返回上级</div>';
    upCard.onclick = () => {
      const parts = state.currentDir.split("/");
      parts.pop();
      loadDir(parts.join("/"));
    };
    gridView.appendChild(upCard);
  }
  for (const item of items) {
    gridView.appendChild(createGridCard(item));
  }
  if (!items.length && state.searchQuery) {
    const empty = document.createElement("div");
    empty.className = "grid-empty";
    empty.textContent = "没有匹配的项目。";
    gridView.appendChild(empty);
  } else if (!items.length && !state.currentDir) {
    const empty = document.createElement("div");
    empty.className = "grid-empty";
    empty.textContent = "共享目录为空，先上传文件、上传文件夹，或新建文件夹。";
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
  renderGrid(items);

  if (!state.searchQuery && state.currentDir) {
    const tr = rowTemplate.content.firstElementChild.cloneNode(true);
    tr.className = "interactive-row";
    tr.querySelector(".name-cell").textContent = "..";
    tr.querySelector(".type-cell").textContent = "返回上级";
    tr.querySelector(".size-cell").textContent = "-";
    tr.querySelector(".time-cell").textContent = "-";
    tr.ondblclick = () => {
      const parts = state.currentDir.split("/");
      parts.pop();
      loadDir(parts.join("/"));
    };
    const upButton = document.createElement("button");
    upButton.className = "link-button";
    upButton.textContent = "打开";
    upButton.onclick = () => {
      const parts = state.currentDir.split("/");
      parts.pop();
      loadDir(parts.join("/"));
    };
    tr.querySelector(".op-cell").appendChild(upButton);
    tableBody.appendChild(tr);
  }

  for (const item of items) {
    const searchDir = state.searchQuery ? parentDir(item.path) : "";
    const tr = rowTemplate.content.firstElementChild.cloneNode(true);
    tr.className = item.previewType !== "none" || item.type === "directory" ? "interactive-row" : "";
    const wrap = document.createElement("div");
    wrap.className = "row-name-wrap";
    wrap.appendChild(makeSelectCheckbox(item));
    wrap.appendChild(buildThumbnail(item, searchDir));
    tr.querySelector(".name-cell").appendChild(wrap);
    tr.querySelector(".type-cell").textContent = item.type === "directory" ? "文件夹" : "文件";
    tr.querySelector(".size-cell").textContent = formatSize(item.size);
    tr.querySelector(".time-cell").textContent = new Date(item.updatedAt).toLocaleString("zh-CN");
    tr.ondblclick = () => openPreview(item);
    tr.querySelector(".op-cell").appendChild(createActions(item));
    tableBody.appendChild(tr);
  }

  if (!items.length && !state.currentDir) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="empty">共享目录为空，先上传文件、上传文件夹，或新建文件夹。</td>';
    tableBody.appendChild(tr);
  } else if (!items.length && state.searchQuery) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="empty">没有匹配的项目。</td>';
    tableBody.appendChild(tr);
  } else if (!items.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="empty">当前目录为空。</td>';
    tableBody.appendChild(tr);
  }
}

async function loadDir(dir) {
  clearMessage();
  clearSelections();
  const res = await fetch(`/api/list?dir=${encodeURIComponent(dir)}`);
  const data = await res.json();
  if (!res.ok) {
    showMessage(data.error || "读取目录失败", "error");
    return;
  }
  state.currentDir = data.currentDir;
  state.currentItems = data.items;
  localStorage.setItem(CURRENT_DIR_KEY, data.currentDir);
  if (state.searchQuery) {
    state.searchQuery = "";
    state.searchResults = [];
    mainSearchInput.value = "";
  }
  renderCurrentDirectory();
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
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("X-CSRF-Token", state.csrfToken);
    if (state.nickname) xhr.setRequestHeader("X-Device-Name", encodeURIComponent(state.nickname));

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 100;
      setUploadProgress(percent, `正在上传${label}...`);
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
  showMessage(`上传完成，共 ${result.data.uploaded} 个项目，已写入备份。`, "success");
  await loadDir(state.currentDir);
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
    validate: (value) => validatePlainName(value, "文件夹名称不能为空")
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

function setDropActive(active) {
  document.body.classList.toggle("drag-active", active);
}

fileInput.addEventListener("change", async (event) => {
  try {
    await uploadFiles(event.target.files, { keepRelativePath: false, label: "文件" });
  } finally {
    fileInput.value = "";
  }
});

folderInput.addEventListener("change", async (event) => {
  try {
    await uploadFiles(event.target.files, { keepRelativePath: true, label: "文件夹" });
  } finally {
    folderInput.value = "";
  }
});

document.addEventListener("dragover", (event) => {
  if (_draggingChar) return;
  event.preventDefault();
  setDropActive(true);
});

document.addEventListener("dragleave", (event) => {
  if (_draggingChar) return;
  if (event.clientX === 0 && event.clientY === 0) setDropActive(false);
});

document.addEventListener("drop", async (event) => {
  if (_draggingChar) return;
  event.preventDefault();
  setDropActive(false);
  try {
    const entries = await entriesFromDataTransfer(event.dataTransfer);
    await uploadEntries(entries, "拖拽内容");
  } catch (error) {
    showMessage(error.message || "拖拽上传失败", "error");
  }
});

// --- Nickname ---

function promptNickname() {
  if (!state.nickname) {
    const d = document.createElement("dialog");
    d.className = "preview-dialog form-dialog";
    d.innerHTML = `
      <div class="preview-header">
        <div>
          <div class="label">首次使用</div>
          <div class="preview-title">请输入你的昵称</div>
        </div>
      </div>
      <form class="form-dialog-body" method="dialog">
        <div class="input-row">
          <input class="field" name="value" autocomplete="off" placeholder="例如：张三" />
        </div>
        <div class="dialog-actions">
          <button class="button ghost" data-action="cancel" type="button">随机分配</button>
          <button class="button primary" type="submit">确定</button>
        </div>
      </form>`;
    document.body.appendChild(d);
    const form = d.querySelector("form");
    const input = d.querySelector("input");
    const randomNames = ["小风", "云朵", "星星", "月光", "彩虹", "流星", "清风", "小溪", "山雀", "海鸥", "萤火虫", "小鹿", "雪人", "果冻", "布丁", "奶茶", "咖啡", "饼干", "糯米", "豆沙"];
    function assignRandom() {
      const r = randomNames[Math.floor(Math.random() * randomNames.length)] + String(Math.floor(Math.random() * 100));
      state.nickname = r;
      localStorage.setItem(NICKNAME_KEY, r);
      updateNicknameDisplay();
      apiFetch("/api/nickname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldName: "", newName: r }) }).catch(() => {});
      closeDialog(d); d.remove();
    }
    input.focus();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name) {
        state.nickname = name;
        localStorage.setItem(NICKNAME_KEY, name);
        updateNicknameDisplay();
        apiFetch("/api/nickname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldName: "", newName: name }) }).catch(() => {});
      } else {
        assignRandom();
        return;
      }
      closeDialog(d); d.remove();
    });
    d.addEventListener("click", (e) => { if (e.target.dataset.action === "cancel") { e.preventDefault(); assignRandom(); } });
    d.addEventListener("close", () => { if (!state.nickname) assignRandom(); d.remove(); });
    d.addEventListener("cancel", (e) => { e.preventDefault(); if (!state.nickname) assignRandom(); });
    showDialog(d);
  }
}

const GLOW_COLORS = [
  { label: "无", color: "" },
  { label: "紫", color: "#7c6cf0" },
  { label: "蓝", color: "#0a84ff" },
  { label: "青", color: "#00c7be" },
  { label: "绿", color: "#34c759" },
  { label: "黄", color: "#ffd60a" },
  { label: "橙", color: "#ff9f0a" },
  { label: "红", color: "#ff3b30" },
  { label: "粉", color: "#ff375f" },
  { label: "紫罗兰", color: "#bf5af2" },
  { label: "自定义", color: "custom" }
];

const CURSOR_EFFECTS = [
  { key: "classic", label: "经典" },
  { key: "ribbon", label: "丝带" },
  { key: "spark", label: "星尘" },
  { key: "comet", label: "彗尾" }
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
        <div class="label">修改昵称</div>
        <div class="preview-title">输入新昵称</div>
      </div>
      <button class="button ghost" data-action="cancel" type="button">关闭</button>
    </div>
    <form class="form-dialog-body" method="dialog">
      <div class="input-row">
        <input class="field" name="value" autocomplete="off" placeholder="例如：张三" value="${escapeHtml(state.nickname)}" style="color:var(--text);background:var(--panel-strong)" />
      </div>
      <div style="font-size:13px;color:var(--muted);margin-top:4px">光效颜色</div>
      <div id="colorPicker" style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 0">
        ${GLOW_COLORS.map((c, i) => {
          if (c.color === "custom") {
            return `<input type="color" id="customColor" value="${selColor || "#7c6cf0"}" style="width:36px;height:36px;border:none;border-radius:50%;cursor:pointer;padding:0;background:none;accent-color:var(--accent)" />`;
          }
          const isActive = (!c.color && !selColor) || (c.color && c.color === selColor);
          return `<div data-idx="${i}" class="color-swatch ${isActive ? "active" : ""}" style="width:36px;height:36px;border-radius:50%;cursor:pointer;background:${c.color || "var(--panel)"};${c.color ? `box-shadow:0 0 6px ${c.color}40` : "border:1px dashed var(--line)"};display:flex;align-items:center;justify-content:center;font-size:16px;transition:transform 120ms ease">${c.color ? "" : "✕"}</div>`;
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
    if (!name) { msg.textContent = "昵称不能为空"; msg.className = "message-area error"; input.focus(); return; }
    finish(name);
  });
  d.addEventListener("click", (e) => { if (e.target === d || e.target.dataset.action === "cancel") finish(null); });
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
  apiFetch("/api/nickname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldName, newName: name }) }).catch(() => {});
  showMessage("昵称已修改", "success");
}

function updateNicknameDisplay() {
  if (!nicknameDisplay) return;
  nicknameDisplay.textContent = state.nickname || "设置昵称";
  const hasGlow = !!state.glowColor;
  nicknameDisplay.classList.toggle("nickname-glow", hasGlow);
  if (hasGlow) {
    nicknameDisplay.style.setProperty("--glow-color", state.glowColor);
    nicknameDisplay.style.setProperty("--glow-filter-peak", `drop-shadow(0 0 4px ${state.glowColor}) drop-shadow(0 0 12px ${state.glowColor})`);
    nicknameDisplay.style.setProperty("--glow-filter-valley", `drop-shadow(0 0 6px ${state.glowColor}) drop-shadow(0 0 20px ${state.glowColor})`);
  }
}

if (nicknameDisplay) {
  nicknameDisplay.addEventListener("click", changeNickname);
}

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

const bgBtn = document.querySelector("#bgUploadBtn");
const bgInput = document.querySelector("#bgFileInput");
if (bgBtn && bgInput) {
  bgBtn.addEventListener("click", () => bgInput.click());
  bgInput.addEventListener("change", () => {
    const file = bgInput.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    const url = URL.createObjectURL(file);
    setBgDisplay(url, isVideo);
    bgInput.value = "";
  });
  bgBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const el = document.querySelector("#bgOverlay");
    if (el) el.innerHTML = "";
  });
}

// --- Hide UI toggle ---
const hideBtn = document.querySelector("#hideUiBtn");
if (hideBtn) {
  let uiHidden = false;
  hideBtn.addEventListener("click", () => {
    uiHidden = !uiHidden;
    const els = [
      document.querySelector(".version-badge"),
      document.querySelector(".hero"),
      document.querySelector(".panel"),
      document.querySelector("#logToggleBtn"),
      document.querySelector("#themeSliderWrap"),
      document.querySelector("#recycleToggleBtn"),
      document.querySelector("#logPanel"),
      document.querySelector("#recycleDrawer"),
      document.querySelector("#floatControl"),
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
    hideBtn.textContent = uiHidden ? "🐵" : "🙈";
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
promptNickname();
setInterval(pollLogs, 3000);

mkdirBtn.addEventListener("click", createFolder);
refreshBtn.addEventListener("click", () => loadDir(state.currentDir));
async function performSearch(query) {
  if (state.searchTimeout) {
    clearTimeout(state.searchTimeout);
    state.searchTimeout = null;
  }
  state.searchTimeout = setTimeout(async () => {
    state.searchTimeout = null;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
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
closePreviewBtn.addEventListener("click", closePreview);
previewDialog.addEventListener("click", (event) => {
  if (event.target === previewDialog) closePreview();
});
recycleToggleBtn.addEventListener("click", () => {
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
// Theme slider init
const themeSlider = document.querySelector("#themeSlider");
if (themeSlider) {
  themeSlider.value = state.themePos;
  themeSlider.addEventListener("input", () => applyThemePos(Number(themeSlider.value)));
}
applyThemePos(state.themePos);
initBackground();
setViewMode(state.viewMode);
const savedDir = localStorage.getItem(CURRENT_DIR_KEY) || "";
loadDir(savedDir);
loadRecycleItems();

// --- Floating characters (per-character bounce) + cursor particles + click burst ---

let floatChars = [];
let floatAnimId = null;
let cursorParticleCanvas = null;
let cursorCtx = null;
let cursorParticles = [];
let cursorAnimId = null;
let collisionParticles = [];

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
  let dragChar = null;
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
  document.addEventListener("mousedown", (e) => {
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
  });
  document.addEventListener("mouseup", (e) => {
    if (dragChar) {
      dragChar.vx = dragChar.vx || 0;
      dragChar.vy = dragChar.vy || 0;
      dragChar.el.style.opacity = "0.15";
      dragChar = null;
    }
    _draggingChar = false;
  });

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
  document.addEventListener("dragstart", (e) => { if (dragChar) e.preventDefault(); });
  document.addEventListener("selectstart", (e) => { if (dragChar) e.preventDefault(); });

  function animate() {
    const mw = window.innerWidth, mh = window.innerHeight;
    const now = performance.now();

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
  let lastX = 0, lastY = 0, lastDX = 0, lastDY = 0, hasPointer = false;
  const trailNodes = [];
  const mode = state.cursorEffect || "";
  window.addEventListener("resize", () => {
    w = cursorParticleCanvas.width = window.innerWidth;
    h = cursorParticleCanvas.height = window.innerHeight;
  });

  document.addEventListener("mousemove", (e) => {
    if (!state.glowColor) return;
    const color = state.glowColor;
    const dx = hasPointer ? e.clientX - lastX : 0;
    const dy = hasPointer ? e.clientY - lastY : 0;
    const speed = Math.hypot(dx, dy);
    lastX = e.clientX;
    lastY = e.clientY;
    if (speed > 0.1) { lastDX = dx; lastDY = dy; }
    hasPointer = true;

    if (mode === "classic") {
      // 经典：每帧稳定产出小圆点，带重力下落
      for (let i = 0; i < 3; i++) {
        cursorParticles.push({
          x: e.clientX + (Math.random() - 0.5) * 4,
          y: e.clientY + (Math.random() - 0.5) * 4,
          vx: (Math.random() - 0.5) * 2.2,
          vy: (Math.random() - 0.5) * 2.2 - 1.0,
          r: 2.5 + Math.random() * 4.5,
          life: 1,
          decay: 0.014 + Math.random() * 0.006,
          mode,
          color
        });
      }
      return;
    }

    if (speed < 3) return;

    if (mode === "ribbon") {
      // 丝带：左右双轨波浪带状，扭动扩散
      const mx = Math.abs(dx) < 0.15 && Math.abs(lastDX) > 0.15 ? lastDX : dx;
      const my = Math.abs(dy) < 0.15 && Math.abs(lastDY) > 0.15 ? lastDY : dy;
      for (let s = -1; s <= 1; s += 2) {
        const drift = s * (8 + Math.sin(performance.now() * 0.01) * 3);
        const node = {
          x: e.clientX - mx * 0.1 + drift,
          y: e.clientY - my * 0.1 - drift * 0.25,
          vx: mx * 0.03 + s * 0.15,
          vy: my * 0.03 - 0.08,
          r: Math.min(9, 2.5 + speed * 0.04),
          life: 1,
          decay: 0.024 + Math.random() * 0.006,
          ribbonSide: s,
          wave: Math.random() * Math.PI * 2,
          mode,
          color
        };
        cursorParticles.push(node);
        trailNodes.push(node);
      }
    } else if (mode === "spark") {
      // 星尘：十字星形粒子，极小且闪，方向偏随机
      const count = speed > 20 ? 5 : 3;
      for (let i = 0; i < count; i++) {
        cursorParticles.push({
          x: e.clientX + (Math.random() - 0.5) * 6,
          y: e.clientY + (Math.random() - 0.5) * 6,
          vx: dx * 0.015 + (Math.random() - 0.5) * 1.8,
          vy: dy * 0.015 + (Math.random() - 0.5) * 1.8,
          r: 1.2 + Math.random() * 2.2,
          life: 1,
          decay: 0.06 + Math.random() * 0.025,
          sparkShape: true,
          mode,
          color
        });
      }
    } else if (mode === "comet") {
      // 彗尾：粗头在前，身后跟随衰减细尾
      const mx = Math.abs(dx) < 0.15 && Math.abs(lastDX) > 0.15 ? lastDX : dx;
      const my = Math.abs(dy) < 0.15 && Math.abs(lastDY) > 0.15 ? lastDY : dy;
      const node = {
        x: e.clientX - mx * 0.4,
        y: e.clientY - my * 0.4,
        vx: mx * 0.12,
        vy: my * 0.12 - 0.05,
        r: Math.min(26, 7 + speed * 0.14),
        life: 1,
        decay: 0.018 + Math.random() * 0.005,
        head: true,
        mode,
        color
      };
      cursorParticles.push(node);
      trailNodes.push(node);
    }
  });

  document.addEventListener("click", (e) => {
    if (!state.glowColor) return;
    const color = state.glowColor;

    if (mode === "classic") {
      // 经典点击：中心冲击环 + 稠密弹幕（圆形均匀爆散）
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 14, life: 0.52, decay: 0.07, ring: true, mode, color });
      for (let i = 0; i < 36; i++) {
        const a = (Math.PI * 2 * i) / 36 + Math.random() * 0.05;
        const sp = 1.5 + Math.random() * 5.5;
        cursorParticles.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.4, r: 2 + Math.random() * 5, life: 1, decay: 0.018 + Math.random() * 0.008, mode, color });
      }
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.5 + Math.random() * 1.2;
        cursorParticles.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.4, r: 7 + Math.random() * 6, life: 0.44, decay: 0.075 + Math.random() * 0.02, burstGlow: true, mode, color });
      }
      return;
    }

    if (mode === "ribbon") {
      // 丝带点击：中心波纹脉冲 + 左右两翼飞散
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 20, life: 0.88, decay: 0.032, ribbonPulse: true, mode, color });
      for (let s = -1; s <= 1; s += 2) {
        cursorParticles.push({ x: e.clientX, y: e.clientY, vx: s * 3, vy: -1.5, r: 8, life: 0.5, decay: 0.06, ring: true, ribbonSide: s, wave: Math.random() * Math.PI * 2, mode, color });
        for (let i = 0; i < 14; i++) {
          cursorParticles.push({ x: e.clientX + s * (3 + Math.random() * 6), y: e.clientY + (Math.random() - 0.5) * 6, vx: s * (0.8 + Math.random() * 1.8), vy: -0.2 + (Math.random() - 0.5) * 1.0, r: 2 + Math.random() * 2.2, life: 1, decay: 0.032 + Math.random() * 0.008, ribbonSide: s, wave: Math.random() * Math.PI * 2, mode, color });
        }
      }
      return;
    }

    if (mode === "spark") {
      // 星尘点击：十字闪光 + 等角度射线 + 小光晕
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 10, life: 0.48, decay: 0.08, sparkFlash: true, mode, color });
      for (let i = 0; i < 22; i++) {
        const a = (Math.PI * 2 * i) / 22 + Math.random() * 0.06;
        const sp = 2 + Math.random() * 4;
        cursorParticles.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 1.5 + Math.random() * 1.5, life: 1, decay: 0.04 + Math.random() * 0.014, sparkRay: true, mode, color });
      }
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.6 + Math.random() * 1.4;
        cursorParticles.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 3 + Math.random() * 2, life: 0.78, decay: 0.05 + Math.random() * 0.014, burstGlow: true, mode, color });
      }
      return;
    }

    // 彗尾点击：小冲击环 + 慢速块状碎片
    cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: 0, r: 22, life: 0.44, decay: 0.1, ring: true, mode, color });
    cursorParticles.push({ x: e.clientX, y: e.clientY, vx: 0, vy: -0.3, r: 28, life: 0.36, decay: 0.095, burstGlow: true, mode, color });
    // 零星大块碎片
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.5 + Math.random() * 1.2;
      cursorParticles.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.6, r: 4 + Math.random() * 3.5, life: 1, decay: 0.022 + Math.random() * 0.006, mode, color });
    }
  });

  function animate() {
    cursorCtx.clearRect(0, 0, w, h);
    cursorCtx.globalCompositeOperation = "lighter";

    for (let i = trailNodes.length - 1; i >= 0; i--) {
      if (trailNodes[i].life <= 0) trailNodes.splice(i, 1);
    }

    // --- 丝带：双轨波浪连线 ---
    if (mode === "ribbon" && trailNodes.length > 1) {
      for (let i = 1; i < trailNodes.length; i++) {
        const prev = trailNodes[i - 1], curr = trailNodes[i];
        const alpha = Math.min(prev.life, curr.life) * 0.18;
        if (alpha <= 0.002) continue;
        cursorCtx.strokeStyle = curr.color;
        cursorCtx.globalAlpha = alpha;
        cursorCtx.lineWidth = Math.max(1.2, curr.r * 0.38);
        cursorCtx.lineCap = "round";
        cursorCtx.beginPath();
        const midX = (prev.x + curr.x) / 2, midY = (prev.y + curr.y) / 2;
        cursorCtx.moveTo(prev.x, prev.y);
        cursorCtx.quadraticCurveTo(midX + (curr.ribbonSide || 1) * 5, midY - 4, curr.x, curr.y);
        cursorCtx.stroke();
      }
    }

    // --- 彗尾：粗头拖出渐细尾线 ---
    if (mode === "comet" && trailNodes.length > 1) {
      for (let i = 1; i < trailNodes.length; i++) {
        const prev = trailNodes[i - 1], curr = trailNodes[i];
        const alpha = Math.min(prev.life, curr.life) * 0.24;
        if (alpha <= 0.003) continue;
        cursorCtx.strokeStyle = curr.color;
        cursorCtx.globalAlpha = alpha;
        cursorCtx.lineWidth = Math.max(3, curr.r * 0.85);
        cursorCtx.lineCap = "round";
        cursorCtx.beginPath();
        cursorCtx.moveTo(prev.x, prev.y);
        cursorCtx.lineTo(curr.x, curr.y);
        cursorCtx.stroke();
        cursorCtx.globalAlpha = alpha * 0.42;
        cursorCtx.lineWidth = Math.max(1.2, curr.r * 0.32);
        cursorCtx.beginPath();
        cursorCtx.moveTo(prev.x, prev.y);
        cursorCtx.lineTo(curr.x, curr.y);
        cursorCtx.stroke();
      }
    }

    for (let i = cursorParticles.length - 1; i >= 0; i--) {
      const p = cursorParticles[i];

      if (p.mode === "classic") {
        p.x += p.vx; p.y += p.vy;
        p.vy += 0.05;
        p.vx *= 0.992; p.vy *= 0.992;
        p.life -= p.ring ? 0.052 : p.burstGlow ? 0.045 : 0.016;
      } else if (p.mode === "ribbon") {
        p.x += p.vx; p.y += p.vy;
        if (p.ring || p.burstGlow || p.ribbonPulse) {
          p.vx *= 0.95; p.vy = (p.vy - 0.06) * 0.95;
        }
        p.wave = (p.wave || 0) + 0.24;
        p.x += Math.sin(p.wave) * 1.0 * (p.ribbonSide || 1);
        p.y += Math.cos(p.wave) * 0.2;
        p.vx *= p.ring ? 1 : 0.984; p.vy *= p.ring ? 1 : 0.984;
        p.r *= p.ring ? 1.1 : p.ribbonPulse ? 1.055 : 0.993;
        p.life -= p.decay || 0.03;
      } else if (p.mode === "spark") {
        p.x += p.vx; p.y += p.vy;
        if (p.sparkFlash || p.sparkRay || p.burstGlow) {
          p.vx *= 0.93; p.vy = (p.vy - 0.04) * 0.93;
        }
        p.vx *= p.sparkRay ? 0.965 : 0.978;
        p.vy *= p.sparkRay ? 0.965 : 0.978;
        p.r *= p.sparkFlash ? 1.05 : p.burstGlow ? 1.06 : 0.98;
        p.life -= p.decay || 0.045;
      } else if (p.mode === "comet") {
        p.x += p.vx; p.y += p.vy;
        if (p.ring || p.burstGlow) {
          p.vx *= 0.92; p.vy = (p.vy - 0.05) * 0.92;
        }
        p.vx *= p.ring ? 1 : 0.996; p.vy *= p.ring ? 1 : 0.996;
        p.r *= p.ring ? 1.09 : p.burstGlow ? 1.07 : 0.994;
        p.life -= p.decay || 0.02;
      }

      if (p.life <= 0) { cursorParticles.splice(i, 1); continue; }

      // ========== 经典：圆点 + 光环 + 柔光晕 ==========
      if (p.mode === "classic") {
        if (p.ring) {
          cursorCtx.strokeStyle = p.color;
          cursorCtx.globalAlpha = p.life * 0.28;
          cursorCtx.lineWidth = 2.4;
          cursorCtx.beginPath();
          cursorCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          cursorCtx.stroke();
          cursorCtx.globalAlpha = 1;
          p.r *= 1.09;
          continue;
        }
        if (p.burstGlow) {
          const g = cursorCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          g.addColorStop(0, `${p.color}ee`); g.addColorStop(0.4, `${p.color}66`); g.addColorStop(1, `${p.color}00`);
          cursorCtx.fillStyle = g;
          cursorCtx.globalAlpha = p.life * 0.34;
          cursorCtx.beginPath(); cursorCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2); cursorCtx.fill();
          cursorCtx.globalAlpha = 1;
          continue;
        }
        cursorCtx.beginPath();
        cursorCtx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
        cursorCtx.fillStyle = p.color;
        cursorCtx.globalAlpha = p.life * 0.58;
        cursorCtx.fill();
        cursorCtx.globalAlpha = 1;
        continue;
      }

      // ========== 丝带：环形 + 波纹脉冲 + 光点 ==========
      if (p.mode === "ribbon") {
        if (p.ring) {
          cursorCtx.strokeStyle = p.color;
          cursorCtx.globalAlpha = p.life * 0.24;
          cursorCtx.lineWidth = 2;
          cursorCtx.beginPath(); cursorCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2); cursorCtx.stroke();
          continue;
        }
        if (p.ribbonPulse) {
          cursorCtx.strokeStyle = p.color;
          cursorCtx.globalAlpha = p.life * 0.28;
          cursorCtx.lineWidth = 2.4;
          cursorCtx.beginPath();
          cursorCtx.moveTo(p.x - p.r * 1.5, p.y - 5);
          cursorCtx.bezierCurveTo(p.x - p.r * 0.4, p.y - p.r * 0.9, p.x + p.r * 0.4, p.y + p.r * 0.9, p.x + p.r * 1.5, p.y + 5);
          cursorCtx.stroke();
          cursorCtx.moveTo(p.x - p.r * 1.5, p.y + 5);
          cursorCtx.bezierCurveTo(p.x - p.r * 0.4, p.y + p.r * 0.9, p.x + p.r * 0.4, p.y - p.r * 0.9, p.x + p.r * 1.5, p.y - 5);
          cursorCtx.stroke();
          cursorCtx.globalAlpha = 1;
          p.r *= 1.06;
          continue;
        }
        // ribbon trail point
        const rg = cursorCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, p.r));
        rg.addColorStop(0, `${p.color}ee`); rg.addColorStop(0.35, `${p.color}66`); rg.addColorStop(1, `${p.color}00`);
        cursorCtx.fillStyle = rg;
        cursorCtx.globalAlpha = Math.min(0.35, p.life * 0.28);
        cursorCtx.beginPath(); cursorCtx.arc(p.x, p.y, Math.max(1, p.r), 0, Math.PI * 2); cursorCtx.fill();
        cursorCtx.globalAlpha = 1;
        continue;
      }

      // ========== 星尘：十字闪光 + 射线 + 星形光晕 ==========
      if (p.mode === "spark") {
        if (p.sparkFlash) {
          cursorCtx.strokeStyle = p.color;
          cursorCtx.globalAlpha = p.life * 0.65;
          cursorCtx.lineWidth = 1.4;
          cursorCtx.beginPath();
          for (let j = 0; j < 4; j++) {
            const a = (Math.PI / 4) * j;
            cursorCtx.moveTo(p.x - Math.cos(a) * p.r * 2, p.y - Math.sin(a) * p.r * 2);
            cursorCtx.lineTo(p.x + Math.cos(a) * p.r * 2, p.y + Math.sin(a) * p.r * 2);
          }
          cursorCtx.stroke();
          cursorCtx.globalAlpha = 1;
          p.r *= 1.05;
          continue;
        }
        if (p.sparkRay) {
          cursorCtx.strokeStyle = p.color;
          cursorCtx.globalAlpha = p.life * 0.58;
          cursorCtx.lineWidth = 1;
          cursorCtx.beginPath();
          cursorCtx.moveTo(p.x, p.y);
          cursorCtx.lineTo(p.x - p.vx * 3, p.y - p.vy * 3);
          cursorCtx.stroke();
          cursorCtx.globalAlpha = 1;
          continue;
        }
        if (p.burstGlow) {
          const g = cursorCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          g.addColorStop(0, `${p.color}ee`); g.addColorStop(0.4, `${p.color}66`); g.addColorStop(1, `${p.color}00`);
          cursorCtx.fillStyle = g;
          cursorCtx.globalAlpha = p.life * 0.42;
          cursorCtx.beginPath(); cursorCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2); cursorCtx.fill();
          cursorCtx.globalAlpha = 1;
          continue;
        }
        // moving spark: tiny cross
        cursorCtx.strokeStyle = p.color;
        cursorCtx.globalAlpha = p.life * 0.62;
        cursorCtx.lineWidth = 1.1;
        cursorCtx.beginPath();
        cursorCtx.moveTo(p.x - p.r * 1.8, p.y); cursorCtx.lineTo(p.x + p.r * 1.8, p.y);
        cursorCtx.moveTo(p.x, p.y - p.r * 1.8); cursorCtx.lineTo(p.x, p.y + p.r * 1.8);
        cursorCtx.stroke();
        cursorCtx.beginPath();
        cursorCtx.arc(p.x, p.y, Math.max(0.6, p.r * 0.5), 0, Math.PI * 2);
        cursorCtx.fillStyle = p.color;
        cursorCtx.globalAlpha = p.life * 0.44;
        cursorCtx.fill();
        cursorCtx.globalAlpha = 1;
        continue;
      }

      // ========== 彗尾：粗头 + 光晕 + 大粒圆 ==========
      if (p.mode === "comet") {
        if (p.ring) {
          cursorCtx.strokeStyle = p.color;
          cursorCtx.globalAlpha = p.life * 0.18;
          cursorCtx.lineWidth = 2;
          cursorCtx.beginPath(); cursorCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2); cursorCtx.stroke();
          continue;
        }
        if (p.burstGlow) {
          const g = cursorCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          g.addColorStop(0, `${p.color}ee`); g.addColorStop(0.38, `${p.color}66`); g.addColorStop(1, `${p.color}00`);
          cursorCtx.fillStyle = g;
          cursorCtx.globalAlpha = p.life * 0.44;
          cursorCtx.beginPath(); cursorCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2); cursorCtx.fill();
          cursorCtx.globalAlpha = 1;
          continue;
        }
        const cg = cursorCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, p.r));
        cg.addColorStop(0, `${p.color}${p.head ? "ff" : "cc"}`);
        cg.addColorStop(0.3, `${p.color}aa`);
        cg.addColorStop(1, `${p.color}00`);
        cursorCtx.fillStyle = cg;
        cursorCtx.globalAlpha = Math.min(0.42, p.life * 0.35);
        cursorCtx.beginPath(); cursorCtx.arc(p.x, p.y, Math.max(1, p.r), 0, Math.PI * 2); cursorCtx.fill();
        cursorCtx.globalAlpha = 1;
        continue;
      }
    }
    cursorCtx.globalCompositeOperation = "source-over";
    if (trailNodes.length > 36) trailNodes.splice(0, trailNodes.length - 36);
    const cap = mode === "classic" ? 420 : 200;
    if (cursorParticles.length > cap) cursorParticles.splice(0, cursorParticles.length - cap);
    cursorAnimId = requestAnimationFrame(animate);
  }
  animate();
}

function stopCursorParticles() {
  if (cursorAnimId) {
    cancelAnimationFrame(cursorAnimId);
    cursorAnimId = null;
  }
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
