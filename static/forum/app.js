const THEME_KEY = "lan_file_server_theme";
const THEME_POS_KEY = "lan_file_server_theme_pos";
const FORUM_REACTION_EMOJIS = [
  "😀", "😄", "😂", "🤣", "😊", "🥰",
  "😍", "😅", "😭", "😢", "😮", "😱",
  "😡", "🤬", "🤔", "🙄", "👍", "👎",
  "👏", "🙏", "💪", "❤️", "💔", "🔥",
  "🎉", "💯", "👀", "✅", "❌", "🤝"
];
const state = {
  user: null,
  permissions: [],
  csrfToken: "",
  categories: [],
  posts: [],
  total: 0,
  hasMore: false,
  offset: 0,
  limit: 20,
  sort: "active",
  query: "",
  category: "",
  filter: "all",
  activePost: null,
  replies: [],
  repliesTotal: 0,
  repliesLoaded: 0,
  repliesHasMore: false,
  replyTarget: null,
  editingPost: null,
  eventRefreshTimer: null
};
let forumEventSource = null;
let postDraftTimer = null;
let replyDraftTimer = null;

const forumListView = document.querySelector("#forumListView");
const forumDetailView = document.querySelector("#forumDetailView");
const postList = document.querySelector("#postList");
const resultSummary = document.querySelector("#resultSummary");
const loadMorePostsButton = document.querySelector("#loadMorePosts");
const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#searchInput");
const sortTabs = document.querySelector("#sortTabs");
const categoryNav = document.querySelector("#categoryNav");
const newPostButton = document.querySelector("#newPostButton");
const accountBadge = document.querySelector("#accountBadge");
const postDetail = document.querySelector("#postDetail");
const replyList = document.querySelector("#replyList");
const replyCountLabel = document.querySelector("#replyCountLabel");
const loadMoreRepliesButton = document.querySelector("#loadMoreReplies");
const replyForm = document.querySelector("#replyForm");
const replyContent = document.querySelector("#replyContent");
const replyTarget = document.querySelector("#replyTarget");
const clearReplyTargetButton = document.querySelector("#clearReplyTarget");
const replyIdentityHint = document.querySelector("#replyIdentityHint");
const backToListButton = document.querySelector("#backToListButton");
const postEditorDialog = document.querySelector("#postEditorDialog");
const postEditorForm = document.querySelector("#postEditorForm");
const postEditorTitle = document.querySelector("#postEditorTitle");
const postTitleInput = document.querySelector("#postTitleInput");
const postCategoryInput = document.querySelector("#postCategoryInput");
const postContentInput = document.querySelector("#postContentInput");
const pollPostLabel = document.querySelector("#pollPostLabel");
const pollPostInput = document.querySelector("#pollPostInput");
const pollEditor = document.querySelector("#pollEditor");
const pollQuestionInput = document.querySelector("#pollQuestionInput");
const pollOptionList = document.querySelector("#pollOptionList");
const addPollOptionButton = document.querySelector("#addPollOptionButton");
const pollDurationInput = document.querySelector("#pollDurationInput");
const pollCustomDuration = document.querySelector("#pollCustomDuration");
const pollCustomDurationValue = document.querySelector("#pollCustomDurationValue");
const pollCustomDurationUnit = document.querySelector("#pollCustomDurationUnit");
const anonymousPostLabel = document.querySelector("#anonymousPostLabel");
const anonymousPostInput = document.querySelector("#anonymousPostInput");
const postEditorMessage = document.querySelector("#postEditorMessage");
const closePostEditorButton = document.querySelector("#closePostEditor");
const confirmDialog = document.querySelector("#confirmDialog");
const confirmTitle = document.querySelector("#confirmTitle");
const confirmMessage = document.querySelector("#confirmMessage");
const confirmCancel = document.querySelector("#confirmCancel");
const confirmAccept = document.querySelector("#confirmAccept");
const reactionPicker = document.querySelector("#reactionPicker");
const toastHost = document.querySelector("#toastHost");
const themeButton = document.querySelector("#themeButton");

function can(permission) {
  return state.permissions.includes("*") || state.permissions.includes(permission);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showToast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast${error ? " is-error" : ""}`;
  item.textContent = message;
  toastHost.appendChild(item);
  window.setTimeout(() => item.remove(), error ? 5000 : 2800);
}

function formatTime(value) {
  const date = new Date(Number(value) || value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric"
  }).format(date);
}

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = normalized;
  document.body.style.colorScheme = normalized;
  localStorage.setItem(THEME_KEY, normalized);
  localStorage.setItem(THEME_POS_KEY, normalized === "dark" ? "100" : "0");
  themeButton.title = normalized === "dark" ? "切换到日间模式" : "切换到夜间模式";
}

function parseJson(response) {
  return response.json().catch(() => ({}));
}

async function ensureSecurity() {
  if (state.csrfToken) return state.csrfToken;
  const response = await fetch("/api/security", { cache: "no-store", credentials: "same-origin" });
  const data = await parseJson(response);
  if (!response.ok || !data.csrfToken) throw new Error(data.error || "安全校验初始化失败");
  state.csrfToken = data.csrfToken;
  return state.csrfToken;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (String(options.method || "GET").toUpperCase() !== "GET") {
    headers.set("X-CSRF-Token", await ensureSecurity());
  }
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers
  });
  const data = await parseJson(response);
  if (response.status === 401) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new Error("请先登录");
  }
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function getActivePostId() {
  const match = location.pathname.match(/^\/forum\/post\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function readListStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const sort = params.get("sort");
  state.sort = ["hot", "active", "new"].includes(sort) ? sort : "active";
  state.query = String(params.get("q") || "").slice(0, 80);
  state.category = String(params.get("category") || "").slice(0, 40);
  state.filter = ["all", "mine", "unread", "participated", "bookmarked", "polls"].includes(params.get("filter"))
    ? params.get("filter")
    : "all";
  searchInput.value = state.query;
}

function makeListUrl() {
  const params = new URLSearchParams();
  if (state.sort !== "active") params.set("sort", state.sort);
  if (state.query) params.set("q", state.query);
  if (state.category) params.set("category", state.category);
  if (state.filter !== "all") params.set("filter", state.filter);
  const query = params.toString();
  return `/forum${query ? `?${query}` : ""}`;
}

function updateListUrl({ replace = false } = {}) {
  const method = replace ? "replaceState" : "pushState";
  history[method]({}, "", makeListUrl());
}

function updateFilterUi() {
  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.sort === state.sort);
  });
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.filter === state.filter && !state.category);
  });
  document.querySelectorAll("[data-category]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.category === state.category);
  });
}

function renderCategories() {
  categoryNav.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const category of state.categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sidebar-link";
    button.dataset.category = category.slug;
    button.textContent = category.name;
    button.title = category.description;
    button.addEventListener("click", () => {
      state.category = state.category === category.slug ? "" : category.slug;
      state.filter = "all";
      updateListUrl();
      updateFilterUi();
      showList();
      loadPosts();
    });
    fragment.appendChild(button);
  }
  categoryNav.appendChild(fragment);
  postCategoryInput.innerHTML = state.categories
    .map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`)
    .join("");
}

function readPollOptionValues() {
  return [...pollOptionList.querySelectorAll("input")]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function updatePollOptionControls() {
  const rows = [...pollOptionList.querySelectorAll(".poll-option-editor")];
  rows.forEach((row) => {
    const remove = row.querySelector("button");
    remove.disabled = rows.length <= 2;
  });
  addPollOptionButton.disabled = rows.length >= 8;
}

function addPollOption(value = "") {
  if (pollOptionList.children.length >= 8) return;
  const row = document.createElement("div");
  row.className = "poll-option-editor";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 60;
  input.placeholder = `选项 ${pollOptionList.children.length + 1}`;
  input.value = String(value || "").slice(0, 60);
  input.addEventListener("input", schedulePostDraftSave);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "删除选项";
  remove.setAttribute("aria-label", "删除选项");
  remove.addEventListener("click", () => {
    row.remove();
    [...pollOptionList.querySelectorAll("input")].forEach((option, index) => {
      option.placeholder = `选项 ${index + 1}`;
    });
    updatePollOptionControls();
    schedulePostDraftSave();
  });
  row.append(input, remove);
  pollOptionList.appendChild(row);
  updatePollOptionControls();
}

function resetPollOptions(values = ["", ""]) {
  pollOptionList.innerHTML = "";
  const normalized = Array.isArray(values) && values.length >= 2 ? values.slice(0, 8) : ["", ""];
  normalized.forEach((value) => addPollOption(value));
}

function getPollDurationHours() {
  if (pollDurationInput.value !== "custom") {
    return Number(pollDurationInput.value) || 0;
  }
  const amount = Number(pollCustomDurationValue.value);
  if (!Number.isInteger(amount) || amount < 1) return 0;
  return pollCustomDurationUnit.value === "days" ? amount * 24 : amount;
}

function updatePollCustomDuration() {
  const custom = pollDurationInput.value === "custom";
  pollCustomDuration.classList.toggle("is-hidden", !custom);
  pollCustomDurationValue.required = custom && pollPostInput.checked && !state.editingPost;
  pollCustomDurationValue.max = pollCustomDurationUnit.value === "days" ? "365" : "8760";
}

function updatePollEditorVisibility() {
  const visible = pollPostInput.checked && !state.editingPost;
  pollEditor.classList.toggle("is-hidden", !visible);
  pollQuestionInput.required = visible;
  updatePollCustomDuration();
}

function postDraftKey() {
  return state.user ? `lan_forum_post_draft_${state.user.id}` : "";
}

function replyDraftKey(postId = state.activePost?.id) {
  return state.user && postId ? `lan_forum_reply_draft_${state.user.id}_${postId}` : "";
}

function readStoredDraft(key) {
  if (!key) return null;
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function removeStoredDraft(key) {
  if (!key) return;
  try { localStorage.removeItem(key); } catch {}
}

function savePostDraft() {
  if (state.editingPost) return;
  const key = postDraftKey();
  if (!key) return;
  const draft = {
    title: postTitleInput.value,
    content: postContentInput.value,
    categoryId: Number(postCategoryInput.value) || 0,
    isAnonymous: anonymousPostInput.checked,
    poll: {
      enabled: pollPostInput.checked,
      question: pollQuestionInput.value,
      options: [...pollOptionList.querySelectorAll("input")].map((input) => input.value),
      durationHours: getPollDurationHours(),
      durationMode: pollDurationInput.value,
      customDuration: Number(pollCustomDurationValue.value) || 1,
      customUnit: pollCustomDurationUnit.value
    },
    savedAt: Date.now()
  };
  if (!draft.title.trim() && !draft.content.trim()) {
    removeStoredDraft(key);
    postEditorMessage.textContent = "";
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(draft));
    postEditorMessage.textContent = "草稿已保存";
  } catch {}
}

function schedulePostDraftSave() {
  clearTimeout(postDraftTimer);
  postDraftTimer = setTimeout(savePostDraft, 320);
}

function saveReplyDraft() {
  const key = replyDraftKey();
  if (!key) return;
  const content = replyContent.value;
  try {
    if (content.trim()) localStorage.setItem(key, JSON.stringify({ content, savedAt: Date.now() }));
    else localStorage.removeItem(key);
  } catch {}
}

function scheduleReplyDraftSave() {
  clearTimeout(replyDraftTimer);
  replyDraftTimer = setTimeout(saveReplyDraft, 320);
}

function buildReactionPreview(post) {
  const reactions = Array.isArray(post.reactions) ? post.reactions.slice(0, 3) : [];
  if (!reactions.length) return "";
  return `<span class="post-reaction-preview">${reactions.map((reaction) =>
    `<span class="reaction-chip${reaction.reacted ? " is-active" : ""}">${reaction.emoji} ${reaction.count}</span>`
  ).join("")}</span>`;
}

function renderPostList({ append = false } = {}) {
  if (!append) postList.innerHTML = "";
  if (!state.posts.length) {
    postList.innerHTML = '<div class="empty-state">没有符合条件的帖子。</div>';
  } else {
    const fragment = document.createDocumentFragment();
    const source = append
      ? state.lastAppendCount > 0 ? state.posts.slice(-state.lastAppendCount) : []
      : state.posts;
    for (const post of source) {
      const card = document.createElement("article");
      card.className = `post-card${post.isUnread ? " is-unread" : ""}`;
      card.dataset.postId = String(post.id);
      const activeAt = post.lastReplyAt || post.createdAt;
      card.innerHTML = `
        <div class="post-card-head">
          <div class="post-badges">
            ${post.isPinned ? '<span class="tag is-pin">置顶</span>' : ""}
            <span class="tag">${escapeHtml(post.categoryName || "茶水间")}</span>
            ${post.isPoll ? '<span class="tag is-poll">投票</span>' : ""}
            ${post.isLocked ? '<span class="tag is-muted">已锁定</span>' : ""}
          </div>
          <div class="post-stats">
            <span>${post.replyCount || 0} 回复</span>
            <span>${post.viewCount || 0} 浏览</span>
            ${post.isPoll ? `<span>${post.pollVoteCount || 0} 票</span>` : ""}
            ${buildReactionPreview(post)}
            <button class="bookmark-button${post.isBookmarked ? " is-active" : ""}" type="button"
              title="${post.isBookmarked ? "取消收藏" : "收藏帖子"}"
              aria-label="${post.isBookmarked ? "取消收藏" : "收藏帖子"}">${post.isBookmarked ? "★" : "☆"}</button>
          </div>
        </div>
        <h2>${escapeHtml(post.title)}</h2>
        <p class="post-excerpt">${escapeHtml(post.content)}</p>
        <div class="post-meta">
          <span>${escapeHtml(post.author)}</span>
          <span>发布于 ${formatTime(post.createdAt)}</span>
          ${post.lastReplyAt ? `<span>最后回复 ${formatTime(activeAt)}</span>` : ""}
          ${post.updatedAt ? "<span>已编辑</span>" : ""}
        </div>
      `;
      card.querySelector(".bookmark-button").addEventListener("click", (event) => {
        event.stopPropagation();
        toggleBookmark(post);
      });
      card.addEventListener("click", () => openPost(post.id));
      fragment.appendChild(card);
    }
    postList.appendChild(fragment);
  }
  resultSummary.textContent = state.query
    ? `“${state.query}” · ${state.total} 帖`
    : `${state.total} 帖`;
  loadMorePostsButton.classList.toggle("is-hidden", !state.hasMore);
  updateFilterUi();
}

async function loadPosts({ append = false, quiet = false } = {}) {
  if (!append) {
    state.offset = 0;
    if (!quiet) postList.innerHTML = '<div class="empty-state">正在读取帖子…</div>';
  }
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(append ? state.offset : 0),
    sort: state.sort
  });
  if (state.query) params.set("q", state.query);
  if (state.category) params.set("category", state.category);
  if (state.filter === "mine") params.set("mine", "1");
  if (state.filter === "unread") params.set("unread", "1");
  if (state.filter === "participated") params.set("participated", "1");
  if (state.filter === "bookmarked") params.set("bookmarked", "1");
  if (state.filter === "polls") params.set("polls", "1");
  try {
    const data = await api(`/api/forum/posts?${params}`);
    const incoming = Array.isArray(data.posts) ? data.posts : [];
    state.lastAppendCount = incoming.length;
    state.posts = append ? [...state.posts, ...incoming] : incoming;
    state.total = Number(data.total) || 0;
    state.hasMore = Boolean(data.hasMore);
    state.offset = state.posts.length;
    renderPostList({ append });
  } catch (error) {
    if (!quiet) postList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function showList() {
  forumDetailView.classList.add("is-hidden");
  forumListView.classList.remove("is-hidden");
  document.title = "论坛 · 局域网文件服务器";
}

async function openPost(postId, { replace = false } = {}) {
  if (!Number.isInteger(Number(postId))) return;
  history[replace ? "replaceState" : "pushState"]({}, "", `/forum/post/${Number(postId)}`);
  forumListView.classList.add("is-hidden");
  forumDetailView.classList.remove("is-hidden");
  postDetail.innerHTML = '<div class="empty-state">正在读取帖子…</div>';
  replyList.innerHTML = "";
  state.activePost = null;
  state.replies = [];
  state.repliesLoaded = 0;
  state.replyTarget = null;
  replyContent.value = "";
  updateReplyTarget();
  try {
    await Promise.all([loadPostDetail(Number(postId)), loadReplies(Number(postId))]);
    await markPostRead(Number(postId));
    const replyDraft = readStoredDraft(replyDraftKey(Number(postId)));
    if (replyDraft?.content && !replyContent.value) replyContent.value = String(replyDraft.content).slice(0, 2000);
  } catch (error) {
    postDetail.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderPostReactionBar(post) {
  const container = document.createElement("div");
  container.className = "reaction-row";
  for (const reaction of post.reactions || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `reaction-chip${reaction.reacted ? " is-active" : ""}`;
    button.textContent = `${reaction.emoji} ${reaction.count}`;
    button.disabled = !can("forum.write");
    button.addEventListener("click", () => toggleReaction("post", post.id, reaction.emoji));
    container.appendChild(button);
  }
  if (can("forum.write")) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "reaction-chip";
    add.textContent = "☺";
    add.title = "添加反应";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      openReactionPicker(event.currentTarget, (emoji) => toggleReaction("post", post.id, emoji));
    });
    container.appendChild(add);
  }
  return container;
}

function renderForumPoll(poll, postId) {
  const section = document.createElement("section");
  section.className = "forum-poll";
  const header = document.createElement("header");
  const question = document.createElement("h2");
  question.textContent = poll.question;
  const meta = document.createElement("span");
  meta.textContent = poll.isClosed
    ? `${poll.totalVotes} 票 · 已截止`
    : `${poll.totalVotes} 票 · ${poll.closesAt ? `${formatTime(poll.closesAt)} 截止` : "不限时"}`;
  header.append(question, meta);

  const form = document.createElement("form");
  form.className = "poll-vote-form";
  const hasVoted = Boolean(poll.selectedOptionId);
  const canChangeVote = hasVoted && Number(poll.remainingChanges || 0) > 0;
  const canInteract = !poll.isClosed && (!hasVoted || canChangeVote);
  for (const option of poll.options || []) {
    const row = document.createElement("label");
    row.className = `poll-choice${Number(poll.selectedOptionId) === Number(option.id) ? " is-selected" : ""}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `poll-${postId}`;
    input.value = String(option.id);
    input.checked = Number(poll.selectedOptionId) === Number(option.id);
    input.disabled = !canInteract;
    const body = document.createElement("span");
    body.className = "poll-choice-body";
    const text = document.createElement("span");
    text.className = "poll-choice-text";
    const label = document.createElement("strong");
    label.textContent = option.label;
    const count = document.createElement("span");
    const percentage = poll.totalVotes > 0
      ? Math.round(Number(option.voteCount || 0) / poll.totalVotes * 100)
      : 0;
    count.textContent = `${option.voteCount || 0} 票 · ${percentage}%`;
    text.append(label, count);
    const meter = document.createElement("span");
    meter.className = "poll-meter";
    const fill = document.createElement("i");
    fill.style.width = `${percentage}%`;
    meter.appendChild(fill);
    body.append(text, meter);
    row.append(input, body);
    form.appendChild(row);
  }
  const changeNote = document.createElement("span");
  changeNote.className = "poll-change-note";
  changeNote.textContent = poll.isClosed
    ? "投票已截止"
    : !hasVoted
      ? "投票后可改投 1 次"
      : canChangeVote
        ? "还可改投 1 次"
        : "改投次数已用完";
  form.appendChild(changeNote);
  if (canInteract) {
    const submit = document.createElement("button");
    submit.className = "primary-button poll-submit";
    submit.type = "submit";
    submit.textContent = hasVoted ? "确认改投" : "提交投票";
    if (hasVoted) submit.disabled = true;
    form.appendChild(submit);
    if (hasVoted) {
      form.addEventListener("change", () => {
        const selected = form.querySelector('input[type="radio"]:checked');
        submit.disabled = !selected || Number(selected.value) === Number(poll.selectedOptionId);
      });
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const selected = form.querySelector('input[type="radio"]:checked');
      if (!selected) {
        showToast("请先选择一个选项", true);
        return;
      }
      submit.disabled = true;
      try {
        const data = await api("/api/forum/polls/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ postId, optionId: Number(selected.value) })
        });
        if (state.activePost?.id === postId) {
          state.activePost.poll = data.poll;
          renderPostDetail();
        }
        showToast(hasVoted ? "已改投，本账号不能再次改投" : "投票成功");
      } catch (error) {
        showToast(error.message, true);
        submit.disabled = false;
      }
    });
  }
  section.append(header, form);
  return section;
}

function renderPostDetail() {
  const post = state.activePost;
  if (!post) return;
  document.title = `${post.title} · 论坛`;
  postDetail.innerHTML = `
    <div class="detail-badges">
      ${post.isPinned ? '<span class="tag is-pin">置顶</span>' : ""}
      <span class="tag">${escapeHtml(post.categoryName || "茶水间")}</span>
      ${post.poll ? '<span class="tag is-poll">投票</span>' : ""}
      ${post.isLocked ? '<span class="tag is-muted">已锁定</span>' : ""}
      ${post.isAnonymous ? '<span class="tag is-muted">匿名发布</span>' : ""}
    </div>
    <h1>${escapeHtml(post.title)}</h1>
    <div class="detail-meta">
      <span>${escapeHtml(post.author)}</span>
      <span>${formatTime(post.createdAt)}</span>
      <span>${post.viewCount || 0} 浏览</span>
      <span>${post.replyCount || 0} 回复</span>
      ${post.updatedAt ? `<span>编辑于 ${formatTime(post.updatedAt)}</span>` : ""}
    </div>
    ${post.poll ? '<div id="detailPoll"></div>' : ""}
    <div class="detail-content">${escapeHtml(post.content)}</div>
    <div class="detail-footer">
      <div id="detailReactions"></div>
      <div id="detailActions" class="detail-actions"></div>
    </div>
  `;
  if (post.poll) postDetail.querySelector("#detailPoll").appendChild(renderForumPoll(post.poll, post.id));
  postDetail.querySelector("#detailReactions").appendChild(renderPostReactionBar(post));
  const actions = postDetail.querySelector("#detailActions");
  actions.appendChild(makeTextButton(post.isBookmarked ? "取消收藏" : "收藏", () => toggleBookmark(post)));
  if (post.canEdit) {
    actions.appendChild(makeTextButton("编辑", () => openPostEditor(post)));
  }
  if (post.canModerate) {
    actions.appendChild(makeTextButton(post.isPinned ? "取消置顶" : "置顶", () =>
      moderatePost({ isPinned: !post.isPinned })
    ));
    actions.appendChild(makeTextButton(post.isLocked ? "解除锁定" : "锁定", () =>
      moderatePost({ isLocked: !post.isLocked })
    ));
  }
  if (post.canDelete) {
    actions.appendChild(makeTextButton("删除", deleteActivePost, true));
  }
  replyForm.classList.toggle("is-hidden", !can("forum.write") || post.isLocked);
  replyIdentityHint.textContent = post.isAnonymous && post.isOwn
    ? "回复将显示为匿名楼主"
    : post.isLocked ? "帖子已锁定" : "";
  replyCountLabel.textContent = `${post.replyCount || 0} 回复`;
}

async function loadPostDetail(postId, { quiet = false } = {}) {
  const data = await api(`/api/forum/post?id=${encodeURIComponent(postId)}`);
  state.activePost = data.post;
  renderPostDetail();
  if (!quiet) window.scrollTo({ top: 0, behavior: "smooth" });
}

function makeTextButton(label, action, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `text-button${danger ? " is-danger" : ""}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

async function toggleBookmark(post) {
  try {
    const data = await api("/api/forum/bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId: post.id })
    });
    post.isBookmarked = Boolean(data.bookmarked);
    if (state.activePost?.id === post.id) {
      state.activePost.isBookmarked = post.isBookmarked;
      renderPostDetail();
    }
    if (!forumListView.classList.contains("is-hidden")) {
      if (state.filter === "bookmarked" && !post.isBookmarked) {
        await loadPosts({ quiet: true });
      } else {
        renderPostList();
      }
    }
    showToast(post.isBookmarked ? "已收藏" : "已取消收藏");
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderReplyReactionBar(reply) {
  const container = document.createElement("div");
  container.className = "reaction-row";
  for (const reaction of reply.reactions || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `reaction-chip${reaction.reacted ? " is-active" : ""}`;
    button.textContent = `${reaction.emoji} ${reaction.count}`;
    button.disabled = !can("forum.write") || Boolean(reply.deletedAt);
    button.addEventListener("click", () => toggleReaction("reply", reply.id, reaction.emoji));
    container.appendChild(button);
  }
  if (can("forum.write") && !reply.deletedAt) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "reaction-chip";
    add.textContent = "☺";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      openReactionPicker(event.currentTarget, (emoji) => toggleReaction("reply", reply.id, emoji));
    });
    container.appendChild(add);
  }
  return container;
}

function renderReplies({ append = false } = {}) {
  if (!append) replyList.innerHTML = "";
  if (!state.replies.length) {
    replyList.innerHTML = '<div class="empty-state">还没有回复。</div>';
  } else {
    const fragment = document.createDocumentFragment();
    const source = append
      ? state.lastReplyAppendCount > 0 ? state.replies.slice(-state.lastReplyAppendCount) : []
      : state.replies;
    for (const reply of source) {
      const card = document.createElement("article");
      card.className = `reply-card${reply.deletedAt ? " is-deleted" : ""}`;
      card.dataset.replyId = String(reply.id);
      const edited = reply.updatedAt && Number(reply.updatedAt) !== Number(reply.createdAt);
      card.innerHTML = `
        <div class="reply-meta">
          <strong>${reply.floorNumber}F</strong>
          <span>${escapeHtml(reply.author)}</span>
          <span>${formatTime(reply.createdAt)}</span>
          ${edited ? "<span>已编辑</span>" : ""}
        </div>
        ${reply.replyToFloor ? `<button class="reply-reference" type="button">回复 ${reply.replyToFloor}F · @${escapeHtml(reply.replyToAuthor || "匿名")}</button>` : ""}
        <div class="reply-content">${escapeHtml(reply.content)}</div>
        <div class="reply-actions">
          <div class="reply-reactions"></div>
          <div class="reply-buttons"></div>
        </div>
      `;
      card.querySelector(".reply-reactions").appendChild(renderReplyReactionBar(reply));
      const reference = card.querySelector(".reply-reference");
      if (reference) {
        reference.addEventListener("click", () => {
          const target = replyList.querySelector(`[data-reply-id="${Number(reply.parentReplyId)}"]`);
          if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      }
      const buttons = card.querySelector(".reply-buttons");
      if (!reply.deletedAt && can("forum.write") && !state.activePost?.isLocked) {
        buttons.appendChild(makeTextButton("回复", () => {
          state.replyTarget = {
            id: reply.id,
            floorNumber: reply.floorNumber,
            author: reply.author
          };
          updateReplyTarget();
          replyContent.focus();
        }));
      }
      if (reply.canEdit) {
        buttons.appendChild(makeTextButton("编辑", () => startReplyEdit(card, reply)));
      }
      if (reply.canDelete) {
        buttons.appendChild(makeTextButton("删除", () => deleteReply(reply), true));
      }
      fragment.appendChild(card);
    }
    replyList.appendChild(fragment);
  }
  state.repliesLoaded = state.replies.length;
  replyCountLabel.textContent = `${state.activePost?.replyCount || 0} 回复`;
  loadMoreRepliesButton.classList.toggle("is-hidden", !state.repliesHasMore);
}

async function loadReplies(postId, { append = false, limit } = {}) {
  const requestLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const offset = append ? state.replies.length : 0;
  if (!append) replyList.innerHTML = '<div class="empty-state">正在读取楼层…</div>';
  const data = await api(
    `/api/forum/replies?postId=${encodeURIComponent(postId)}&limit=${requestLimit}&offset=${offset}`
  );
  const incoming = Array.isArray(data.replies) ? data.replies : [];
  state.lastReplyAppendCount = incoming.length;
  state.replies = append ? [...state.replies, ...incoming] : incoming;
  state.repliesTotal = Number(data.total) || 0;
  state.repliesHasMore = Boolean(data.hasMore);
  renderReplies({ append });
}

function updateReplyTarget() {
  const label = replyTarget.querySelector("span");
  if (!state.replyTarget) {
    replyTarget.classList.add("is-hidden");
    label.textContent = "";
    return;
  }
  label.textContent = `回复 ${state.replyTarget.floorNumber}F · @${state.replyTarget.author}`;
  replyTarget.classList.remove("is-hidden");
}

async function markPostRead(postId) {
  try {
    await api("/api/forum/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId })
    });
  } catch {}
}

async function toggleReaction(type, id, emoji) {
  closeReactionPicker();
  try {
    if (type === "post") {
      const data = await api("/api/forum/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: id, emoji })
      });
      if (state.activePost?.id === id) {
        state.activePost.reactions = data.reactions || [];
        renderPostDetail();
      }
    } else {
      const data = await api("/api/forum/replies/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replyId: id, emoji })
      });
      const reply = state.replies.find((item) => item.id === id);
      if (reply) {
        reply.reactions = data.reactions || [];
        renderReplies();
      }
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function openReactionPicker(anchor, onPick) {
  reactionPicker.innerHTML = "";
  for (const emoji of FORUM_REACTION_EMOJIS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.addEventListener("click", () => onPick(emoji));
    reactionPicker.appendChild(button);
  }
  reactionPicker.classList.remove("is-hidden");
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(310, window.innerWidth - 20);
  const left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10));
  reactionPicker.style.left = `${left}px`;
  reactionPicker.style.top = `${Math.max(10, Math.min(rect.bottom + 6, window.innerHeight - 250))}px`;
}

function closeReactionPicker() {
  reactionPicker.classList.add("is-hidden");
}

function openPostEditor(post = null) {
  state.editingPost = post;
  postEditorForm.reset();
  postEditorMessage.textContent = "";
  postEditorTitle.textContent = post ? "编辑帖子" : "发布帖子";
  anonymousPostLabel.classList.toggle("is-hidden", Boolean(post));
  pollPostLabel.classList.toggle("is-hidden", Boolean(post));
  resetPollOptions();
  pollEditor.classList.add("is-hidden");
  if (post) {
    postTitleInput.value = post.title;
    postContentInput.value = post.content;
    postCategoryInput.value = String(post.categoryId || state.categories[0]?.id || "");
  } else {
    const draft = readStoredDraft(postDraftKey());
    const selectedCategory = state.categories.find((category) => category.slug === state.category)
      || state.categories[0];
    postCategoryInput.value = String(draft?.categoryId || selectedCategory?.id || "");
    if (draft) {
      postTitleInput.value = String(draft.title || "").slice(0, 80);
      postContentInput.value = String(draft.content || "").slice(0, 10000);
      anonymousPostInput.checked = Boolean(draft.isAnonymous);
      pollPostInput.checked = Boolean(draft.poll?.enabled);
      pollQuestionInput.value = String(draft.poll?.question || "").slice(0, 80);
      const draftDurationHours = Number(draft.poll?.durationHours) || 0;
      const fixedDuration = [0, 24, 72, 168].includes(draftDurationHours);
      pollDurationInput.value = fixedDuration && draft.poll?.durationMode !== "custom"
        ? String(draftDurationHours)
        : "custom";
      const restoredUnit = draft.poll?.customUnit === "hours"
        ? "hours"
        : (draft.poll?.customUnit === "days" || draftDurationHours % 24 === 0 ? "days" : "hours");
      pollCustomDurationUnit.value = restoredUnit;
      pollCustomDurationValue.value = String(
        Number(draft.poll?.customDuration)
        || (restoredUnit === "days" ? Math.max(1, draftDurationHours / 24) : Math.max(1, draftDurationHours))
      );
      resetPollOptions(draft.poll?.options);
      postEditorMessage.textContent = "已恢复上次草稿";
    }
  }
  updatePollEditorVisibility();
  if (typeof postEditorDialog.showModal === "function") postEditorDialog.showModal();
  else postEditorDialog.setAttribute("open", "open");
  requestAnimationFrame(() => postTitleInput.focus());
}

function closePostEditor() {
  if (postEditorDialog.open && typeof postEditorDialog.close === "function") postEditorDialog.close();
  else postEditorDialog.removeAttribute("open");
  state.editingPost = null;
  if (location.pathname === "/forum/new") {
    history.replaceState({}, "", makeListUrl());
    showList();
  }
}

function confirmAction({ title, message, accept = "确认" }) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmAccept.textContent = accept;
  return new Promise((resolve) => {
    const finish = (value) => {
      confirmAccept.onclick = null;
      confirmCancel.onclick = null;
      confirmDialog.oncancel = null;
      if (confirmDialog.open && typeof confirmDialog.close === "function") confirmDialog.close();
      else confirmDialog.removeAttribute("open");
      resolve(value);
    };
    confirmAccept.onclick = () => finish(true);
    confirmCancel.onclick = () => finish(false);
    confirmDialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    if (typeof confirmDialog.showModal === "function") confirmDialog.showModal();
    else confirmDialog.setAttribute("open", "open");
  });
}

async function moderatePost(patch) {
  const post = state.activePost;
  if (!post) return;
  try {
    await api("/api/forum/posts/moderate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: post.id, ...patch })
    });
    await loadPostDetail(post.id, { quiet: true });
    loadPosts({ quiet: true });
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteActivePost() {
  const post = state.activePost;
  if (!post) return;
  const confirmed = await confirmAction({
    title: "删除帖子",
    message: `“${post.title}”及全部楼层和反应将被删除。`,
    accept: "删除"
  });
  if (!confirmed) return;
  try {
    await api("/api/forum/posts/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: post.id })
    });
    showToast("帖子已删除");
    history.replaceState({}, "", makeListUrl());
    showList();
    loadPosts();
  } catch (error) {
    showToast(error.message, true);
  }
}

function startReplyEdit(card, reply) {
  const content = card.querySelector(".reply-content");
  const actions = card.querySelector(".reply-buttons");
  const textarea = document.createElement("textarea");
  textarea.maxLength = 2000;
  textarea.value = reply.content;
  textarea.className = "reply-edit-input";
  textarea.style.width = "100%";
  textarea.style.minHeight = "100px";
  content.replaceWith(textarea);
  actions.innerHTML = "";
  actions.append(
    makeTextButton("取消", () => renderReplies()),
    makeTextButton("保存", async () => {
      const value = textarea.value.trim();
      if (!value) return;
      try {
        await api("/api/forum/replies/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: reply.id, content: value })
        });
        await loadReplies(state.activePost.id, { limit: Math.max(20, state.repliesLoaded) });
      } catch (error) {
        showToast(error.message, true);
      }
    })
  );
  textarea.focus();
}

async function deleteReply(reply) {
  const confirmed = await confirmAction({
    title: "删除回复",
    message: `${reply.floorNumber}F 将保留楼层位置，但正文会被移除。`,
    accept: "删除"
  });
  if (!confirmed) return;
  try {
    await api("/api/forum/replies/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: reply.id })
    });
    await Promise.all([
      loadPostDetail(state.activePost.id, { quiet: true }),
      loadReplies(state.activePost.id, { limit: Math.max(20, state.repliesLoaded) })
    ]);
  } catch (error) {
    showToast(error.message, true);
  }
}

function scheduleEventRefresh(event) {
  clearTimeout(state.eventRefreshTimer);
  state.eventRefreshTimer = setTimeout(async () => {
    if (!forumListView.classList.contains("is-hidden")) {
      await loadPosts({ quiet: true });
      return;
    }
    if (!state.activePost || Number(event.postId) !== Number(state.activePost.id)) return;
    if (event.type === "post_deleted") {
      history.replaceState({}, "", makeListUrl());
      showList();
      loadPosts();
      return;
    }
    try {
      await loadPostDetail(state.activePost.id, { quiet: true });
      if (event.type.startsWith("reply_") && !replyContent.value.trim()) {
        await loadReplies(state.activePost.id, { limit: Math.max(20, state.repliesLoaded) });
        await markPostRead(state.activePost.id);
      }
    } catch {}
  }, 220);
}

function disconnectForumEvents() {
  clearTimeout(state.eventRefreshTimer);
  state.eventRefreshTimer = null;
  if (!forumEventSource) return;
  forumEventSource.close();
  forumEventSource = null;
}

function connectForumEvents() {
  if (forumEventSource || typeof EventSource !== "function") return;
  forumEventSource = new EventSource("/api/forum/events");
  forumEventSource.addEventListener("forum", (event) => {
    try { scheduleEventRefresh(JSON.parse(event.data)); } catch {}
  });
}

async function initialize() {
  const storedThemePositionRaw = localStorage.getItem(THEME_POS_KEY);
  const storedThemePosition = Number(storedThemePositionRaw);
  applyTheme(
    storedThemePositionRaw !== null && Number.isFinite(storedThemePosition)
      ? storedThemePosition >= 50 ? "dark" : "light"
      : localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"
  );
  const [sessionResponse, categoriesData] = await Promise.all([
    fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin"
    }).then(async (response) => ({
      response,
      data: await parseJson(response)
    })),
    api("/api/forum/categories")
  ]);
  if (!sessionResponse.response.ok || !sessionResponse.data.authenticated || !sessionResponse.data.user) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }
  state.user = sessionResponse.data.user;
  state.permissions = Array.isArray(state.user.permissions) ? state.user.permissions : [];
  state.categories = Array.isArray(categoriesData.categories) ? categoriesData.categories : [];
  accountBadge.textContent = `${state.user.name} · ${state.user.roleLabel}`;
  newPostButton.classList.toggle("is-hidden", !can("forum.write"));
  readListStateFromUrl();
  renderCategories();
  updateFilterUi();
  connectForumEvents();

  const postId = getActivePostId();
  if (postId) {
    await openPost(postId, { replace: true });
  } else {
    showList();
    await loadPosts();
    if (location.pathname === "/forum/new") {
      if (can("forum.write")) openPostEditor();
      else history.replaceState({}, "", makeListUrl());
    }
  }
}

themeButton.addEventListener("click", () => {
  applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
});

sortTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-sort]");
  if (!button || button.dataset.sort === state.sort) return;
  state.sort = button.dataset.sort;
  updateListUrl();
  updateFilterUi();
  showList();
  loadPosts();
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    state.category = "";
    updateListUrl();
    updateFilterUi();
    showList();
    loadPosts();
  });
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.query = searchInput.value.trim().slice(0, 80);
  updateListUrl();
  showList();
  loadPosts();
});

loadMorePostsButton.addEventListener("click", async () => {
  loadMorePostsButton.disabled = true;
  try { await loadPosts({ append: true }); } finally { loadMorePostsButton.disabled = false; }
});

newPostButton.addEventListener("click", () => {
  history.pushState({}, "", "/forum/new");
  openPostEditor();
});

closePostEditorButton.addEventListener("click", closePostEditor);
postEditorDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePostEditor();
});
postEditorDialog.addEventListener("pointerdown", (event) => {
  postEditorDialog._backdropPointerDown = event.target === postEditorDialog;
});
postEditorDialog.addEventListener("click", (event) => {
  const trueBackdropClick = event.target === postEditorDialog
    && postEditorDialog._backdropPointerDown === true;
  postEditorDialog._backdropPointerDown = false;
  if (trueBackdropClick) closePostEditor();
});
postTitleInput.addEventListener("input", schedulePostDraftSave);
postContentInput.addEventListener("input", schedulePostDraftSave);
postCategoryInput.addEventListener("change", schedulePostDraftSave);
anonymousPostInput.addEventListener("change", schedulePostDraftSave);
pollPostInput.addEventListener("change", () => {
  updatePollEditorVisibility();
  schedulePostDraftSave();
});
pollQuestionInput.addEventListener("input", schedulePostDraftSave);
pollDurationInput.addEventListener("change", () => {
  updatePollCustomDuration();
  schedulePostDraftSave();
});
pollCustomDurationValue.addEventListener("input", schedulePostDraftSave);
pollCustomDurationUnit.addEventListener("change", () => {
  updatePollCustomDuration();
  schedulePostDraftSave();
});
addPollOptionButton.addEventListener("click", () => {
  addPollOption();
  schedulePostDraftSave();
  pollOptionList.lastElementChild?.querySelector("input")?.focus();
});

postEditorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = postEditorForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  postEditorMessage.textContent = "正在保存…";
  try {
    const editing = state.editingPost;
    const endpoint = editing ? "/api/forum/posts/update" : "/api/forum/posts";
    const body = {
      id: editing?.id,
      title: postTitleInput.value.trim(),
      content: postContentInput.value.trim(),
      categoryId: Number(postCategoryInput.value),
      isAnonymous: !editing && anonymousPostInput.checked,
      poll: editing ? null : {
        enabled: pollPostInput.checked,
        question: pollQuestionInput.value.trim(),
        options: readPollOptionValues(),
        durationHours: getPollDurationHours()
      }
    };
    if (body.poll?.enabled && body.poll.options.length < 2) {
      throw new Error("投票至少需要两个选项");
    }
    if (body.poll?.enabled && pollDurationInput.value === "custom" && body.poll.durationHours < 1) {
      throw new Error("请填写有效的投票时长");
    }
    const data = await api(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const postId = editing?.id || Number(data.id);
    clearTimeout(postDraftTimer);
    postDraftTimer = null;
    if (!editing) removeStoredDraft(postDraftKey());
    closePostEditor();
    showToast(editing ? "帖子已更新" : "帖子已发布");
    await loadPosts({ quiet: true });
    await openPost(postId, { replace: true });
  } catch (error) {
    postEditorMessage.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

backToListButton.addEventListener("click", () => {
  history.pushState({}, "", makeListUrl());
  showList();
  loadPosts({ quiet: true });
});

loadMoreRepliesButton.addEventListener("click", async () => {
  if (!state.activePost) return;
  loadMoreRepliesButton.disabled = true;
  try { await loadReplies(state.activePost.id, { append: true }); }
  finally { loadMoreRepliesButton.disabled = false; }
});

clearReplyTargetButton.addEventListener("click", () => {
  state.replyTarget = null;
  updateReplyTarget();
  replyContent.focus();
});
replyContent.addEventListener("input", scheduleReplyDraftSave);

replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activePost) return;
  const value = replyContent.value.trim();
  if (!value) return;
  const submit = replyForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api("/api/forum/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postId: state.activePost.id,
        parentReplyId: state.replyTarget?.id || null,
        content: value
      })
    });
    replyContent.value = "";
    removeStoredDraft(replyDraftKey());
    state.replyTarget = null;
    updateReplyTarget();
    await Promise.all([
      loadPostDetail(state.activePost.id, { quiet: true }),
      loadReplies(state.activePost.id, { limit: Math.max(20, state.repliesLoaded + 1) })
    ]);
    await markPostRead(state.activePost.id);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener("click", (event) => {
  if (!reactionPicker.classList.contains("is-hidden") && !reactionPicker.contains(event.target)) {
    closeReactionPicker();
  }
});
window.addEventListener("resize", closeReactionPicker);
window.addEventListener("scroll", closeReactionPicker, true);
window.addEventListener("pagehide", disconnectForumEvents);
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  connectForumEvents();
  if (!forumListView.classList.contains("is-hidden")) loadPosts({ quiet: true });
  else if (state.activePost) {
    Promise.all([
      loadPostDetail(state.activePost.id, { quiet: true }),
      loadReplies(state.activePost.id, { limit: Math.max(20, state.repliesLoaded) })
    ]).catch(() => {});
  }
});
window.addEventListener("popstate", () => {
  readListStateFromUrl();
  const postId = getActivePostId();
  if (postId) openPost(postId, { replace: true });
  else {
    showList();
    updateFilterUi();
    loadPosts();
  }
});

initialize().catch((error) => {
  postList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || "论坛初始化失败")}</div>`;
});
