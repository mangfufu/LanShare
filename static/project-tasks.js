(() => {
  const options = [
    { value: "not_uploaded", label: "未上传" },
    { value: "uploaded", label: "已上传" },
    { value: "needs_more", label: "待补充" },
    { value: "supplemented", label: "已补充" }
  ];
  const list = document.getElementById("taskProjectList");
  const panel = document.getElementById("taskInlinePanel");
  const count = document.getElementById("taskProjectCount");
  const expand = document.getElementById("taskExpand");
  if (!list || !panel) return;
  const views = new Set();
  let projects = [], selectedPath = null, scope = state.nsfwMode;
  let inlineView = null, modal = null, menu = null, listKey = "";

  // 悬浮框布局只保存在本浏览器，不影响其他人的位置和项目进度。
  const floating = document.getElementById("taskFloat");
  const toggle = document.getElementById("taskToggle");
  const pin = document.getElementById("taskPin");
  const minimize = document.getElementById("taskMinimize");
  const handle = document.getElementById("taskFloatHandle");
  const resize = document.getElementById("taskResize");
  const layoutKey = "lanshare-task-float-layout-v1";
  let layout = {};
  try { layout = JSON.parse(localStorage.getItem(layoutKey)) || {}; } catch {}
  if (typeof layout !== "object" || Array.isArray(layout)) layout = {};
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const workspaceBox = document.querySelector("#workspaceRail").getBoundingClientRect();
  const defaultWidth = finite(layout.width, 420);
  const defaultX = workspaceBox.width > 0 ? workspaceBox.left - defaultWidth - 12 : innerWidth - defaultWidth - 80;
  const defaultY = workspaceBox.width > 0 ? workspaceBox.top : 48;
  const hasCurrentPlacement = layout.placement === "workspace-left";
  layout = {
    x: hasCurrentPlacement ? finite(layout.x, defaultX) : defaultX,
    y: hasCurrentPlacement ? finite(layout.y, defaultY) : defaultY,
    width: defaultWidth, height: finite(layout.height, 370),
    pinned: layout.pinned === true, open: true, placement: "workspace-left"
  };
  document.querySelector("#tab-files").append(floating);
  function persistLayout() {
    try { localStorage.setItem(layoutKey, JSON.stringify(layout)); } catch {}
  }
  function positionFloat() {
    const maxWidth = Math.max(1, innerWidth - 16), maxHeight = Math.max(1, innerHeight - 16);
    layout.width = Math.max(Math.min(320, maxWidth), Math.min(layout.width, maxWidth));
    layout.height = Math.max(Math.min(230, maxHeight), Math.min(layout.height, maxHeight));
    layout.x = Math.max(8, Math.min(layout.x, innerWidth - layout.width - 8));
    layout.y = Math.max(8, Math.min(layout.y, innerHeight - layout.height - 8));
    const shownWidth = layout.open ? layout.width : Math.min(layout.width, 320);
    Object.assign(floating.style, { left: `${layout.x + layout.width - shownWidth}px`, top: `${layout.y}px`, width: `${shownWidth}px`, height: `${layout.open ? layout.height : 52}px` });
    floating.hidden = false;
    floating.dataset.collapsed = String(!layout.open);
    minimize.title = layout.open ? "收起任务表" : "展开任务表";
    minimize.setAttribute("aria-label", minimize.title);
    minimize.setAttribute("aria-expanded", String(layout.open));
    minimize.querySelector("path").setAttribute("d", layout.open ? "M5 12h14" : "M6 9l6 6 6-6");
    floating.dataset.pinned = String(layout.pinned);
    pin.setAttribute("aria-pressed", String(layout.pinned));
    pin.title = layout.pinned ? "取消固定，允许移动和缩放" : "固定位置和尺寸";
    pin.setAttribute("aria-label", pin.title);
    toggle.setAttribute("aria-expanded", String(layout.open));
  }
  function setFloatOpen(open) {
    closeMenu();
    layout.open = open;
    positionFloat(); persistLayout(); fitTabs();
    if (open) { inlineView?.refresh(); pin.focus({ preventScroll: true }); }
    else minimize.focus({ preventScroll: true });
  }
  toggle.addEventListener("click", () => setFloatOpen(!layout.open));
  minimize.addEventListener("click", () => setFloatOpen(!layout.open));
  pin.addEventListener("click", () => { layout.pinned = !layout.pinned; positionFloat(); persistLayout(); });
  let manipulation = null;
  for (const [element, resizing] of [[handle, false], [resize, true]]) {
    element.addEventListener("pointerdown", event => {
      if (layout.pinned || event.button !== 0 || (!resizing && event.target.closest("button"))) return;
      closeMenu(); event.preventDefault(); event.stopPropagation();
      manipulation = { id: event.pointerId, x: event.clientX, y: event.clientY, before: { ...layout }, resizing };
      element.setPointerCapture(event.pointerId);
      floating.classList.add("is-manipulating");
    });
    element.addEventListener("pointermove", event => {
      if (!manipulation || manipulation.id !== event.pointerId) return;
      const { before, x, y } = manipulation;
      if (resizing) {
        layout.width = Math.min(before.width + event.clientX - x, innerWidth - before.x - 8);
        layout.height = Math.min(before.height + event.clientY - y, innerHeight - before.y - 8);
      } else {
        layout.x = before.x + event.clientX - x;
        layout.y = before.y + event.clientY - y;
      }
      positionFloat();
    });
    const finish = event => {
      if (!manipulation || manipulation.id !== event.pointerId) return;
      if (event.type === "pointercancel") layout = manipulation.before;
      manipulation = null;
      floating.classList.remove("is-manipulating");
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      positionFloat(); persistLayout();
    };
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
    element.addEventListener("lostpointercapture", finish);
  }
  resize.addEventListener("keydown", event => {
    if (layout.pinned || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    layout.width += event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    layout.height += event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    positionFloat(); persistLayout();
  });
  window.addEventListener("resize", () => { positionFloat(); persistLayout(); });
  positionFloat();

  function closeMenu(restoreFocus = false) {
    if (!menu) return;
    const previous = menu;
    menu = null;
    previous.anchor.setAttribute("aria-expanded", "false");
    previous.element.remove();
    if (restoreFocus && previous.anchor.isConnected) previous.anchor.focus({ preventScroll: true });
  }

  function openMenu(anchor, host, heading, entries) {
    if (menu?.anchor === anchor) { closeMenu(); return; }
    closeMenu();
    const element = document.createElement("div");
    element.className = "task-dropdown";
    element.setAttribute("popover", "auto");
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", heading);
    const title = document.createElement("div");
    title.className = "task-dropdown-title";
    title.textContent = heading;
    element.append(title);
    for (const entry of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-dropdown-option";
      button.setAttribute("aria-pressed", String(!!entry.selected));
      if (entry.status) {
        button.dataset.taskStatus = entry.status;
        const dot = document.createElement("i");
        button.append(dot);
      }
      const label = document.createElement("span");
      label.textContent = entry.label;
      button.append(label);
      if (entry.selected) button.append(document.createTextNode(" ✓"));
      button.addEventListener("click", () => { closeMenu(true); entry.action(); });
      element.append(button);
    }
    host.append(element);
    menu = { element, anchor };
    anchor.setAttribute("aria-expanded", "true");
    element.showPopover();
    const rect = anchor.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - element.offsetWidth - 8))}px`;
    const below = rect.bottom + 6;
    element.style.top = `${Math.max(8, Math.min(below + element.offsetHeight <= innerHeight - 8 ? below : rect.top - element.offsetHeight - 6, innerHeight - element.offsetHeight - 8))}px`;
    element.addEventListener("toggle", event => {
      if (event.newState === "closed" && menu?.element === element) closeMenu();
    });
    element.addEventListener("keydown", event => {
      const buttons = [...element.querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); closeMenu(true);
      }
    });
    (element.querySelector('[aria-pressed="true"]') || element.querySelector("button"))?.focus({ preventScroll: true });
  }
  window.addEventListener("resize", () => closeMenu());
  document.addEventListener("scroll", event => {
    if (menu && !menu.element.contains(event.target)) closeMenu();
  }, true);

  function selectProject(project) {
    closeMenu();
    selectedPath = project.path;
    inlineView?.dispose();
    inlineView = createView(panel, project, true);
    panel.setAttribute("aria-label", project.name);
    renderTabs();
    inlineView.refresh();
  }

  function renderTabs() {
    list.replaceChildren();
    for (const [index, project] of projects.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-project-tab";
      button.textContent = project.name;
      button.title = project.name;
      button.dataset.path = project.path;
      button.id = `taskProjectTab${index}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "taskInlinePanel");
      button.setAttribute("aria-selected", String(project.path === selectedPath));
      button.tabIndex = project.path === selectedPath ? 0 : -1;
      if (project.path === selectedPath) panel.setAttribute("aria-labelledby", button.id);
      button.addEventListener("click", () => selectProject(project));
      button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? projects.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + projects.length) % projects.length;
        selectProject(projects[next]);
        list.querySelector('[aria-selected="true"]')?.focus();
      });
      list.append(button);
    }
    const more = document.createElement("button");
    more.className = "task-project-more";
    more.type = "button";
    more.textContent = "…";
    more.setAttribute("aria-label", "更多进行中的项目");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const hiddenPaths = [...list.querySelectorAll(".task-project-tab[hidden]")].map(b => b.dataset.path);
      openMenu(more, document.body, "更多项目", projects.filter(p => hiddenPaths.includes(p.path)).map(p => ({ label: p.name, action: () => selectProject(p) })));
    });
    list.append(more);
    fitTabs();
  }

  function fitTabs() {
    const tabs = [...list.querySelectorAll(".task-project-tab")];
    const more = list.querySelector(".task-project-more");
    if (!more || !list.clientWidth) return;
    tabs.forEach(b => { b.hidden = false; });
    const widths = tabs.map(b => b.getBoundingClientRect().width);
    const available = list.clientWidth - 28;
    more.hidden = widths.reduce((sum, w) => sum + w + 6, -6) <= available;
    if (more.hidden) return;
    const budget = available - 40;
    let used = 0;
    tabs.forEach((b, i) => { b.hidden = used + widths[i] > budget; if (!b.hidden) used += widths[i] + 6; });
    const activeIndex = tabs.findIndex(b => b.dataset.path === selectedPath);
    if (activeIndex >= 0 && tabs[activeIndex].hidden) {
      for (let i = tabs.length - 1; i >= 0 && used + widths[activeIndex] > budget; i--) {
        if (!tabs[i].hidden) { tabs[i].hidden = true; used -= widths[i] + 6; }
      }
      tabs[activeIndex].hidden = false;
    }
  }
  new ResizeObserver(() => { closeMenu(); fitTabs(); }).observe(list);

  function renderProjects() {
    const next = state.inProgressProjects || [];
    const key = JSON.stringify([state.nsfwMode, state.workspaceProjectsLoaded, can("files.write"), next.map(p => [p.path, p.name, p.status])]);
    if (key === listKey) return;
    listKey = key;
    closeMenu();
    if (scope !== state.nsfwMode) { modal?.close(); selectedPath = null; }
    scope = state.nsfwMode;
    projects = next;
    count.textContent = `${projects.length} 项`;
    expand.disabled = !projects.length;
    if (modal && !projects.some(p => p.path === modal.path)) modal.close();
    const project = projects.find(p => p.path === selectedPath) || projects[0];
    if (project) selectProject(project);
    else {
      inlineView?.dispose(); inlineView = null; selectedPath = null;
      list.replaceChildren(); panel.replaceChildren();
      panel.removeAttribute("aria-labelledby");
      const empty = document.createElement("div");
      empty.className = "workspace-empty";
      empty.textContent = state.workspaceProjectsLoaded ? "暂无进行中的项目" : "正在读取项目…";
      panel.append(empty);
    }
  }

  function createView(host, project, compact) {
    host.innerHTML = `${compact ? "" : `<form class="task-count-form"><label for="taskEpisodeCount">总集数</label><input id="taskEpisodeCount" class="field" type="number" min="1" max="1000" step="1" required /><button class="button ghost" type="submit">保存集数</button></form><div class="task-summary"></div>`}<div class="task-message" role="status" aria-live="polite">正在读取进度…</div><div class="task-episode-grid" aria-label="各集进度"></div>`;
    const form = host.querySelector("form"), input = host.querySelector("input");
    const grid = host.querySelector(".task-episode-grid"), message = host.querySelector(".task-message");
    const editable = can("files.write");
    if (form) form.hidden = !editable;
    const view = { path: project.path, nsfw: scope, data: null, saving: false, loading: false, revision: 0, countDirty: false };
    views.add(view);
    view.dispose = () => { if (menu && host.contains(menu.anchor)) closeMenu(); views.delete(view); };
    input?.addEventListener("input", () => { view.countDirty = true; });
    view.render = data => {
      view.data = data;
      if (input && !view.countDirty) input.value = data.totalEpisodes || "";
      if (grid.children.length !== data.totalEpisodes) {
        if (menu && host.contains(menu.anchor)) closeMenu();
        grid.replaceChildren();
        for (let number = 1; number <= data.totalEpisodes; number++) {
          const button = document.createElement("button");
          button.type = "button"; button.className = "task-episode-button"; button.textContent = number;
          button.disabled = !editable || view.saving;
          button.setAttribute("aria-expanded", "false");
          button.addEventListener("click", () => {
            const current = view.data.episodes[number]?.status || "not_uploaded";
            openMenu(button, compact ? document.body : host.closest("dialog"), `第 ${number} 集`, options.map(o => ({ label: o.label, status: o.value, selected: o.value === current, action: () => save({ episode: number, status: o.value }) })));
          });
          grid.append(button);
        }
      }
      const totals = Object.fromEntries(options.map(o => [o.value, 0]));
      for (let number = 1; number <= data.totalEpisodes; number++) {
        const entry = data.episodes[number];
        const status = options.some(o => o.value === entry?.status) ? entry.status : "not_uploaded";
        totals[status]++;
        const button = grid.children[number - 1];
        button.dataset.taskStatus = status;
        const label = options.find(o => o.value === status).label;
        button.setAttribute("aria-label", `第 ${number} 集，${label}`);
        button.title = `第 ${number} 集 · ${label}${entry?.updatedBy ? ` · ${entry.updatedBy}` : ""}${entry?.updatedAt ? ` · ${new Date(entry.updatedAt).toLocaleString("zh-CN")}` : ""}`;
      }
      const summary = host.querySelector(".task-summary");
      if (summary) summary.textContent = data.totalEpisodes ? `共 ${data.totalEpisodes} 集 · ${options.map(o => `${o.label} ${totals[o.value]}`).join(" / ")}` : "";
      message.textContent = data.totalEpisodes ? "" : editable ? compact ? "尚未设置集数，请点击放大后填写。" : "未识别到集数，请填写总集数。" : "项目尚未设置总集数。";
    };
    const valid = () => views.has(view) && view.nsfw === state.nsfwMode;
    view.refresh = async () => {
      if (!valid() || view.loading || view.saving || [...views].some(v => v.path === view.path && v.nsfw === view.nsfw && v.saving)) return;
      view.loading = true;
      const revision = view.revision;
      try {
        const response = await fetch(`/api/project-tasks?path=${encodeURIComponent(view.path)}${view.nsfw ? "&nsfw=1" : ""}`, { cache: "no-store" });
        const data = await parseJsonResponse(response);
        if (!valid() || revision !== view.revision) return;
        if (!response.ok) throw new Error(data.error || "读取任务进度失败");
        view.render(data);
      } catch (error) {
        if (valid() && revision === view.revision) message.textContent = `${error.message}，稍后自动重试。`;
      } finally { view.loading = false; }
    };
    async function save(change) {
      if (!valid() || view.saving || !editable) return;
      for (const other of views) if (other.path === view.path && other.nsfw === view.nsfw) other.revision++;
      view.saving = true;
      host.querySelectorAll("button").forEach(b => { b.disabled = true; });
      message.textContent = "保存中…";
      try {
        const response = await apiFetch("/api/project-tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: view.path, ...change }) });
        const data = await parseJsonResponse(response);
        if (!response.ok) throw new Error(data.error || "保存失败");
        if (change.totalEpisodes !== undefined) view.countDirty = false;
        for (const other of views) {
          if (other.path === view.path && other.nsfw === view.nsfw) { other.revision++; other.render(data); }
        }
      } catch (error) {
        if (valid()) message.textContent = `保存失败：${error.message}`;
      } finally {
        view.saving = false;
        host.querySelectorAll("button").forEach(b => { b.disabled = !editable; });
      }
    }
    form?.addEventListener("submit", event => { event.preventDefault(); save({ totalEpisodes: Number(input.value) }); });
    return view;
  }

  function openTasks() {
    const project = projects.find(p => p.path === selectedPath);
    if (!project) return;
    closeMenu(); modal?.close();
    const dialog = document.createElement("dialog");
    dialog.id = "episodeTaskDialog";
    dialog.className = "preview-dialog form-dialog";
    dialog.setAttribute("aria-labelledby", "episodeTaskTitle");
    dialog.innerHTML = `<div class="preview-header"><div><div class="label">任务表</div><div id="episodeTaskTitle" class="preview-title"></div></div><button type="button" class="button ghost" data-close>关闭</button></div><div class="task-legend">${options.map(o => `<span><i data-task-status="${o.value}"></i>${o.label}</span>`).join("")}</div><div class="episode-task-body"></div>`;
    dialog.querySelector("#episodeTaskTitle").textContent = project.name;
    const view = createView(dialog.querySelector(".episode-task-body"), project, false);
    const entry = { path: project.path, close() { closeMenu(); view.dispose(); closeDialog(dialog); dialog.remove(); if (modal === entry) modal = null; } };
    modal = entry;
    dialog.querySelector("[data-close]").addEventListener("click", entry.close);
    dialog.addEventListener("cancel", event => { event.preventDefault(); if (menu) closeMenu(true); else entry.close(); });
    let backdropDown = false;
    dialog.addEventListener("pointerdown", event => { backdropDown = event.target === dialog; });
    dialog.addEventListener("click", event => { if (event.target === dialog && backdropDown) entry.close(); });
    document.body.append(dialog); showDialog(dialog);
    if (inlineView?.data) view.render(inlineView.data);
    view.refresh();
  }
  expand.addEventListener("click", openTasks);
  function refreshVisible() {
    if (document.visibilityState !== "visible") return;
    for (const view of views) if (view !== inlineView || (!modal && panel.getBoundingClientRect().width)) view.refresh();
  }
  window.addEventListener("workspace-projects-updated", renderProjects);
  window.addEventListener("focus", refreshVisible);
  document.addEventListener("visibilitychange", refreshVisible);
  setInterval(refreshVisible, 3000);
  renderProjects();
})();
