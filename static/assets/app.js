"use strict";
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const nsfw = query.get("nsfw") === "1";
const THEME_KEY = "lan_file_server_theme";
const THEME_POS_KEY = "lan_file_server_theme_pos";
function applyTheme(theme, persist = false) {
  const value = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = value;
  document.body.style.colorScheme = value;
  $("themeButton").title =
    value === "dark" ? "切换到日间模式" : "切换到夜间模式";
  $("themeButton").setAttribute("aria-label", $("themeButton").title);
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, value);
      localStorage.setItem(THEME_POS_KEY, value === "dark" ? "100" : "0");
    } catch {}
  }
}
function readTheme() {
  try {
    const position = localStorage.getItem(THEME_POS_KEY);
    return position !== null
      ? Number(position) >= 50
        ? "dark"
        : "light"
      : localStorage.getItem(THEME_KEY);
  } catch {
    return "light";
  }
}
applyTheme(readTheme());
$("themeButton").addEventListener("click", () =>
  applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark", true),
);
window.addEventListener("storage", (event) => {
  if ([THEME_KEY, THEME_POS_KEY].includes(event.key) || event.key === null)
    applyTheme(readTheme());
});
const state = {
  user: null,
  csrf: "",
  category: "",
  discarded: false,
  offset: 0,
  total: 0,
  staged: [],
  uploading: false,
  detail: null,
  stateId: "",
  existing: null,
  listSequence: 0,
  detailSequence: 0,
  projects: [],
  selectedFiles: new Set(),
  detailBusy: false,
  selectedAssets: new Set(),
  listItems: [],
  listBusy: false,
  listLoading: false,
};
const can = (permission) =>
  state.user?.permissions?.some((p) => p === "*" || p === permission);
function node(tag, content, className) {
  const n = document.createElement(tag);
  if (content != null) n.textContent = content;
  if (className) n.className = className;
  return n;
}
function button(label, action, className) {
  const b = node("button", label, className);
  b.type = "button";
  b.addEventListener("click", () =>
    Promise.resolve().then(action).catch(report),
  );
  return b;
}
function placeNotifications() {
  const container = $("notifications");
  const host =
    [...document.querySelectorAll("dialog:modal")].at(-1) || document.body;
  if (container.parentElement === host) return;
  const notices = [...container.children];
  notices.forEach((n) => {
    if (n.matches(":popover-open")) n.hidePopover();
  });
  host.append(container);
  notices.forEach((n) => n.showPopover?.());
}
const notificationHostObserver = new MutationObserver(placeNotifications);
document.querySelectorAll("dialog").forEach((dialog) =>
  notificationHostObserver.observe(dialog, {
    attributes: true,
    attributeFilter: ["open"],
  }),
);
function notice(message, error = false, action = null) {
  const n = node("div", null, `notice${error ? " error" : ""}`);
  n.append(
    node("span", message),
    button("×", () => n.remove()),
  );
  n.lastChild.setAttribute("aria-label", "关闭通知");
  if (action) {
    const undo = button(
      action.label,
      async () => {
        undo.disabled = true;
        try {
          await action.run();
          n.remove();
        } catch (error) {
          undo.disabled = false;
          throw error;
        }
      },
      "notice-action",
    );
    n.insertBefore(undo, n.lastChild);
  }
  // Keep actions inside the active modal's subtree so they are not made inert.
  placeNotifications();
  n.setAttribute("popover", "manual");
  $("notifications").append(n);
  if (n.showPopover) {
    n.showPopover();
    n.style.cssText = `position:fixed;inset:auto 18px auto auto;top:${18 + ($("notifications").children.length - 1) * 80}px;margin:0;width:min(380px,calc(100vw - 36px));`;
  }
  if (!error) setTimeout(() => n.remove(), action ? 8000 : 4500);
}
function report(error) {
  if (error?.name !== "AbortError")
    notice(error?.message || "操作失败，请重试", true);
}
function apiUrl(route, params = {}) {
  const p = new URLSearchParams(params);
  if (nsfw) p.set("nsfw", "1");
  return `/api/assets/${route}${p.size ? "?" + p : ""}`;
}
async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("服务器返回异常，请刷新后重试");
  }
  if (!response.ok) {
    if (response.status === 401) {
      const session = await fetch("/api/auth/session")
        .then((r) => r.json())
        .catch(() => null);
      if (!session?.authenticated)
        location.href =
          "/login?next=" +
          encodeURIComponent(location.pathname + location.search);
    }
    throw Object.assign(
      new Error(result.error || `请求失败 (${response.status})`),
      result,
      { status: response.status },
    );
  }
  return result;
}
const get = (route, params) => request(apiUrl(route, params));
const post = (route, body) =>
  request(apiUrl(route), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
    body: JSON.stringify(body),
  });
function formatSize(size) {
  return size < 1048576
    ? `${(size / 1024).toFixed(0)} KB`
    : `${(size / 1048576).toFixed(1)} MB`;
}
function tags(value) {
  return [
    ...new Set(
      value
        .split(/[,，;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
function fillSelect(select, values, blank) {
  select.replaceChildren();
  if (blank != null) select.append(new Option(blank, ""));
  values.forEach((v) =>
    select.append(
      new Option(
        typeof v === "string" ? v : v.name,
        typeof v === "string" ? v : v.id,
      ),
    ),
  );
}
async function metadata() {
  const data = await get("meta");
  state.tags = [...new Set([...(data.presetTags || []), ...data.tags])];
  state.presetTagsByCategory = data.presetTagsByCategory || {};
  state.tagsByCategory = data.tagsByCategory || {};
  const currentTag = $("tagFilter").value;
  fillSelect($("tagFilter"), data.tags, "全部标签");
  $("tagFilter").value = currentTag;
  if (!$("categories").children.length) {
    for (const category of ["", ...data.categories]) {
      const b = button(category || "全部", async () => {
        state.category = category;
        state.offset = 0;
        await loadList();
      });
      b.dataset.category = category;
      $("categories").append(b);
    }
    fillSelect($("assetCategory"), data.categories, "请选择分类");
    fillSelect($("editCategory"), data.categories);
  }
  renderFormTags("assetTags");
  renderFormTags("editTags");
}
function categoryTags(category) {
  return [...new Set([...(state.presetTagsByCategory?.[category] || []), ...(state.tagsByCategory?.[category] || [])])];
}
function renderFormTags(id) {
  const host = $(id + "Picker"), input = $(id);
  const category = $(id === "assetTags" ? "assetCategory" : "editCategory").value;
  const selected = tags(input.value);
  const expanded = host.querySelector("details")?.open || false;
  host.replaceChildren();
  const chips = node("div", null, "form-tag-chips");
  const change = (tag) => {
    const values = tags(input.value);
    input.value = (values.includes(tag) ? values.filter((t) => t !== tag) : [...values, tag]).join(", ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  for (const tag of selected) {
    const chip = button(tag + " ×", () => change(tag), "tag");
    chip.setAttribute("aria-label", "移除标签：" + tag);
    chips.append(chip);
  }
  const details = node("details");
  details.open = expanded;
  details.append(node("summary", category ? `选择${category}标签` : "先选择分类"));
  const options = node("div", null, "form-tag-options");
  for (const tag of categoryTags(category)) {
    const option = button(tag, () => change(tag));
    option.setAttribute("aria-pressed", String(selected.includes(tag)));
    option.disabled = !selected.includes(tag) && selected.length >= 30;
    options.append(option);
  }
  details.append(options);
  host.append(chips, details);
}
function cover(file) {
  if (file?.kind === "image") {
    const img = node("img");
    img.src = apiUrl("thumb", { id: file.id });
    img.loading = "lazy";
    img.alt = file.name;
    img.addEventListener(
      "error",
      () => img.replaceWith(node("div", "预览不可用", "media-placeholder")),
      { once: true },
    );
    return img;
  }
  return node(
    "div",
    file?.kind === "audio"
      ? "音频"
      : file?.kind === "video"
        ? "视频"
        : "暂无可用文件",
    "media-placeholder",
  );
}
function player(file, staged = false) {
  const media = node(file.kind === "audio" ? "audio" : "video");
  media.src = apiUrl(staged ? "staged-media" : "media", { id: file.id });
  media.controls = true;
  media.preload = "none";
  media.setAttribute("controlslist", "nodownload");
  media.disablePictureInPicture = true;
  media.addEventListener("play", () =>
    document.querySelectorAll("audio,video").forEach((other) => {
      if (other !== media) other.pause();
    }),
  );
  media.addEventListener(
    "error",
    () => {
      media.insertAdjacentElement(
        "afterend",
        node("span", "浏览器无法播放此格式", "muted"),
      );
    },
    { once: true },
  );
  return media;
}
async function loadList() {
  if ($("tagPicker").matches(":popover-open")) $("tagPicker").hidePopover();
  const sequence = ++state.listSequence;
  const previousPageIds = state.renderedOffset === state.offset ? state.listItems.map((item) => item.id) : [];
  const selectionKey = JSON.stringify([state.category, state.discarded, $("search").value.trim(), $("tagFilter").value]);
  if (state.listSelectionKey !== selectionKey) state.selectedAssets.clear();
  state.listSelectionKey = selectionKey;
  state.listLoading = true;
  updateListSelection();
  $("emptyState").hidden = false;
  $("emptyState").textContent = "正在读取资产…";
  $("assetGrid").setAttribute("aria-busy", "true");
  document
    .querySelectorAll("#categories button")
    .forEach((b) =>
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.category === state.category),
      ),
    );
  $("activeTab").setAttribute("aria-pressed", String(!state.discarded));
  $("discardedTab").setAttribute("aria-pressed", String(state.discarded));
  try {
    const result = await get("list", {
      q: $("search").value.trim(),
      category: state.category,
      tag: $("tagFilter").value,
      discarded: state.discarded ? "1" : "0",
      offset: state.offset,
    });
    if (sequence !== state.listSequence) return;
    if (
      !result.items.length &&
      state.offset > 0 &&
      result.total <= state.offset
    ) {
      state.offset = Math.max(0, Math.floor((result.total - 1) / 48) * 48);
      return loadList();
    }
    state.total = result.total;
    state.listItems = result.items;
    state.listSelectionIds = result.selectionIds;
    if (result.selectionIds) {
      const matchingIds = new Set(result.selectionIds);
      for (const id of state.selectedAssets) if (!matchingIds.has(id)) state.selectedAssets.delete(id);
    }
    state.renderedOffset = state.offset;
    const returnedIds = new Set(result.items.map((item) => item.id));
    if (!result.selectionIds)
      previousPageIds.forEach((id) => { if (!returnedIds.has(id)) state.selectedAssets.delete(id); });
    $("assetGrid").replaceChildren();
    for (const asset of result.items) {
      const card = node("article", null, "asset-card");
      card.dataset.assetId = asset.id;
      const toggleCard = () => {
        if (!can("files.write") || state.listBusy || state.listLoading) return;
        if (state.selectedAssets.has(asset.id)) state.selectedAssets.delete(asset.id);
        else {
          if (state.selectedAssets.size >= 1000) return notice("一次最多选择 1000 条资产", true);
          state.selectedAssets.add(asset.id);
        }
        updateListSelection();
      };
      card.addEventListener("click", (event) => {
        if (!event.target.closest("button,a,input,label,audio,video")) toggleCard();
      });
      if (can("files.write")) {
        const label = node("label", null, "asset-check");
        const checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.setAttribute("aria-label", `选择资产：${asset.name}`);
        checkbox.addEventListener("change", () => {
          if (state.listBusy || state.listLoading) {
            checkbox.checked = state.selectedAssets.has(asset.id);
            return;
          }
          if (checkbox.checked) {
            if (state.selectedAssets.size >= 1000) {
              checkbox.checked = false;
              return notice("一次最多选择 1000 条资产", true);
            }
            state.selectedAssets.add(asset.id);
          }
          else state.selectedAssets.delete(asset.id);
          updateListSelection();
        });
        label.append(checkbox);
        card.append(label);
      }
      const imageButton = button(
        "",
        () => can("files.write") ? toggleCard() : openDetail(asset.id),
        "cover-button",
      );
      imageButton.setAttribute("aria-label", `${can("files.write") ? "选择" : "查看"} ${asset.name}`);
      imageButton.title = can("files.write") ? "单击选择，双击查看" : "查看资产";
      imageButton.addEventListener("dblclick", () => openDetail(asset.id).catch(report));
      imageButton.append(cover(asset.cover));
      const info = node("div", null, "asset-info");
      info.append(
        button(asset.name, () => openDetail(asset.id), "asset-title"),
      );
      info.append(
        node(
          "div",
          [
            asset.category,
            `${asset.fileCount} 个文件`,
            asset.discarded ? "已弃用" : asset.hasDiscarded ? "含弃用内容" : "",
          ]
            .filter(Boolean)
            .join(" · "),
          "asset-caption",
        ),
      );
      if (asset.project)
        info.append(node("div", asset.project, "asset-caption"));
      const tagList = cardTags(asset);
      if (tagList.children.length) info.append(tagList);
      if (asset.cover?.kind === "audio") info.append(player(asset.cover));
      card.append(imageButton, info);
      $("assetGrid").append(card);
    }
    $("emptyState").hidden = !!result.items.length;
    $("emptyState").textContent = state.discarded
      ? "暂无弃用素材"
      : "暂无匹配的资产";
    $("resultCount").textContent = `${result.total} 条资产`;
    $("pageNumber").textContent =
      `${Math.floor(state.offset / 48) + 1} / ${Math.max(1, Math.ceil(result.total / 48))}`;
    $("previousPage").disabled = state.offset === 0;
    $("nextPage").disabled = state.offset + 48 >= result.total;
  } catch (error) {
    if (sequence !== state.listSequence) return;
    $("assetGrid").replaceChildren();
    state.listItems = [];
    $("emptyState").replaceChildren(
      node("p", error.message),
      button("重试", loadList),
    );
    throw error;
  } finally {
    if (sequence === state.listSequence) {
      state.listLoading = false;
      updateListSelection();
      $("assetGrid").removeAttribute("aria-busy");
    }
  }
}
function updateListSelection() {
  $("listSelection").hidden = !can("files.write");
  $("listSelectedCount").textContent = `已选 ${state.selectedAssets.size} 条`;
  const visibleSelected = state.listItems.filter((item) => state.selectedAssets.has(item.id)).length;
  if (visibleSelected < state.selectedAssets.size)
    $("listSelectedCount").textContent += `（本页 ${visibleSelected} 条）`;
  $("listDiscard").hidden = state.discarded;
  $("listRestore").hidden = !state.discarded;
  $("listDelete").hidden = !state.discarded || !can("*");
  const busy = state.listBusy || state.listLoading;
  for (const id of ["listSelectAll", "listInvert"])
    $(id).disabled = busy || !state.listItems.length;
  for (const id of ["listClear", "listDiscard", "listRestore", "listDelete"])
    $(id).disabled = busy || !state.selectedAssets.size;
  $("assetGrid")
    .querySelectorAll(".asset-card")
    .forEach((card) => {
      const selected = state.selectedAssets.has(card.dataset.assetId);
      card.classList.toggle("is-selected", selected);
      const checkbox = card.querySelector(".asset-check input");
      if (checkbox) {
        checkbox.checked = selected;
        checkbox.disabled = busy;
      }
    });
}
function cardTags(asset) {
  const list = node("div", null, "tag-list");
  asset.tags.forEach((tag) => list.append(node("span", tag, "tag")));
  if (can("files.write")) {
    const add = button("+", () => openTagPicker(asset, add), "tag-add");
    add.title = "添加标签";
    add.setAttribute("aria-label", `添加标签：${asset.name}`);
    add.setAttribute("aria-controls", "tagPicker");
    add.setAttribute("aria-haspopup", "dialog");
    list.append(add);
  }
  return list;
}
function positionTagPicker() {
  if (!$("tagPicker").matches(":popover-open") || !state.tagAnchor?.isConnected) return;
  const anchor = state.tagAnchor.getBoundingClientRect();
  const panel = $("tagPicker").getBoundingClientRect();
  $("tagPicker").style.left = Math.max(12, Math.min(anchor.left, innerWidth - panel.width - 12)) + "px";
  const top = anchor.bottom + panel.height + 8 <= innerHeight - 12
    ? anchor.bottom + 8 : anchor.top - panel.height - 8;
  $("tagPicker").style.top = Math.max(12, Math.min(top, innerHeight - panel.height - 12)) + "px";
}
function renderTagOptions() {
  const asset = state.tagAsset;
  if (!asset) return;
  const selected = new Set(asset.tags);
  const keyword = $("quickTagInput").value.trim().toLowerCase();
  $("quickTagOptions").replaceChildren();
  for (const tag of [...new Set([...categoryTags(asset.category), ...asset.tags])]) {
    if (keyword && !tag.toLowerCase().includes(keyword)) continue;
    const option = button(tag, () => addQuickTags([tag]));
    option.setAttribute("aria-pressed", String(selected.has(tag)));
    option.disabled = state.tagBusy || selected.has(tag);
    option.title = selected.has(tag) ? "已添加" : "添加标签";
    $("quickTagOptions").append(option);
  }
  $("quickTagInput").disabled = !!state.tagBusy;
  $("quickTagAdd").disabled = !!state.tagBusy || !keyword;
  positionTagPicker();
}
function openTagPicker(asset, anchor) {
  if (state.tagBusy || state.listBusy || !can("files.write")) return;
  state.tagAsset = asset;
  state.tagAnchor = anchor;
  $("tagPickerName").textContent = asset.name;
  $("quickTagInput").value = "";
  $("quickTagError").hidden = true;
  renderTagOptions();
  if (!$("tagPicker").matches(":popover-open")) $("tagPicker").showPopover();
  positionTagPicker();
  $("quickTagInput").focus({ preventScroll: true });
}
async function addQuickTags(values) {
  if (state.tagBusy || !state.tagAsset) return;
  const asset = state.tagAsset;
  if (!values.length) return;
  state.tagBusy = true;
  $("quickTagError").hidden = true;
  renderTagOptions();
  try {
    const result = await post("add-tags", { id: asset.id, tags: values });
    asset.tags = result.tags;
    const listed = state.listItems.find((item) => item.id === asset.id);
    if (listed) listed.tags = result.tags;
    const card = $("assetGrid").querySelector(`[data-asset-id="${CSS.escape(asset.id)}"]`);
    if (card) {
      card.querySelector(".tag-list").replaceWith(cardTags(asset));
      state.tagAnchor = card.querySelector(".tag-add");
    }
    $("quickTagInput").value = "";
    await metadata().catch(report);
  } catch (error) {
    $("quickTagError").textContent = error.message;
    $("quickTagError").hidden = false;
  } finally {
    state.tagBusy = false;
    renderTagOptions();
    if ($("tagPicker").matches(":popover-open")) $("quickTagInput").focus({ preventScroll: true });
  }
}
function selectList(mode) {
  if (!can("files.write") || state.listBusy || state.listLoading) return;
  if (mode === "clear") state.selectedAssets.clear();
  else {
    if (!state.listSelectionIds) return notice("筛选结果超过 1000 条，请缩小筛选范围后再全选或反选", true);
    const next = new Set(state.selectedAssets);
    for (const id of state.listSelectionIds) {
      if (mode === "invert" && next.has(id)) next.delete(id);
      else next.add(id);
    }
    if (next.size > 1000) return notice("一次最多选择 1000 条资产，请减少选择", true);
    state.selectedAssets = next;
  }
  updateListSelection();
}
async function batchListAction(action) {
  if (state.listBusy || state.listLoading || !state.selectedAssets.size) return;
  const ids = [...state.selectedAssets];
  state.listBusy = true;
  updateListSelection();
  try {
    if (
      action === "delete" &&
      !(await confirmAction(
        "批量彻底删除",
        `将永久删除所选 ${ids.length} 条资产中的弃用内容；仍在使用的内容保留。此操作无法撤销，确认删除？`,
      ))
    )
      return;
    const result = await post(action === "delete" ? "delete" : "lifecycle", {
      kind: "assets",
      ids,
      discarded: action === "discard",
      restoreContents: action === "restore",
    });
    ids.forEach((id) => state.selectedAssets.delete(id));
    await loadList();
    const message =
      action === "discard"
        ? `已弃用 ${ids.length} 条资产`
        : action === "restore"
          ? `已恢复 ${ids.length} 条资产中的弃用内容`
          : result.pendingCleanup
            ? "已删除弃用内容，文件清理将在后台重试"
            : "已删除所选弃用内容";
    notice(
      message,
      false,
      action === "discard" && result.changedIds.length
        ? {
            label: "撤销",
            run: async () => {
              await post("lifecycle", {
                kind: "assets",
                ids: result.changedIds,
                discarded: false,
              });
              await loadList();
              notice("已撤销批量弃用");
            },
          }
        : null,
    );
  } finally {
    state.listBusy = false;
    updateListSelection();
  }
}
async function confirmAction(title, message) {
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = message;
  const dialog = $("confirmDialog");
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "yes"),
      { once: true },
    ),
  );
}
async function openDetail(id, preserveState = false, targetStateId = "") {
  const sequence = ++state.detailSequence;
  const data = await get("detail", { id });
  if (sequence !== state.detailSequence) return;
  state.detail = data;
  if (!preserveState) {
    state.stateId = targetStateId;
    state.selectedFiles.clear();
    $("showDiscarded").checked = state.discarded || data.discarded;
  }
  renderDetail();
  if (!$("detailDialog").open) $("detailDialog").showModal();
}
function detailTarget() {
  const a = state.detail;
  const s = a.states.find((s) => s.id === state.stateId);
  return {
    body: { kind: "files", id: a.id, ids: [...state.selectedFiles] },
    rows: s?.files.filter((f) => state.selectedFiles.has(f.id)) || [],
    inherited: !!(a.discarded || s?.discarded),
    label: `选中的 ${state.selectedFiles.size} 个文件`,
  };
}
async function refreshAfterDetailAction(assetId) {
  if ($("detailDialog").open && state.detail?.id === assetId) {
    const data = await get("detail", { id: assetId });
    if ($("detailDialog").open && state.detail?.id === assetId) {
      state.detail = data;
      renderDetail();
    }
  }
  await loadList();
}
async function changeLifecycle(target, discarded) {
  if (state.detailBusy) return;
  const assetId = state.detail.id;
  state.detailBusy = true;
  renderDetailActions();
  try {
    await post("lifecycle", { ...target.body, discarded });
    if (target.body.kind === "asset" && state.detail?.id === assetId)
      $("showDiscarded").checked = discarded;
    await refreshAfterDetailAction(assetId);
    notice(
      `${target.label}${discarded ? "已弃用" : "已恢复"}`,
      false,
      discarded
        ? {
            label: "撤销",
            run: async () => {
              if (state.detailBusy)
                throw new Error("请等待当前操作完成后再撤销");
              state.detailBusy = true;
              renderDetailActions();
              try {
                await post("lifecycle", { ...target.body, discarded: false });
                if (
                  target.body.kind === "asset" &&
                  state.detail?.id === assetId
                )
                  $("showDiscarded").checked = false;
                await refreshAfterDetailAction(assetId);
                notice("已撤销弃用");
              } finally {
                state.detailBusy = false;
                renderDetailActions();
              }
            },
          }
        : null,
    );
  } finally {
    state.detailBusy = false;
    if (state.detail?.id === assetId) renderDetailActions();
  }
}
function renderDetailActions() {
  $("stateActions").querySelectorAll("button").forEach((el) => {
    el.disabled = state.detailBusy;
  });
  const selection = $("detailSelection");
  selection.hidden = !can("files.download") && !can("files.write");
  $("detailSelectedCount").textContent =
    `已选 ${state.selectedFiles.size} 个文件`;
  for (const id of ["detailSelectAll", "detailInvert", "detailClear"])
    $(id).disabled = state.detailBusy;
  const actions = $("detailActions");
  actions.replaceChildren();
  const a = state.detail;
  if (can("files.write")) {
    actions.append(button("编辑信息", () => openEdit("asset")));
    if (!a.discarded && a.category !== "音频")
      actions.append(button("追加素材", () => openIntake(a)));
  }
  actions.append(selection);
  if (!can("files.download") && !can("files.write")) return;
  const s = a.states.find((s) => s.id === state.stateId);
  const target = detailTarget();
  const valid = target.rows.length > 0;
  const discarded = valid && target.rows.every((row) => row.discarded);
  const unavailable =
    target.inherited || target.rows.some((row) => row.discarded);
  const add = (text, fn, disabled, className) => {
    const b = button(text, fn, className);
    b.disabled = !valid || disabled;
    b.title = `${text}：${target.label}`;
    actions.append(b);
  };
  if (can("files.download")) {
    add(
      "下载",
      () => {
        const body = target.body;
        const single = body.kind === "files" && body.ids.length === 1;
        const params = new URLSearchParams({
          kind: body.kind,
          id: single ? body.ids[0] : body.id,
        });
        if (!single) body.ids?.forEach((id) => params.append("file", id));
        const link = node("a");
        link.href = apiUrl(single ? "download-file" : "download", params);
        link.download = "";
        document.body.append(link);
        link.click();
        link.remove();
      },
      unavailable,
    );
  }
  if (can("files.write")) {
    if (a.category !== "音频") {
      const move = button("移动到状态", () => openMoveState());
      move.id = "moveFiles";
      move.disabled = !state.selectedFiles.size || a.discarded || !s ||
        s.discarded || s.files.some((f) => state.selectedFiles.has(f.id) && f.discarded) ||
        !a.states.some((destination) => !destination.discarded && destination.id !== s.id);
      move.title = "将选中文件移动到此资产的其他状态";
      actions.append(move);
    }
    add("复制到目录", () => openCopy(target.body), unavailable);
    add(
      discarded ? "恢复" : "弃用",
      () => changeLifecycle(target, !discarded),
      target.inherited,
    );
  }
  if (can("*") && valid && (discarded || target.inherited)) {
    add(
      "彻底删除",
      async () => {
        if (state.detailBusy) return;
        state.detailBusy = true;
        renderDetailActions();
        try {
          if (
            !(await confirmAction(
              "彻底删除",
              `将删除${target.label}及其文件，无法恢复。确认删除？`,
            ))
          )
            return;
          const result = await post("delete", target.body);
          if (target.body.kind === "asset") {
            $("detailDialog").close();
            await loadList();
          } else await refreshAfterDetailAction(a.id);
          notice(
            result.pendingCleanup
              ? "已删除，文件清理将在后台重试"
              : "已彻底删除",
          );
        } finally {
          state.detailBusy = false;
          renderDetailActions();
        }
      },
      false,
      "danger",
    );
  }
  if (state.detailBusy)
    document.querySelectorAll("#detailActions button, #detailActions select, #stateActions button").forEach((el) => {
      el.disabled = true;
    });
}
function renderDetail() {
  const a = state.detail;
  const edit = can("files.write");
  $("detailName").textContent = a.name;
  $("detailCategory").textContent =
    `${a.category}${a.discarded ? " · 已弃用" : ""}`;
  $("detailMeta").replaceChildren();
  if (a.project) $("detailMeta").append(node("span", `来源项目：${a.project}`));
  a.tags.forEach((t) => $("detailMeta").append(node("span", t, "tag")));
  $("detailMeta").append(
    node(
      "span",
      `${a.updatedBy} · ${new Date(a.updatedAt).toLocaleString("zh-CN")}`,
    ),
  );
  $("discardedSwitch").hidden = !edit;
  const showDiscarded = edit && $("showDiscarded").checked;
  const states = a.states.filter((s) =>
    showDiscarded
      ? a.discarded || s.discarded || s.files.some((f) => f.discarded)
      : !s.discarded && !a.discarded,
  );
  let selectedState = states.find((s) => s.id === state.stateId) || states[0];
  state.stateId = selectedState?.id || "";
  $("stateTabs").replaceChildren();
  for (const s of states) {
    const b = button(a.category === "音频" ? "音频" : s.name, () => {
      state.stateId = s.id;
      state.selectedFiles.clear();
      renderDetail();
    });
    b.setAttribute("aria-pressed", String(s.id === state.stateId));
    $("stateTabs").append(b);
  }
  $("stateActions").replaceChildren();
  if (edit && !a.discarded && a.category !== "音频") {
    const add = button("添加状态", () => openEdit("new-state"));
    add.id = "addState";
    add.disabled = state.detailBusy;
    $("stateActions").append(add);
  }
  $("fileGallery").replaceChildren();
  $("promptBox").hidden = true;
  const visibleIds = new Set(
    (selectedState?.files || [])
      .filter((f) =>
        showDiscarded
          ? a.discarded || selectedState.discarded || f.discarded
          : !f.discarded,
      )
      .map((f) => f.id),
  );
  for (const id of state.selectedFiles)
    if (!visibleIds.has(id)) state.selectedFiles.delete(id);
  renderDetailActions();
  if (!selectedState) {
    $("fileGallery").append(
      node("p", showDiscarded ? "没有弃用内容" : "没有可用状态", "muted"),
    );
    return;
  }
  const s = selectedState;
  if (edit) {
    const editState = button(a.category === "音频" ? "编辑提示词" : "编辑状态与提示词", () => openEdit("state"));
    editState.disabled = state.detailBusy;
    $("stateActions").append(editState);
    if (!s.files.length && a.category !== "音频" && !a.discarded) {
      const lifecycle = button(s.discarded ? "恢复空状态" : "弃用空状态", () => changeLifecycle({
        body: { kind: "state", id: s.id },
        label: `空状态“${s.name}”`,
      }, !s.discarded));
      lifecycle.disabled = state.detailBusy;
      $("stateActions").append(lifecycle);
    }
  }
  if (s.prompt) {
    $("promptBox").hidden = false;
    $("promptText").textContent = s.prompt;
  }
  const files = s.files.filter((f) =>
    showDiscarded ? a.discarded || s.discarded || f.discarded : !f.discarded,
  );
  if (!files.length)
    $("fileGallery").append(node("p", "此状态没有文件", "muted"));
  for (const f of files) {
    const item = node("section", null, "file-item");
    item.dataset.fileId = f.id;
    const discarded = a.discarded || s.discarded || f.discarded;
    if (f.kind === "image") {
      const img = node("img");
      img.src = apiUrl("thumb", { id: f.id });
      img.alt = f.name;
      img.loading = "lazy";
      img.tabIndex = 0;
      const preview = () => openImagePreview(files.filter((file) => file.kind === "image").map((file) => ({ name: file.name, src: apiUrl("media", { id: file.id }) })), apiUrl("media", { id: f.id }));
      img.title = edit || can("files.download") ? "单击选择，双击预览" : "预览";
      img.onclick = () => {
        const checkbox = item.querySelector("input[type=checkbox]");
        if (checkbox) checkbox.click();
        else preview();
      };
      img.ondblclick = preview;
      img.onkeydown = (e) => {
        if (e.key === "Enter") preview();
      };
      img.onerror = () => {
        img.alt = "预览加载失败，双击查看原图";
      };
      item.append(img);
    } else item.append(player(f));
    item.append(node("p", f.name), node("small", formatSize(f.size)));
    if (discarded) item.append(node("span", " · 已弃用", "discarded-mark"));
    const controls = node("div", null, "action-bar");
    if (edit || can("files.download")) {
      const label = node("label", null, "file-selection");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selectedFiles.has(f.id);
      item.classList.toggle("is-selected", checkbox.checked);
      checkbox.setAttribute("aria-label", `选择文件：${f.name}`);
      checkbox.dataset.fileId = f.id;
      checkbox.addEventListener("change", () => {
        if (state.detailBusy) {
          checkbox.checked = state.selectedFiles.has(f.id);
          return;
        }
        if (checkbox.checked) {
          if (state.selectedFiles.size >= 64) {
            checkbox.checked = false;
            notice("一次最多选择 64 个文件", true);
            return;
          }
          state.selectedFiles.add(f.id);
        } else state.selectedFiles.delete(f.id);
        item.classList.toggle("is-selected", checkbox.checked);
        renderDetailActions();
      });
      label.append(checkbox, node("span", "选择"));
      controls.append(label);
    }
    if (edit && !discarded && f.kind === "image")
      controls.append(
        button("设为封面", async () => {
          await post("cover", { id: f.id });
          await openDetail(a.id, true);
          await loadList();
          notice("封面已更新");
        }),
      );
    item.append(controls);
    item.addEventListener("click", (event) => {
      if (event.target.closest("button,input,label,img,video,audio,a")) return;
      item.querySelector("input[type=checkbox]")?.click();
    });
    $("fileGallery").append(item);
  }
}
function renderStagedPreview(force = false) {
  const preview = $("stagedPreview");
  const file =
    state.staged.find((f) => f.id === state.stagedPreviewId) || state.staged[0];
  state.stagedPreviewId = file?.id || "";
  if (!force && preview.dataset.fileId === state.stagedPreviewId) return;
  preview.querySelectorAll("audio,video").forEach((media) => {
    media.pause();
    media.removeAttribute("src");
    media.load();
  });
  preview.replaceChildren();
  preview.dataset.fileId = state.stagedPreviewId;
  if (!file) {
    preview.append(node("span", "选择或拖入图片、视频、音频", "muted"));
    return;
  }
  if (file.kind !== "image") {
    const media = player(file, true);
    media.preload = "metadata";
    preview.append(media);
    return;
  }
  const img = node("img");
  img.src = apiUrl("staged-thumb", { id: file.id });
  img.alt = file.name;
  img.title = "查看原图";
  img.tabIndex = 0;
  const enlarge = () => openImagePreview(state.staged.filter((f) => f.kind === "image").map((f) => ({ name: f.name, src: apiUrl("staged-media", { id: f.id }) })), apiUrl("staged-media", { id: file.id }));
  img.onclick = enlarge;
  img.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      enlarge();
    }
  };
  img.onerror = () => {
    if (state.stagedPreviewId === file.id)
      preview.replaceChildren(
        node("span", "预览加载失败"),
        button("重试", () => renderStagedPreview(true)),
      );
  };
  preview.append(img);
}
function openImagePreview(items, src) {
  state.previewItems = items;
  state.previewIndex = Math.max(0, items.findIndex((item) => item.src === src));
  renderImagePreview();
  if (!$("previewDialog").open) $("previewDialog").showModal();
}
function renderImagePreview() {
  const file = state.previewItems?.[state.previewIndex];
  if (!file) return;
  $("previewName").textContent = file.name;
  $("previewImage").alt = file.name;
  $("previewStatus").textContent = "正在加载…";
  $("previewImage").onload = () => { $("previewStatus").textContent = ""; };
  $("previewImage").onerror = () => { $("previewStatus").textContent = "图片加载失败，请切换后重试"; };
  $("previewImage").src = file.src;
  $("previewPrevious").disabled = state.previewIndex === 0;
  $("previewNext").disabled = state.previewIndex >= state.previewItems.length - 1;
  $("previewPosition").textContent = `${state.previewIndex + 1} / ${state.previewItems.length}`;
}
function stepImagePreview(direction) {
  const next = state.previewIndex + direction;
  if (next < 0 || next >= (state.previewItems?.length || 0)) return;
  state.previewIndex = next;
  renderImagePreview();
}
function renderStaged() {
  $("chooseSource").disabled = state.uploading || state.committing;
  $("chooseLocal").disabled = state.uploading || state.committing;
  renderStagedPreview();
  $("stagedList").replaceChildren(
    ...state.staged.map((f) => {
      const li = node("li");
      const select = button(
        "",
        () => {
          state.stagedPreviewId = f.id;
          renderStaged();
        },
        "staged-select",
      );
      select.setAttribute(
        "aria-pressed",
        String(state.stagedPreviewId === f.id),
      );
      select.setAttribute("aria-label", `预览：${f.name}`);
      if (f.kind === "image") {
        const img = node("img");
        img.src = apiUrl("staged-thumb", { id: f.id });
        img.alt = "";
        img.loading = "lazy";
        img.onerror = () => img.replaceWith(node("span", "图片"));
        select.append(img);
      }
      select.append(node("span", `${f.name} · ${formatSize(f.size)}`));
      const remove = button("移除", async () => {
        if (state.committing) return;
        remove.disabled = true;
        try {
          await post("cancel-upload", { files: [f.id] });
          state.staged = state.staged.filter((x) => x.id !== f.id);
          renderStaged();
        } finally {
          remove.disabled = false;
        }
      });
      remove.disabled = !!state.committing;
      li.append(select, remove);
      return li;
    }),
  );
  $("commitButton").disabled = state.uploading || !state.staged.length;
  $("mergeLabel").hidden =
    state.staged.length < 2 || $("assetCategory").value === "音频";
}
function showDuplicates(items) {
  $("duplicates").hidden = !items.length;
  $("duplicateLinks").replaceChildren();
  $("allowDuplicates").checked = false;
  items.forEach((a) => {
    const link = node("a", a.name + (a.discarded ? "（已弃用）" : ""));
    const p = new URLSearchParams({ id: a.id });
    if (nsfw) p.set("nsfw", "1");
    link.href = "/assets?" + p;
    link.target = "_blank";
    link.rel = "noopener";
    $("duplicateLinks").append(link);
  });
}
async function receiveStage(result) {
  if (!$("intakeDialog").open) {
    await post("cancel-upload", { files: result.files.map((f) => f.id) });
    return;
  }
  state.staged.push(...result.files);
  if (!$("assetName").value && state.staged[0])
    $("assetName").value = state.staged[0].name.replace(/\.[^.]+$/, "");
  if (state.staged.every((f) => f.kind === "audio"))
    $("assetCategory").value = "音频";
  else if ($("assetCategory").value === "音频") $("assetCategory").value = "";
  renderFormTags("assetTags");
  if (result.duplicates.length) showDuplicates(result.duplicates);
  renderStaged();
  updateIntake();
}
async function uploadFiles(files) {
  if (state.uploading || state.committing || !files.length) return;
  if (files.length + state.staged.length > 64)
    throw new Error("一次最多存入 64 个文件");
  state.uploading = true;
  renderStaged();
  $("uploadProgress").hidden = false;
  $("uploadStatus").textContent = "正在上传…";
  try {
    const data = new FormData();
    Array.from(files).forEach((f) => data.append("files", f));
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.uploadRequest = xhr;
      xhr.open("POST", apiUrl("upload"));
      xhr.setRequestHeader("X-CSRF-Token", state.csrf);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          $("uploadProgress").value = (100 * e.loaded) / e.total;
          $("uploadStatus").textContent =
            e.loaded === e.total
              ? "正在校验文件…"
              : `上传中 ${Math.round((100 * e.loaded) / e.total)}%`;
        }
      };
      xhr.onload = () => {
        try {
          const result = JSON.parse(xhr.responseText);
          xhr.status === 200
            ? resolve(result)
            : reject(new Error(result.error || "上传失败"));
        } catch {
          reject(new Error("上传响应异常"));
        }
      };
      xhr.onerror = () => reject(new Error("上传失败，请检查网络"));
      xhr.onabort = () => reject(new DOMException("已取消上传", "AbortError"));
      xhr.send(data);
    });
    await receiveStage(result);
    $("uploadStatus").textContent = `已准备 ${state.staged.length} 个文件`;
  } finally {
    state.uploading = false;
    state.uploadRequest = null;
    $("uploadProgress").hidden = true;
    $("uploadFiles").value = "";
    renderStaged();
  }
}
const sourcePicker = {
  selected: new Map(),
  dir: "",
  offset: 0,
  total: 0,
  sequence: 0,
  busy: false,
  loading: false,
  items: [],
};
function workspaceUrl(route, params = {}) {
  const p = new URLSearchParams(params);
  if (nsfw) p.set("nsfw", "1");
  return `/api/${route}?${p}`;
}
function sourceImageUrl(path) {
  return "/file?" + new URLSearchParams({ path, ...(nsfw ? { nsfw: "1" } : {}) });
}
function updateSourceSelection() {
  $("sourceCount").textContent = `已选 ${sourcePicker.selected.size} 个`;
  $("sourceConfirm").disabled =
    sourcePicker.busy || !sourcePicker.selected.size;
  $("sourceClear").disabled = sourcePicker.busy || !sourcePicker.selected.size;
  for (const id of ["sourceSelectAll", "sourceInvert"])
    $(id).disabled = sourcePicker.busy || sourcePicker.loading;
}
async function browseSource(dir, offset = 0) {
  const sequence = ++sourcePicker.sequence;
  sourcePicker.dir = dir;
  sourcePicker.offset = offset;
  sourcePicker.loading = true;
  sourcePicker.items = [];
  updateSourceSelection();
  $("sourceList").replaceChildren();
  $("sourceStatus").textContent = "正在读取目录…";
  $("sourcePrevious").disabled = true;
  $("sourceNext").disabled = true;
  const parts = dir.split("/").filter(Boolean);
  $("sourcePath").replaceChildren(button("文件管理", () => browseSource("")));
  parts.forEach((part, i) =>
    $("sourcePath").append(
      button(part, () => browseSource(parts.slice(0, i + 1).join("/"))),
    ),
  );
  try {
    const result = await request(
      workspaceUrl("list", { dir, offset, limit: 50 }),
    );
    if (sequence !== sourcePicker.sequence || !$("sourceDialog").open) return;
    sourcePicker.total = result.total;
    $("sourceStatus").textContent = result.items.length ? "" : "此目录为空";
    for (const item of result.items) {
      const directory = item.type === "directory";
      const supported =
        /\.(png|jpe?g|webp|gif|avif|tiff?|mp4|webm|mov|mp3|wav|ogg|m4a|flac|aac)$/i.test(
          item.name,
        );
      const row = directory
        ? button("", () => browseSource(item.path), "source-row")
        : node("label", null, "source-row");
      if (directory) {
        row.append(node("span"), node("span", "目录", "source-kind"));
      } else {
        const checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.disabled = !supported;
        checkbox.checked = sourcePicker.selected.has(item.path);
        checkbox.dataset.sourcePath = item.path;
        if (supported) sourcePicker.items.push(item);
        checkbox.setAttribute("aria-label", item.name);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            if (sourcePicker.selected.size + state.staged.length >= 64) {
              checkbox.checked = false;
              notice("一次最多存入 64 个文件", true);
              return;
            }
            sourcePicker.selected.set(item.path, item);
          } else sourcePicker.selected.delete(item.path);
          updateSourceSelection();
        });
        row.append(checkbox);
        if (item.previewType === "image") {
          const img = node("img");
          img.src = workspaceUrl("thumb", { path: item.path });
          img.alt = "";
          img.loading = "lazy";
          img.onerror = () =>
            img.replaceWith(node("span", "图片", "source-kind"));
          const preview = node("button", null, "source-preview");
          preview.type = "button";
          preview.title = "预览图片";
          preview.setAttribute("aria-label", `预览：${item.name}`);
          preview.append(img);
          preview.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openImagePreview(result.items.filter((f) => f.type !== "directory" && f.previewType === "image")
              .map((f) => ({ name: f.name, src: sourceImageUrl(f.path) })), sourceImageUrl(item.path));
          });
          row.append(preview);
        } else
          row.append(
            node(
              "span",
              item.previewType === "audio"
                ? "音频"
                : item.previewType === "video"
                  ? "视频"
                  : "文件",
              "source-kind",
            ),
          );
      }
      row.append(
        node("span", item.name),
        node(
          "small",
          directory ? "进入" : supported ? formatSize(item.size) : "不支持",
        ),
      );
      $("sourceList").append(row);
    }
    $("sourcePage").textContent =
      `${Math.floor(offset / 50) + 1} / ${Math.max(1, Math.ceil(result.total / 50))}`;
    $("sourcePrevious").disabled = offset === 0;
    $("sourceNext").disabled = offset + 50 >= result.total;
  } catch (error) {
    if (sequence !== sourcePicker.sequence || !$("sourceDialog").open) return;
    $("sourceStatus").replaceChildren(
      node("span", error.message),
      button("重试", () => browseSource(dir, offset)),
    );
    $("sourcePage").textContent = "";
  } finally {
    if (sequence === sourcePicker.sequence) {
      sourcePicker.loading = false;
      updateSourceSelection();
    }
  }
}
function selectSource(mode) {
  if (sourcePicker.busy || (sourcePicker.loading && mode !== "clear")) return;
  const next = new Map(sourcePicker.selected);
  if (mode === "clear") next.clear();
  else
    for (const item of sourcePicker.items) {
      if (mode === "invert" && next.has(item.path)) next.delete(item.path);
      else next.set(item.path, item);
    }
  if (next.size + state.staged.length > 64) {
    notice("一次最多存入 64 个文件，请减少选择", true);
    return;
  }
  sourcePicker.selected = next;
  $("sourceList")
    .querySelectorAll("input[data-source-path]")
    .forEach((input) => {
      input.checked = next.has(input.dataset.sourcePath);
    });
  updateSourceSelection();
}
function selectDetail(mode) {
  if (state.detailBusy || (!can("files.write") && !can("files.download")))
    return;
  const inputs = [...$("fileGallery").querySelectorAll("input[data-file-id]")];
  const next = mode === "clear" ? new Set() : new Set(state.selectedFiles);
  if (mode !== "clear")
    for (const input of inputs) {
      if (mode === "invert" && next.has(input.dataset.fileId))
        next.delete(input.dataset.fileId);
      else next.add(input.dataset.fileId);
    }
  if (next.size > 64) {
    notice("一次最多选择 64 个文件，请减少选择", true);
    return;
  }
  state.selectedFiles = next;
  inputs.forEach((input) => {
    input.checked = next.has(input.dataset.fileId);
    input.closest(".file-item").classList.toggle("is-selected", input.checked);
  });
  renderDetailActions();
}
async function openSourcePicker() {
  if (state.uploading || state.committing) return;
  sourcePicker.selected.clear();
  updateSourceSelection();
  $("sourceDialog").showModal();
  await browseSource(sourcePicker.dir);
}
async function importSources(paths) {
  if (state.projectRequest) await state.projectRequest;
  if (!$("intakeDialog").open) return;
  if (state.uploading || state.committing || !paths.length) return;
  if (paths.length + state.staged.length > 64)
    throw new Error("一次最多存入 64 个文件");
  state.uploading = true;
  renderStaged();
  $("uploadStatus").textContent = "正在独立保存来源文件…";
  try {
    await receiveStage(await post("import", { paths }));
    if (!$("intakeDialog").open) return;
    const projects = new Set(
      paths.map((p) => {
        const normalized = p.replaceAll("\\", "/");
        return (
          state.projects
            .filter((project) => normalized.startsWith(project.path + "/"))
            .sort((a, b) => b.path.length - a.path.length)[0]?.name || ""
        );
      }),
    );
    if (!$("assetProject").value && projects.size === 1) {
      $("assetProject").value = [...projects][0];
      syncProjectChoice("assetProject");
    }
    $("uploadStatus").textContent = `已准备 ${state.staged.length} 个文件`;
  } catch (error) {
    $("uploadStatus").textContent = "来源文件读取失败，请重试";
    throw error;
  } finally {
    state.uploading = false;
    renderStaged();
  }
}
async function confirmSources() {
  if (sourcePicker.busy) return;
  sourcePicker.busy = true;
  updateSourceSelection();
  $("sourceDialog").close();
  try {
    await importSources([...sourcePicker.selected.keys()]);
  } finally {
    sourcePicker.busy = false;
    updateSourceSelection();
  }
}
async function findExisting() {
  const result = await get("list", { q: $("existingSearch").value });
  fillSelect(
    $("existingAsset"),
    result.items.filter((a) => a.category !== "音频"),
    "请选择资产",
  );
  $("existingAsset").title =
    result.total > 48 ? "只显示前 48 条，请输入更具体的名称" : "";
}
async function selectExisting() {
  const id = $("existingAsset").value;
  const existing = id ? await get("detail", { id }) : null;
  if (id !== $("existingAsset").value) return;
  state.existing = existing;
  fillSelect(
    $("existingState"),
    (state.existing?.states || []).filter((s) => !s.discarded),
    "新建状态",
  );
  updateIntake();
}
function updateIntake() {
  const existing = $("intakeMode").value === "existing";
  const audio = !existing && $("assetCategory").value === "音频";
  $("newFields").hidden = existing;
  $("existingFields").hidden = !existing;
  $("assetName").required = !existing;
  $("assetCategory").required = !existing;
  $("stateNameLabel").hidden =
    audio || (existing && !!$("existingState").value);
  $("intakePromptLabel").hidden = existing && !!$("existingState").value;
  if (audio) $("mergeFiles").checked = false;
  renderStaged();
}
function syncProjectChoice(id, preserveCustom = false) {
  const custom = preserveCustom && $(id + "Choice").value === "custom";
  const value = $(id).value;
  const names = [...new Set(state.projects.map((p) => p.name))];
  fillSelect(
    $(id + "Choice"),
    [
      ...names.map((name) => ({ id: "project:" + name, name })),
      { id: "custom", name: "自定义" },
    ],
    "不填写",
  );
  $(id + "Choice").value = custom
    ? "custom"
    : !value
      ? ""
      : names.includes(value)
        ? "project:" + value
        : "custom";
  $(id + "Custom").hidden = $(id + "Choice").value !== "custom";
}
async function loadProjects() {
  if (state.projectRequest) return state.projectRequest;
  state.projectRequest = (async () => {
    try {
      state.projects = (await get("projects")).items;
    } catch (error) {
      notice("项目列表读取失败，仍可选择自定义填写：" + error.message, true);
    }
    syncProjectChoice("assetProject", true);
    syncProjectChoice("editProject", true);
  })().finally(() => {
    state.projectRequest = null;
  });
  return state.projectRequest;
}
async function openIntake(existing = null) {
  if (state.uploading || state.committing) return;
  $("intakeForm").reset();
  $("assetCategory").value = state.category;
  renderFormTags("assetTags");
  state.staged = [];
  state.stagedPreviewId = "";
  state.existing = null;
  $("uploadStatus").textContent = "";
  showDuplicates([]);
  updateIntake();
  renderStaged();
  syncProjectChoice("assetProject");
  if (existing) {
    $("intakeMode").value = "existing";
    fillSelect($("existingAsset"), [existing]);
    await selectExisting();
    if (
      state.stateId &&
      state.existing.states.some((s) => s.id === state.stateId && !s.discarded)
    )
      $("existingState").value = state.stateId;
    updateIntake();
  }
  state.intakeBaseline = formSnapshot("intakeForm");
  $("intakeDialog").showModal();
  await loadProjects();
}
async function submitIntake(event) {
  event.preventDefault();
  if (state.uploading || state.committing) return;
  const existing = $("intakeMode").value === "existing";
  if (existing && !$("existingAsset").value) throw new Error("请选择已有资产");
  if (!$("duplicates").hidden && !$("allowDuplicates").checked)
    throw new Error("请先确认重复素材是否仍要存入");
  const body = {
    files: state.staged.map((f) => f.id),
    name: $("assetName").value,
    category: $("assetCategory").value,
    tags: tags($("assetTags").value),
    project: $("assetProject").value,
    prompt: $("intakePrompt").value,
    stateName: $("stateName").value,
    merge: $("mergeFiles").checked,
    allowDuplicates: $("allowDuplicates").checked,
    assetId: existing ? $("existingAsset").value : undefined,
    stateId: existing ? $("existingState").value : undefined,
  };
  state.committing = true;
  $("commitButton").disabled = true;
  try {
    const result = await post("commit", body);
    state.staged = [];
    $("intakeDialog").close();
    await metadata();
    await loadList();
    notice(`已存入 ${result.ids.length} 条资产`);
    if (result.ids.length === 1) await openDetail(result.ids[0], false, result.stateIds?.[0] || body.stateId || "");
  } catch (error) {
    if (error.duplicates) showDuplicates(error.duplicates);
    throw error;
  } finally {
    state.committing = false;
    renderStaged();
  }
}
async function openEdit(kind) {
  if (state.detailBusy) return;
  state.editKind = kind;
  const a = state.detail,
    s = a.states.find((s) => s.id === state.stateId);
  $("editTitle").textContent =
    kind === "asset" ? "编辑资产" : kind === "new-state" ? "添加状态" : "编辑状态与提示词";
  $("editAssetFields").hidden = kind !== "asset";
  $("editPromptLabel").hidden = kind === "asset";
  $("editName").maxLength = kind === "asset" ? 160 : 100;
  $("editName").value = kind === "asset" ? a.name : kind === "new-state" ? "" : s.name;
  $("editCategory").value = a.category;
  $("editProject").value = a.project;
  $("editTags").value = a.tags.join(", ");
  renderFormTags("editTags");
  $("editPrompt").value = kind === "new-state" ? "" : s?.prompt || "";
  syncProjectChoice("editProject");
  state.editBaseline = formSnapshot("editForm");
  $("editDialog").showModal();
  if (kind === "asset") await loadProjects();
}
async function submitEdit(event) {
  event.preventDefault();
  if (state.detailBusy) return;
  const submit = event.submitter;
  submit.disabled = true;
  state.detailBusy = true;
  try {
    const a = state.detail;
    const body =
      state.editKind === "asset"
        ? {
            id: a.id,
            name: $("editName").value,
            category: $("editCategory").value,
            project: $("editProject").value,
            tags: tags($("editTags").value),
            revision: a.revision,
          }
        : {
            id: state.editKind === "new-state" ? a.id : state.stateId,
            name: $("editName").value,
            prompt: $("editPrompt").value,
            revision: a.revision,
          };
    const result = await post(state.editKind === "asset" ? "edit" : state.editKind === "new-state" ? "create-state" : "state", body);
    $("editDialog").close();
    const moveToNew = state.editKind === "new-state" && state.selectedFiles.size > 0 &&
      !a.states.find((item) => item.id === state.stateId)?.discarded &&
      !a.states.flatMap((item) => item.files).some((f) => state.selectedFiles.has(f.id) && f.discarded);
    if (state.editKind === "new-state" && !moveToNew) {
      state.stateId = result.id;
      $("showDiscarded").checked = false;
    }
    await openDetail(a.id, true);
    await metadata();
    await loadList();
    notice("已保存");
    if (moveToNew) openMoveState(result.id);
  } finally {
    submit.disabled = false;
    state.detailBusy = false;
    renderDetail();
  }
}
function openMoveState(preferredId = "") {
  const a = state.detail;
  const destinations = a.states.filter((s) => !s.discarded && s.id !== state.stateId);
  if (!state.selectedFiles.size || !destinations.length) return;
  state.moveTarget = {
    id: a.id,
    ids: [...state.selectedFiles],
    revision: a.revision,
  };
  fillSelect($("moveStateTarget"), destinations);
  if (destinations.some((s) => s.id === preferredId)) $("moveStateTarget").value = preferredId;
  $("moveStateSummary").textContent = `已选 ${state.selectedFiles.size} 个文件`;
  $("moveStateDialog").showModal();
}
async function submitMoveState(event) {
  event.preventDefault();
  if (state.detailBusy) return;
  const body = { ...state.moveTarget, stateId: $("moveStateTarget").value };
  const submit = event.submitter;
  submit.disabled = true;
  state.detailBusy = true;
  try {
    const destinationName = $("moveStateTarget").selectedOptions[0].textContent;
    await post("move-files", body);
    $("moveStateDialog").close();
    state.stateId = body.stateId;
    state.selectedFiles.clear();
    await refreshAfterDetailAction(body.id);
    notice(`已将 ${body.ids.length} 个文件移到“${destinationName}”`);
  } finally {
    submit.disabled = false;
    state.detailBusy = false;
    renderDetail();
  }
}
async function openCopy(target) {
  if (state.copyBusy) return;
  state.copyTarget = target;
  state.folder = null;
  $("copyConflicts").hidden = true;
  $("copyDialog").showModal();
  await browseFolder("");
}
async function browseFolder(folder) {
  if (state.copyBusy) return;
  const sequence = (state.folderSequence || 0) + 1;
  state.folderSequence = sequence;
  state.folder = null;
  $("copyConfirm").disabled = true;
  $("folderPath").textContent = "/" + folder;
  $("folderUp").disabled = true;
  $("folderList").replaceChildren(node("p", "正在读取目录…", "muted"));
  try {
    const result = await get("directories", { path: folder });
    if (sequence !== state.folderSequence || !$("copyDialog").open) return;
    state.folder = result.path;
    $("folderPath").textContent = "/" + result.path;
    $("folderUp").disabled = !result.path;
    $("folderList").replaceChildren();
    $("copyConflicts").hidden = true;
    result.directories.forEach((name) =>
      $("folderList").append(
        button("▸ " + name, () =>
          browseFolder([state.folder, name].filter(Boolean).join("/")),
        ),
      ),
    );
    if (!result.directories.length)
      $("folderList").append(
        node("p", "没有子目录，可复制到当前目录", "muted"),
      );
    $("copyConfirm").disabled = false;
  } catch (error) {
    if (sequence !== state.folderSequence || !$("copyDialog").open) return;
    $("folderList").replaceChildren(node("p", error.message), button("重试", () => browseFolder(folder)));
    $("folderUp").disabled = !folder;
  }
}
async function submitCopy() {
  if (state.copyBusy || state.folder === null) return;
  state.copyBusy = true;
  $("copyConfirm").disabled = true;
  const body = { ...state.copyTarget, destination: state.folder };
  try {
    let result;
    try {
      result = await post("copy", body);
    } catch (error) {
      if (!error.conflicts) throw error;
      $("copyConflicts").hidden = false;
      $("copyConflicts").textContent =
        "同名文件：" + error.conflicts.join("、");
      if (
        !(await confirmAction(
          "确认覆盖同名文件",
          `有 ${error.conflicts.length} 个同名文件。确认后覆盖并开始复制；取消则不复制任何文件。`,
        ))
      )
        return;
      result = await post("copy", { ...body, overwrite: true });
    }
    $("copyDialog").close();
    notice(`已复制 ${result.count} 个文件到 /${body.destination}`);
  } finally {
    state.copyBusy = false;
    $("copyConfirm").disabled = state.folder === null;
  }
}
function bind(id, event, action) {
  $(id).addEventListener(event, (e) => {
    if (event === "submit") e.preventDefault();
    Promise.resolve()
      .then(() => action(e))
      .catch(report);
  });
}
function formSnapshot(id) {
  return JSON.stringify([...$(id).querySelectorAll("input,select,textarea")]
    .filter((field) => field.type !== "file")
    .map((field) => [field.id, field.type === "checkbox" ? field.checked : field.value]));
}
async function requestClose(id) {
  if (state.closePending || (id === "intakeDialog" && state.committing) ||
      (["editDialog", "moveStateDialog", "detailDialog"].includes(id) && state.detailBusy) ||
      (id === "copyDialog" && state.copyBusy)) return;
  const dirty = id === "intakeDialog"
    ? state.uploading || state.staged.length || formSnapshot("intakeForm") !== state.intakeBaseline
    : id === "editDialog" && formSnapshot("editForm") !== state.editBaseline;
  if (dirty) {
    state.closePending = true;
    try {
      if (!(await confirmAction("放弃未保存内容？", "尚未保存的填写内容和待入库文件将被清除。确认放弃？"))) return;
    } finally { state.closePending = false; }
  }
  $(id).close();
}
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => requestClose(b.dataset.close).catch(report)),
);
for (const id of ["intakeDialog", "editDialog", "moveStateDialog", "copyDialog", "detailDialog"]) {
  $(id).addEventListener("cancel", (event) => {
    event.preventDefault();
    requestClose(id).catch(report);
  });
}
bind("searchForm", "submit", (e) => {
  e.preventDefault();
  state.offset = 0;
  return loadList();
});
bind("resetSearch", "click", () => {
  $("search").value = "";
  $("tagFilter").value = "";
  state.category = "";
  state.offset = 0;
  return loadList();
});
bind("tagFilter", "change", () => {
  state.offset = 0;
  return loadList();
});
bind("activeTab", "click", () => {
  state.discarded = false;
  state.offset = 0;
  return loadList();
});
bind("discardedTab", "click", () => {
  state.discarded = true;
  state.offset = 0;
  return loadList();
});
bind("previousPage", "click", () => {
  state.offset = Math.max(0, state.offset - 48);
  return loadList();
});
bind("nextPage", "click", () => {
  state.offset += 48;
  return loadList();
});
bind("addAsset", "click", () => openIntake());
bind("showDiscarded", "change", () => {
  renderDetail();
});
bind("copyPrompt", "click", async () => {
  await navigator.clipboard.writeText($("promptText").textContent);
  notice("提示词已复制");
});
bind("uploadFiles", "change", (e) => uploadFiles(e.target.files));
bind("chooseLocal", "click", () => $("uploadFiles").click());
bind("chooseSource", "click", openSourcePicker);
bind("sourceConfirm", "click", confirmSources);
bind("sourcePrevious", "click", () =>
  browseSource(sourcePicker.dir, Math.max(0, sourcePicker.offset - 50)),
);
bind("sourceNext", "click", () =>
  browseSource(sourcePicker.dir, sourcePicker.offset + 50),
);
bind("sourceClear", "click", () => selectSource("clear"));
for (const [id, fn] of [
  ["list", selectList],
  ["detail", selectDetail],
  ["source", selectSource],
]) {
  bind(id + "SelectAll", "click", () => fn("all"));
  bind(id + "Invert", "click", () => fn("invert"));
  if (id !== "source") bind(id + "Clear", "click", () => fn("clear"));
}
bind("listDiscard", "click", () => batchListAction("discard"));
bind("listRestore", "click", () => batchListAction("restore"));
bind("listDelete", "click", () => batchListAction("delete"));
document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.altKey || event.defaultPrevented) return;
  const target = event.target;
  if (target.closest("#tagPicker")) return;
  if (
    target.closest(
      "textarea,select,[contenteditable]:not([contenteditable=false])",
    ) ||
    (target.tagName === "INPUT" &&
      !["checkbox", "radio", "button"].includes(target.type))
  )
    return;
  const modal = [...document.querySelectorAll("dialog:modal")].at(-1);
  if (modal?.id === "previewDialog" && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    stepImagePreview(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  const context =
    modal?.id === "sourceDialog"
      ? [selectSource, sourcePicker.selected.size]
      : modal?.id === "detailDialog"
        ? [selectDetail, state.selectedFiles.size]
        : !modal && can("files.write")
          ? [selectList, state.selectedAssets.size]
          : null;
  if (!context) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    context[0](event.shiftKey ? "invert" : "all");
  } else if (event.key === "Escape" && context[1]) {
    event.preventDefault();
    context[0]("clear");
  }
});
$("sourceDialog").addEventListener("close", () => {
  sourcePicker.sequence++;
});
bind("assetCategory", "change", () => { updateIntake(); renderFormTags("assetTags"); });
bind("editCategory", "change", () => renderFormTags("editTags"));
for (const id of ["assetProject", "editProject"]) {
  bind(id + "Choice", "change", () => {
    const choice = $(id + "Choice").value;
    $(id + "Custom").hidden = choice !== "custom";
    if (choice !== "custom")
      $(id).value = choice.startsWith("project:") ? choice.slice(8) : "";
    else {
      $(id).value = "";
      $(id).focus();
    }
  });
}
for (const id of ["assetTags", "editTags"]) {
  $(id).addEventListener("input", () => renderFormTags(id));
  $(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $(id).value = tags($(id).value).join(", ");
      renderFormTags(id);
    }
  });
}
bind("intakeMode", "change", async () => {
  updateIntake();
  if ($("intakeMode").value === "existing") await findExisting();
});
bind("findExisting", "click", findExisting);
bind("existingAsset", "change", selectExisting);
bind("existingState", "change", updateIntake);
$("existingSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    findExisting().catch(report);
  }
});
$("intakeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  submitIntake(e).catch(report);
});
$("editForm").addEventListener("submit", (e) => {
  e.preventDefault();
  submitEdit(e).catch(report);
});
$("moveStateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  submitMoveState(e).catch(report);
});
bind("folderUp", "click", () =>
  browseFolder($("folderPath").textContent.slice(1).split("/").slice(0, -1).join("/")),
);
bind("previewPrevious", "click", () => stepImagePreview(-1));
bind("tagPickerClose", "click", () => $("tagPicker").hidePopover());
bind("quickTagInput", "input", renderTagOptions);
bind("quickTagForm", "submit", () => addQuickTags(tags($("quickTagInput").value)));
window.addEventListener("resize", positionTagPicker);
window.addEventListener("scroll", positionTagPicker, true);
bind("previewNext", "click", () => stepImagePreview(1));
$("copyDialog").addEventListener("close", () => { state.folderSequence = (state.folderSequence || 0) + 1; });
window.addEventListener("beforeunload", (event) => {
  if (state.uploading || state.committing || state.detailBusy || state.copyBusy ||
      ($("intakeDialog").open && (state.staged.length || formSnapshot("intakeForm") !== state.intakeBaseline)) ||
      ($("editDialog").open && formSnapshot("editForm") !== state.editBaseline)) {
    event.preventDefault();
    event.returnValue = "";
  }
});
bind("copyConfirm", "click", submitCopy);
for (const type of ["dragenter", "dragover"])
  $("dropzone").addEventListener(type, (e) => {
    e.preventDefault();
    $("dropzone").classList.add("drag-over");
  });
$("dropzone").addEventListener("dragleave", () =>
  $("dropzone").classList.remove("drag-over"),
);
$("dropzone").addEventListener("drop", (e) => {
  e.preventDefault();
  $("dropzone").classList.remove("drag-over");
  uploadFiles(e.dataTransfer.files).catch(report);
});
$("intakeDialog").addEventListener("close", () => {
  state.uploadRequest?.abort();
  const ids = state.staged.map((f) => f.id);
  state.staged = [];
  renderStagedPreview();
  if (ids.length) post("cancel-upload", { files: ids }).catch(report);
});
$("detailDialog").addEventListener("close", () =>
  $("detailDialog")
    .querySelectorAll("video,audio")
    .forEach((p) => p.pause()),
);
$("previewDialog").addEventListener("close", () =>
  $("previewImage").removeAttribute("src"),
);
async function init() {
  const session = await request("/api/auth/session");
  if (!session.authenticated) {
    location.replace(
      "/login?next=" + encodeURIComponent(location.pathname + location.search),
    );
    return;
  }
  state.user = session.user;
  state.csrf = (await request("/api/security")).csrfToken;
  $("account").textContent = `${state.user.name} · ${state.user.roleLabel}`;
  $("addAsset").hidden = !can("files.write");
  $("discardedTab").hidden = !can("files.write");
  $("scopeLabel").hidden = !nsfw;
  if (nsfw)
    document.querySelector("nav a[aria-current]").href = "/assets?nsfw=1";
  await metadata();
  await loadList();
  if (query.get("id")) await openDetail(query.get("id"));
  if (query.has("source") && can("files.write")) {
    await openIntake();
    await importSources([query.get("source")]);
    const next = new URL(location.href);
    next.searchParams.delete("source");
    history.replaceState(null, "", next);
  }
}
init().catch((error) => {
  report(error);
  $("emptyState").hidden = false;
  $("emptyState").replaceChildren(
    node("p", "资产库暂时无法加载"),
    button("重新加载", () => location.reload()),
  );
});
