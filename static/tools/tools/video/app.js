const state = {
  videos: [],
  currentVideoId: null,
  isBusy: false,
  restoring: false,
  selectedVideoIds: [],
};

const elements = {
  selectAllButton: document.getElementById("selectAllButton"),
  invertSelectButton: document.getElementById("invertSelectButton"),
  batchDeleteButton: document.getElementById("batchDeleteButton"),
  dropZone: document.getElementById("dropZone"),
  videoInput: document.getElementById("videoInput"),
  notice: document.getElementById("notice"),
  videoList: document.getElementById("videoList"),
  libraryMeta: document.getElementById("libraryMeta"),
  video: document.getElementById("video"),
  videoWrap: document.getElementById("videoWrap"),
  timeline: document.getElementById("timeline"),
  currentTimeLabel: document.getElementById("currentTimeLabel"),
  durationLabel: document.getElementById("durationLabel"),
  fileMeta: document.getElementById("fileMeta"),
  formatSelect: document.getElementById("formatSelect"),
  prefixInput: document.getElementById("prefixInput"),
  addMarkerButton: document.getElementById("addMarkerButton"),
  exportMarkedButton: document.getElementById("exportMarkedButton"),
  clearMarkersButton: document.getElementById("clearMarkersButton"),
  markerSelectAllButton: document.getElementById("markerSelectAllButton"),
  markerInvertSelectButton: document.getElementById("markerInvertSelectButton"),
  markerList: document.getElementById("markerList"),
  markerMeta: document.getElementById("markerMeta"),
  canvasWrap: document.getElementById("canvasWrap"),
  frameCanvas: document.getElementById("frameCanvas"),
  sendToMaskButton: document.getElementById("sendToMaskButton"),
  frameInfo: document.getElementById("frameInfo"),
};

const canvasContext = elements.frameCanvas.getContext("2d", { willReadFrequently: true });

function getCurrentEntry() {
  return state.videos.find((entry) => entry.id === state.currentVideoId) || null;
}

function ensureMarkerSelection(entry) {
  if (!entry) {
    return [];
  }

  if (!Array.isArray(entry.selectedMarkerIds)) {
    entry.selectedMarkerIds = [];
  }

  const markerIds = new Set(entry.markers.map((marker) => marker.id));
  entry.selectedMarkerIds = entry.selectedMarkerIds.filter((id) => markerIds.has(id));
  return entry.selectedMarkerIds;
}

function syncBatchDeleteButton() {
  const hasVideos = Boolean(state.videos.length);
  elements.selectAllButton.disabled = !hasVideos;
  elements.invertSelectButton.disabled = !hasVideos;
  elements.batchDeleteButton.disabled = !state.selectedVideoIds.length;
}

function syncMarkerSelectionButtons(entry = getCurrentEntry()) {
  const hasMarkers = Boolean(entry && entry.markers.length);
  elements.markerSelectAllButton.disabled = !hasMarkers;
  elements.markerInvertSelectButton.disabled = !hasMarkers;
}

async function persistVideoState() {
  if (state.restoring) {
    return;
  }

  const currentEntry = getCurrentEntry();
  await MediaStore.setMeta("video-page-state", {
    currentVideoId: state.currentVideoId,
    format: elements.formatSelect.value,
    prefix: elements.prefixInput.value,
    selectedVideoIds: state.selectedVideoIds,
  });

  await MediaStore.clearVideos();
  for (const entry of state.videos) {
    ensureMarkerSelection(entry);
    await MediaStore.putVideo({
      id: entry.id,
      fileName: entry.file.name,
      fileType: entry.file.type,
      fileSize: entry.file.size,
      lastModified: entry.file.lastModified,
      blob: entry.file,
      markers: entry.markers,
      selectedMarkerIds: entry.selectedMarkerIds,
      selected: currentEntry ? currentEntry.id === entry.id : false,
    });
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00.00";
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const centiseconds = Math.floor((seconds % 1) * 100);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function showNotice(message, type = "success") {
  elements.notice.textContent = message;
  elements.notice.className = `notice ${type}`;
}

function clearNotice() {
  elements.notice.textContent = "";
  elements.notice.className = "notice hidden";
}

function toggleActions(enabled) {
  const entry = getCurrentEntry();
  const hasMarkers = Boolean(entry && entry.markers.length);
  elements.timeline.disabled = !enabled;
  elements.addMarkerButton.disabled = !enabled || state.isBusy;
  elements.exportMarkedButton.disabled = !enabled || state.isBusy || !hasMarkers;
  elements.clearMarkersButton.disabled = !enabled || state.isBusy || !hasMarkers;
  elements.sendToMaskButton.disabled = !enabled || state.isBusy;
}

function getAspectRatioLabel(width, height) {
  if (!width || !height) return "";
  const ratio = width / height;
  const presets = [
    { label: "9:16", value: 9 / 16 },
    { label: "3:4", value: 3 / 4 },
    { label: "1:1", value: 1 },
    { label: "4:3", value: 4 / 3 },
    { label: "16:9", value: 16 / 9 },
    { label: "21:9", value: 21 / 9 },
  ];

  let closest = presets[0];
  let delta = Math.abs(ratio - closest.value);
  for (const preset of presets.slice(1)) {
    const nextDelta = Math.abs(ratio - preset.value);
    if (nextDelta < delta) {
      closest = preset;
      delta = nextDelta;
    }
  }

  return delta < 0.03 ? closest.label : `${width}:${height}`;
}

function syncMediaRatio() {
  const width = elements.video.videoWidth || 1280;
  const height = elements.video.videoHeight || 720;
  const ratioValue = `${width} / ${height}`;
  elements.videoWrap.style.setProperty("--media-ratio", ratioValue);
  elements.canvasWrap.style.setProperty("--media-ratio", ratioValue);
}

function syncCanvasSize() {
  const width = elements.video.videoWidth || 1280;
  const height = elements.video.videoHeight || 720;
  elements.frameCanvas.width = width;
  elements.frameCanvas.height = height;
}

function drawCurrentFrame() {
  if (!elements.video.videoWidth || !elements.video.videoHeight) return;
  syncMediaRatio();
  syncCanvasSize();
  canvasContext.drawImage(elements.video, 0, 0, elements.frameCanvas.width, elements.frameCanvas.height);
  elements.frameInfo.textContent = `当前帧 ${formatTime(elements.video.currentTime)} | ${elements.frameCanvas.width} x ${elements.frameCanvas.height} | ${getAspectRatioLabel(elements.frameCanvas.width, elements.frameCanvas.height)}`;
}

function sanitizePrefix(value) {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
  return cleaned || "frame";
}

function getMimeAndExtension() {
  if (elements.formatSelect.value === "png") {
    return { mime: "image/png", extension: "png", quality: undefined };
  }
  return { mime: "image/jpeg", extension: "jpg", quality: 1 };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("图片导出失败"));
      }
    }, type, quality);
  });
}

async function sendFrameToMaskPage() {
  const entry = getCurrentEntry();
  if (!entry) {
    return;
  }

  try {
    drawCurrentFrame();
    const blob = await canvasToBlob(elements.frameCanvas, "image/png");
    const timestamp = elements.video.currentTime.toFixed(2).replace(".", "_");
    const baseName = entry.file.name.replace(/\.[^.]+$/, "");
    const fileName = `${baseName}-${timestamp}.png`;
    await MediaStore.putFrameTransfer({
      fileName,
      imageBlob: blob,
      source: "video-frame",
      createdAt: Date.now(),
    });
    window.location.href = "./image-blur.html";
  } catch (error) {
    showNotice(error.message || "发送到蒙版页失败。", "warn");
  }
}

async function seekVideo(time) {
  const boundedTime = Math.min(Math.max(time, 0), elements.video.duration || 0);
  if (Math.abs(elements.video.currentTime - boundedTime) < 0.001) {
    return;
  }
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      elements.video.removeEventListener("seeked", onSeeked);
      elements.video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      elements.video.removeEventListener("seeked", onSeeked);
      elements.video.removeEventListener("error", onError);
      reject(new Error("视频定位失败"));
    };
    elements.video.addEventListener("seeked", onSeeked, { once: true });
    elements.video.addEventListener("error", onError, { once: true });
    elements.video.currentTime = boundedTime;
  });
}

function updateLibraryMeta() {
  if (!state.videos.length) {
    elements.libraryMeta.textContent = "未导入视频";
    return;
  }
  if (state.selectedVideoIds.length) {
    elements.libraryMeta.textContent = `已导入 ${state.videos.length} 个 | 已勾选 ${state.selectedVideoIds.length} 个`;
    return;
  }
  elements.libraryMeta.textContent = `已导入 ${state.videos.length} 个视频`;
}

function renderVideoList() {
  if (!state.videos.length) {
    elements.videoList.className = "video-list empty";
    elements.videoList.innerHTML = '<p class="empty-state">导入后会显示在这里，点击即可切换视频。</p>';
    syncBatchDeleteButton();
    return;
  }

  elements.videoList.className = "video-list";
  elements.videoList.innerHTML = state.videos.map((entry) => `
    <div class="video-item ${entry.id === state.currentVideoId ? "active" : ""}">
      <label class="video-item-check">
        <input type="checkbox" data-select-video-id="${entry.id}" ${state.selectedVideoIds.includes(entry.id) ? "checked" : ""}>
      </label>
      <button class="video-item-main" type="button" data-video-id="${entry.id}">
        <span class="video-item-name">${entry.file.name}</span>
        <span class="video-item-meta">${formatBytes(entry.file.size)} | ${entry.markers.length} 个标记</span>
      </button>
      <button class="video-item-remove" type="button" data-remove-video-id="${entry.id}" aria-label="删除视频">×</button>
    </div>
  `).join("");

  elements.videoList.querySelectorAll("[data-video-id]").forEach((button) => {
    button.addEventListener("click", () => selectVideo(button.dataset.videoId));
  });

  elements.videoList.querySelectorAll("[data-select-video-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const { selectVideoId } = checkbox.dataset;
      if (checkbox.checked) {
        if (!state.selectedVideoIds.includes(selectVideoId)) {
          state.selectedVideoIds.push(selectVideoId);
        }
      } else {
        state.selectedVideoIds = state.selectedVideoIds.filter((id) => id !== selectVideoId);
      }
      updateLibraryMeta();
      syncBatchDeleteButton();
      void persistVideoState();
    });
  });

  elements.videoList.querySelectorAll("[data-remove-video-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void removeVideo(button.dataset.removeVideoId);
    });
  });

  syncBatchDeleteButton();
}

function renderMarkerList() {
  const entry = getCurrentEntry();
  if (!entry || !entry.markers.length) {
    elements.markerMeta.textContent = "当前无标记";
    elements.markerList.className = "marker-list empty";
    elements.markerList.innerHTML = '<p class="empty-state">在时间轴定位后点击“添加帧标记”，这里会列出待导出的所有时间点。</p>';
    syncMarkerSelectionButtons(null);
    toggleActions(Boolean(entry));
    renderVideoList();
    return;
  }

  const selectedMarkerIds = ensureMarkerSelection(entry);
  elements.markerMeta.textContent = selectedMarkerIds.length
    ? `共 ${entry.markers.length} 个标记 | 已选 ${selectedMarkerIds.length} 个`
    : `共 ${entry.markers.length} 个标记`;
  elements.markerList.className = "marker-list";
  elements.markerList.innerHTML = entry.markers.map((marker, index) => `
    <div class="marker-item">
      <label class="marker-check">
        <input type="checkbox" data-select-marker-id="${marker.id}" ${selectedMarkerIds.includes(marker.id) ? "checked" : ""}>
      </label>
      <div class="marker-main">
        <button class="marker-jump" type="button" data-marker-time="${marker.time}">${index + 1}. ${formatTime(marker.time)}</button>
      </div>
      <button class="marker-delete" type="button" data-marker-id="${marker.id}">删除</button>
    </div>
  `).join("");

  elements.markerList.querySelectorAll("[data-marker-time]").forEach((button) => {
    button.addEventListener("click", async () => {
      await seekVideo(Number(button.dataset.markerTime));
      elements.currentTimeLabel.textContent = formatTime(elements.video.currentTime);
      elements.timeline.value = String(elements.video.currentTime);
      drawCurrentFrame();
    });
  });

  elements.markerList.querySelectorAll("[data-marker-id]").forEach((button) => {
    button.addEventListener("click", () => removeMarker(button.dataset.markerId));
  });

  elements.markerList.querySelectorAll("[data-select-marker-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const markerIds = ensureMarkerSelection(entry);
      const { selectMarkerId } = checkbox.dataset;
      if (checkbox.checked) {
        if (!markerIds.includes(selectMarkerId)) {
          markerIds.push(selectMarkerId);
        }
      } else {
        entry.selectedMarkerIds = markerIds.filter((id) => id !== selectMarkerId);
      }
      renderMarkerList();
      void persistVideoState();
    });
  });

  syncMarkerSelectionButtons(entry);
  toggleActions(Boolean(entry));
  renderVideoList();
}

function resetPlayerState() {
  elements.timeline.value = "0";
  elements.timeline.max = "0";
  elements.currentTimeLabel.textContent = "00:00.00";
  elements.durationLabel.textContent = "00:00.00";
  elements.fileMeta.textContent = "未选择视频";
  elements.frameInfo.textContent = "灏氭湭鎴抚";
  toggleActions(false);
}

function selectVideo(videoId) {
  const entry = state.videos.find((item) => item.id === videoId);
  if (!entry) return;

  state.currentVideoId = videoId;
  clearNotice();
  elements.video.src = entry.objectUrl;
  elements.video.load();
  renderVideoList();
  renderMarkerList();
  resetPlayerState();
  elements.fileMeta.textContent = `${entry.file.name} | ${formatBytes(entry.file.size)} | 加载中`;
  if (!elements.prefixInput.value || elements.prefixInput.value === "frame") {
    elements.prefixInput.value = entry.file.name.replace(/\.[^.]+$/, "");
  }
  void persistVideoState();
}

async function removeVideo(videoId) {
  const targetIndex = state.videos.findIndex((entry) => entry.id === videoId);
  if (targetIndex === -1) {
    return;
  }

  const [removed] = state.videos.splice(targetIndex, 1);
  state.selectedVideoIds = state.selectedVideoIds.filter((id) => id !== videoId);
  if (removed && removed.objectUrl) {
    URL.revokeObjectURL(removed.objectUrl);
  }

  if (!state.videos.length) {
    state.currentVideoId = null;
    elements.video.removeAttribute("src");
    elements.video.load();
    updateLibraryMeta();
    renderVideoList();
    renderMarkerList();
    resetPlayerState();
    await persistVideoState();
    showNotice("视频已删除，当前列表已清空。");
    return;
  }

  const wasCurrent = state.currentVideoId === videoId;
  const fallbackIndex = Math.min(targetIndex, state.videos.length - 1);
  const fallbackVideo = state.videos[fallbackIndex];

  updateLibraryMeta();
  renderVideoList();

  if (wasCurrent && fallbackVideo) {
    selectVideo(fallbackVideo.id);
  } else {
    renderMarkerList();
  }

  await persistVideoState();
  showNotice("视频已从列表中删除。");
}

async function removeSelectedVideos() {
  if (!state.selectedVideoIds.length) {
    return;
  }

  const selectedIds = new Set(state.selectedVideoIds);
  const removingCurrent = selectedIds.has(state.currentVideoId);

  state.videos.forEach((entry) => {
    if (selectedIds.has(entry.id) && entry.objectUrl) {
      URL.revokeObjectURL(entry.objectUrl);
    }
  });

  state.videos = state.videos.filter((entry) => !selectedIds.has(entry.id));
  state.selectedVideoIds = [];

  if (!state.videos.length) {
    state.currentVideoId = null;
    elements.video.removeAttribute("src");
    elements.video.load();
    updateLibraryMeta();
    renderVideoList();
    renderMarkerList();
    resetPlayerState();
    await persistVideoState();
    showNotice("已删除选中的视频，当前列表已清空。");
    return;
  }

  updateLibraryMeta();
  renderVideoList();

  if (removingCurrent) {
    selectVideo(state.videos[0].id);
  } else {
    renderMarkerList();
  }

  await persistVideoState();
  showNotice("已删除勾选的视频。");
}

function selectAllVideos() {
  state.selectedVideoIds = state.videos.map((entry) => entry.id);
  updateLibraryMeta();
  renderVideoList();
  void persistVideoState();
}

function invertSelectedVideos() {
  const selectedIds = new Set(state.selectedVideoIds);
  state.selectedVideoIds = state.videos
    .map((entry) => entry.id)
    .filter((id) => !selectedIds.has(id));
  updateLibraryMeta();
  renderVideoList();
  void persistVideoState();
}

function selectAllMarkers() {
  const entry = getCurrentEntry();
  if (!entry || !entry.markers.length) {
    return;
  }

  entry.selectedMarkerIds = entry.markers.map((marker) => marker.id);
  renderMarkerList();
  void persistVideoState();
}

function invertSelectedMarkers() {
  const entry = getCurrentEntry();
  if (!entry || !entry.markers.length) {
    return;
  }

  const selectedIds = new Set(ensureMarkerSelection(entry));
  entry.selectedMarkerIds = entry.markers
    .map((marker) => marker.id)
    .filter((id) => !selectedIds.has(id));
  renderMarkerList();
  void persistVideoState();
}

async function addVideos(files) {
  const validFiles = Array.from(files).filter((file) => file.type.startsWith("video/")
    || /\.(mp4|avi|mov|mkv|wmv|flv|webm|m4v|mpg|mpeg|3gp)$/i.test(file.name));
  if (!validFiles.length) {
    showNotice("请选择有效的视频文件。", "warn");
    return;
  }

  const existingKeys = new Set(state.videos.map((entry) => `${entry.file.name}-${entry.file.size}-${entry.file.lastModified}`));
  let addedCount = 0;

  for (const file of validFiles) {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (existingKeys.has(key)) {
      continue;
    }
    existingKeys.add(key);
    state.videos.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      objectUrl: URL.createObjectURL(file),
      markers: [],
      selectedMarkerIds: [],
    });
    addedCount += 1;
  }

  updateLibraryMeta();
  renderVideoList();

  if (!getCurrentEntry() && state.videos.length) {
    selectVideo(state.videos[0].id);
  } else {
    renderMarkerList();
  }

  await persistVideoState();

  if (addedCount) {
    showNotice(`已导入 ${addedCount} 个视频，可在最左侧悬浮列表切换。`);
  } else {
    showNotice("导入的视频已存在于列表中。", "warn");
  }
}

function addMarker() {
  const entry = getCurrentEntry();
  if (!entry) return;

  const roundedTime = Number(elements.video.currentTime.toFixed(2));
  const exists = entry.markers.some((marker) => Math.abs(marker.time - roundedTime) < 0.01);
  if (exists) {
    showNotice("这个时间点已经有标记了。", "warn");
    return;
  }

  entry.markers.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: roundedTime,
  });
  entry.markers.sort((a, b) => a.time - b.time);
  renderMarkerList();
  void persistVideoState();
  showNotice(`已添加帧标记：${formatTime(roundedTime)}`);
}


function removeMarker(markerId) {
  const entry = getCurrentEntry();
  if (!entry) return;
  entry.markers = entry.markers.filter((marker) => marker.id !== markerId);
  entry.selectedMarkerIds = ensureMarkerSelection(entry).filter((id) => id !== markerId);
  renderMarkerList();
  void persistVideoState();
  showNotice("已删除标记。");
}

function clearMarkers() {
  const entry = getCurrentEntry();
  if (!entry) return;
  entry.markers = [];
  entry.selectedMarkerIds = [];
  renderMarkerList();
  void persistVideoState();
  showNotice("当前视频的标记已清空。");
}

async function exportMarkedFrames() {
  const entry = getCurrentEntry();
  if (!entry || !entry.markers.length) return;

  state.isBusy = true;
  toggleActions(true);
  elements.video.pause();

  const { mime, extension, quality } = getMimeAndExtension();
  const prefix = sanitizePrefix(elements.prefixInput.value || entry.file.name.replace(/\.[^.]+$/, ""));
  const originalTime = elements.video.currentTime;

  try {
    for (let index = 0; index < entry.markers.length; index += 1) {
      const marker = entry.markers[index];
      await seekVideo(marker.time);
      elements.timeline.value = String(elements.video.currentTime);
      elements.currentTimeLabel.textContent = formatTime(elements.video.currentTime);
      drawCurrentFrame();
      const blob = await canvasToBlob(elements.frameCanvas, mime, quality);
      const timestamp = marker.time.toFixed(2).replace(".", "_");
      const filename = `${prefix}-${String(index + 1).padStart(3, "0")}-${timestamp}.${extension}`;
      downloadBlob(blob, filename);
      showNotice(`正在导出第 ${index + 1}/${entry.markers.length} 张。`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await seekVideo(originalTime);
    elements.timeline.value = String(elements.video.currentTime);
    elements.currentTimeLabel.textContent = formatTime(elements.video.currentTime);
    drawCurrentFrame();
    showNotice(`导出完成，共 ${entry.markers.length} 张图片。`);
  } catch (error) {
    showNotice(error.message || "导出中断。", "warn");
  } finally {
    state.isBusy = false;
    toggleActions(true);
  }
}

function bindDragAndDrop() {
  // Document-level handlers: essential for iframe to accept drops from outside
  document.addEventListener("dragover", (e) => { e.preventDefault(); });
  document.addEventListener("drop", (e) => { e.preventDefault(); });

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("active");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("active");
    });
  });

  elements.dropZone.addEventListener("drop", (event) => {
    addVideos(event.dataTransfer.files);
  });

  elements.dropZone.addEventListener("click", () => elements.videoInput.click());
  elements.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.videoInput.click();
    }
  });
}

function bindEvents() {
  bindDragAndDrop();

  elements.selectAllButton.addEventListener("click", selectAllVideos);
  elements.invertSelectButton.addEventListener("click", invertSelectedVideos);
  elements.batchDeleteButton.addEventListener("click", () => {
    void removeSelectedVideos();
  });
  elements.videoInput.addEventListener("change", (event) => {
    void addVideos(event.target.files);
    event.target.value = "";
  });

  elements.addMarkerButton.addEventListener("click", addMarker);
  elements.exportMarkedButton.addEventListener("click", exportMarkedFrames);
  elements.clearMarkersButton.addEventListener("click", clearMarkers);
  elements.markerSelectAllButton.addEventListener("click", selectAllMarkers);
  elements.markerInvertSelectButton.addEventListener("click", invertSelectedMarkers);
  elements.sendToMaskButton.addEventListener("click", () => {
    void sendFrameToMaskPage();
  });
  elements.formatSelect.addEventListener("change", () => {
    void persistVideoState();
  });
  elements.prefixInput.addEventListener("input", () => {
    void persistVideoState();
  });

  elements.video.addEventListener("loadedmetadata", async () => {
    const entry = getCurrentEntry();
    if (!entry) return;
    syncMediaRatio();
    elements.timeline.max = String(elements.video.duration || 0);
    elements.timeline.value = "0";
    elements.durationLabel.textContent = formatTime(elements.video.duration);
    elements.fileMeta.textContent = `${entry.file.name} | ${formatBytes(entry.file.size)} | ${elements.video.videoWidth} x ${elements.video.videoHeight} | ${getAspectRatioLabel(elements.video.videoWidth, elements.video.videoHeight)}`;
    toggleActions(true);
    await seekVideo(0);
    drawCurrentFrame();
    renderMarkerList();
    showNotice(`视频已加载：${entry.file.name}`);
  });

  elements.video.addEventListener("timeupdate", () => {
    if (!state.isBusy) {
      elements.timeline.value = String(elements.video.currentTime);
      elements.currentTimeLabel.textContent = formatTime(elements.video.currentTime);
    }
  });

  elements.timeline.addEventListener("input", async (event) => {
    const targetTime = Number(event.target.value);
    await seekVideo(targetTime);
    elements.currentTimeLabel.textContent = formatTime(elements.video.currentTime);
    drawCurrentFrame();
  });
}

async function restoreVideoState() {
  state.restoring = true;
  try {
    const [savedVideos, savedMeta] = await Promise.all([
      MediaStore.getAllVideos(),
      MediaStore.getMeta("video-page-state"),
    ]);

    if (savedMeta) {
      elements.formatSelect.value = savedMeta.format || "png";
      elements.prefixInput.value = savedMeta.prefix || "frame";
      state.selectedVideoIds = Array.isArray(savedMeta.selectedVideoIds) ? savedMeta.selectedVideoIds : [];
    }

    if (savedVideos && savedVideos.length) {
      state.videos = savedVideos.map((entry) => {
        const file = new File([entry.blob], entry.fileName, {
          type: entry.fileType,
          lastModified: entry.lastModified,
        });
        return {
          id: entry.id,
          file,
          objectUrl: URL.createObjectURL(file),
          markers: Array.isArray(entry.markers) ? entry.markers : [],
          selectedMarkerIds: Array.isArray(entry.selectedMarkerIds) ? entry.selectedMarkerIds : [],
        };
      });

      updateLibraryMeta();
      renderVideoList();

      const wantedId = savedMeta && savedMeta.currentVideoId;
      const targetId = state.videos.some((entry) => entry.id === wantedId) ? wantedId : state.videos[0].id;
      selectVideo(targetId);
    }
  } catch (error) {
    showNotice("恢复上次视频状态失败。", "warn");
  } finally {
    state.restoring = false;
  }
}

function cleanupObjectUrls() {
  state.videos.forEach((entry) => URL.revokeObjectURL(entry.objectUrl));
}

toggleActions(false);
updateLibraryMeta();
renderVideoList();
renderMarkerList();
syncBatchDeleteButton();
bindEvents();
void restoreVideoState();

window.addEventListener("beforeunload", cleanupObjectUrls);
