const state = {
  audioFiles: [],
  result: null,
  previewUrl: null,
};

// 生成唯一 ID 的降级方案（兼容 iframe 和非 HTTPS 环境）
function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 降级方案：使用时间戳 + 随机数
  return "id-" + Date.now() + "-" + Math.random().toString(36).substring(2, 15);
}

let audioContext = null;

function initAudioContext() {
  if (audioContext) return audioContext;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    console.log("AudioContext created, state:", audioContext.state);
  } catch (e) {
    console.error("Failed to create AudioContext:", e);
    return null;
  }
  if (audioContext.state === "suspended") {
    audioContext.resume().then(function() {
      console.log("AudioContext resumed successfully");
    }).catch(function(e) {
      console.warn("Failed to resume AudioContext:", e);
    });
  }
  return audioContext;
}

// 浏览器需要在用户交互时同步创建 AudioContext，不能等到 async 函数内
document.addEventListener("click", initAudioContext, { once: true });
document.addEventListener("touchstart", initAudioContext, { once: true });
// 也在页面加载时尝试初始化
window.addEventListener("load", function() {
  setTimeout(initAudioContext, 100);
});

function getAudioContext() {
  if (!audioContext) initAudioContext();
  return audioContext;
}

let moveDrag = null;

const elements = {
  audioInput: document.getElementById("audioInput"),
  uploadBox: document.getElementById("uploadBox"),
  fileList: document.getElementById("fileList"),
  mergeList: document.getElementById("mergeList"),
  sourceSelect: document.getElementById("sourceSelect"),
  sourceDuration: document.getElementById("sourceDuration"),
  sourceRate: document.getElementById("sourceRate"),
  sourceChannels: document.getElementById("sourceChannels"),
  trimStart: document.getElementById("trimStart"),
  trimEnd: document.getElementById("trimEnd"),
  speedControl: document.getElementById("speedControl"),
  speedValue: document.getElementById("speedValue"),
  reverseToggle: document.getElementById("reverseToggle"),
  processSingleBtn: document.getElementById("processSingleBtn"),
  previewSingleBtn: document.getElementById("previewSingleBtn"),
  mergeBtn: document.getElementById("mergeBtn"),
  resultPlayer: document.getElementById("resultPlayer"),
  downloadBtn: document.getElementById("downloadBtn"),
  clearResultBtn: document.getElementById("clearResultBtn"),
  resultFileName: document.getElementById("resultFileName"),
  videoPreview: document.getElementById("videoPreview"),
  rangeStart: document.getElementById("rangeStart"),
  rangeEnd: document.getElementById("rangeEnd"),
  rangeFill: document.getElementById("rangeFill"),
  formatSelect: document.getElementById("formatSelect"),
  statusMessage: document.getElementById("statusMessage"),
  playBtn: document.getElementById("playBtn"),
  timeDisplay: document.getElementById("timeDisplay"),
  playHead: document.getElementById("playHead"),
  playProgress: document.getElementById("playProgress"),
  dualSlider: document.getElementById("dualSlider"),
};

/* 自定义播放器控制 - 以选取范围为起止点 */
elements.playBtn.addEventListener("click", function() {
  var v = elements.videoPreview;
  if (v.paused) {
    var start = parseFloat(elements.trimStart.value) || 0
    if (v.currentTime < start || v.currentTime > parseFloat(elements.trimEnd.value || 0)) {
      v.currentTime = start
    }
    v.play().catch(function() {})
    elements.playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
  } else {
    v.pause()
    elements.playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="8,5 19,12 8,19"/></svg>'
  }
})

function fmtTime(t) {
  if (!t || !isFinite(t)) return "00:00"
  var m = Math.floor(t / 60)
  var s = Math.floor(t % 60)
  return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s
}

elements.videoPreview.addEventListener("timeupdate", function() {
  var v = this
  // 到达选取终点时暂停
  var end = parseFloat(elements.trimEnd.value)
  if (end > 0 && v.currentTime >= end && !v.paused) {
    v.pause()
    return
  }
  var pct = v.duration ? (v.currentTime / v.duration * 100) : 0
  elements.playHead.style.left = pct + "%"
  elements.playProgress.style.width = pct + "%"
  elements.timeDisplay.textContent = fmtTime(v.currentTime) + " / " + fmtTime(v.duration)
})

elements.videoPreview.addEventListener("loadedmetadata", function() {
  elements.timeDisplay.textContent = fmtTime(0) + " / " + fmtTime(this.duration)
  elements.playHead.style.left = "0%"
  elements.playProgress.style.width = "0%"
})

elements.videoPreview.addEventListener("play", function() {
  elements.playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
})

elements.videoPreview.addEventListener("pause", function() {
  elements.playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="8,5 19,12 8,19"/></svg>'
})

// 点击进度条跳转
elements.dualSlider.addEventListener("click", function(e) {
  if (e.target.closest(".dual-slider-range")) return
  var v = elements.videoPreview
  if (!v.duration) return
  var rect = this.getBoundingClientRect()
  var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  v.currentTime = pct * v.duration
})

elements.audioInput.addEventListener("change", handleFileImport);
// Document-level drag handlers: essential for iframe to accept drops from outside
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("drop", (e) => { e.preventDefault(); });
["dragenter", "dragover"].forEach((eventName) => {
  elements.uploadBox.addEventListener(eventName, handleDragEnter);
});
["dragleave", "dragend"].forEach((eventName) => {
  elements.uploadBox.addEventListener(eventName, handleDragLeave);
});
elements.uploadBox.addEventListener("drop", handleFileDrop);
elements.sourceSelect.addEventListener("change", syncSelectedFileStats);
elements.speedControl.addEventListener("input", () => {
  elements.speedValue.textContent = `${Number(elements.speedControl.value).toFixed(2)}x`;
});
elements.trimStart.addEventListener("input", syncTrimToRange);
elements.trimEnd.addEventListener("input", syncTrimToRange);
elements.rangeStart.addEventListener("input", syncRangeToTrim);
elements.rangeEnd.addEventListener("input", syncRangeToTrim);
elements.processSingleBtn.addEventListener("click", processSingleFile);
elements.previewSingleBtn.addEventListener("click", previewSelectedSource);
elements.mergeBtn.addEventListener("click", mergeSelectedFiles);
elements.downloadBtn.addEventListener("click", downloadResult);
elements.clearResultBtn.addEventListener("click", clearResult);

// dual-slider middle-drag (move entire selection)
elements.rangeStart.parentElement.addEventListener("mousedown", (event) => {
  moveDrag = null;
  const sel = getSelectedSource();
  if (!sel) return;
  const max = parseFloat(elements.rangeStart.max);
  if (max <= 0) return;

  const rect = event.currentTarget.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const pct = mx / rect.width;
  const sp = parseFloat(elements.rangeStart.value) / max;
  const ep = parseFloat(elements.rangeEnd.value) / max;
  const hitPx = 8 / rect.width; // thumb half-width as percentage

  if (pct > sp + hitPx && pct < ep - hitPx) {
    moveDrag = { startVal: parseFloat(elements.rangeStart.value), endVal: parseFloat(elements.rangeEnd.value), offPct: pct - sp, max };
    event.preventDefault();
  }
});

document.addEventListener("mousemove", (event) => {
  if (!moveDrag) return;
  const rect = elements.rangeStart.parentElement.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const pct = mx / rect.width;
  const dur = moveDrag.endVal - moveDrag.startVal;
  const durPct = dur / moveDrag.max;
  const newSP = Math.max(0, Math.min(1 - durPct, pct - moveDrag.offPct));
  const ns = newSP * moveDrag.max;
  elements.rangeStart.value = ns;
  elements.rangeEnd.value = ns + dur;
  elements.trimStart.value = ns.toFixed(2);
  elements.trimEnd.value = (ns + dur).toFixed(2);
  updateRangeFill();
});

document.addEventListener("mouseup", () => { moveDrag = null; });

function setStatus(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.style.color = isError ? "#a12d2d" : "";
}

async function handleFileImport(event) {
  const files = Array.from(event.target.files || []);
  await importFiles(files);
  event.target.value = "";
}

function updateRangeFill() {
  const s = parseFloat(elements.rangeStart.value);
  const e = parseFloat(elements.rangeEnd.value);
  const max = parseFloat(elements.rangeStart.max) || 1;
  const ps = (s / max) * 100;
  const pe = (e / max) * 100;
  elements.rangeFill.style.left = Math.min(ps, pe) + "%";
  elements.rangeFill.style.width = Math.abs(pe - ps) + "%";
}

function syncRangeToTrim() {
  const s = parseFloat(elements.rangeStart.value);
  const e = parseFloat(elements.rangeEnd.value);
  if (s >= e) {
    // keep start before end
    if (this === elements.rangeStart) elements.rangeStart.value = Math.max(0, e - 0.01);
    else elements.rangeEnd.value = Math.min(parseFloat(elements.rangeEnd.max), s + 0.01);
  }
  elements.trimStart.value = elements.rangeStart.value;
  elements.trimEnd.value = elements.rangeEnd.value;
  updateRangeFill();
  // 拖动范围手柄时更新视频预览
  var v = elements.videoPreview
  if (v && v.duration && this && (this === elements.rangeStart || this === elements.rangeEnd)) {
    v.currentTime = parseFloat(this.value)
  }
}

function syncTrimToRange() {
  elements.rangeStart.value = elements.trimStart.value;
  elements.rangeEnd.value = elements.trimEnd.value;
  updateRangeFill();
}

function handleDragEnter(event) {
  event.preventDefault();
  elements.uploadBox.classList.add("is-dragging");
}

function handleDragLeave(event) {
  event.preventDefault();
  if (event.relatedTarget && elements.uploadBox.contains(event.relatedTarget)) {
    return;
  }
  elements.uploadBox.classList.remove("is-dragging");
}

async function handleFileDrop(event) {
  event.preventDefault();
  elements.uploadBox.classList.remove("is-dragging");
  const files = Array.from(event.dataTransfer?.files || []).filter(
    (file) => file.type.startsWith("audio/") || file.type.startsWith("video/")
      || /\.(mp3|wav|flac|ogg|aac|wma|m4a|opus|webm|mp4|avi|mov|mkv|wmv|flv)$/i.test(file.name)
  );
  await importFiles(files);
}

async function importFiles(files) {
  if (!files.length) {
    setStatus("未检测到可导入的文件", true);
    return;
  }

  // Verify AudioContext is available before processing
  var ctx = getAudioContext();
  if (!ctx) {
    setStatus("浏览器不支持音频解码，请使用 Chrome 或 Firefox", true);
    return;
  }

  // 确保 AudioContext 已启动
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (e) {
      console.warn("Failed to resume AudioContext:", e);
    }
  }

  setStatus("正在解析文件...");
  var successCount = 0;
  var failCount = 0;
  var lastError = "";

  for (const file of files) {
    let blobUrl = null;
    try {
      let audioBuffer;
      if (file.type.startsWith("video/")) {
        blobUrl = URL.createObjectURL(file);
        audioBuffer = await audioFromVideo(file);
      } else {
        const arrayBuffer = await file.arrayBuffer();
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error("文件内容为空");
        }
        // decodeAudioData（AudioContext 已在 importFiles 入口处确保 resume）
        audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer.slice(0));
      }
      state.audioFiles.push({
        id: generateId(),
        name: file.name,
        file,
        audioBuffer,
        blobUrl,
        selectedForMerge: true,
      });
      successCount++;
    } catch (error) {
      failCount++;
      lastError = error.message || String(error);
      setStatus(`解析失败：${file.name} - ${lastError}`, true);
      console.error("Import error:", error);
    }
  }

  renderFileList();
  renderSourceOptions();
  renderMergeList();
  syncSelectedFileStats();
  if (failCount > 0 && successCount === 0) {
    setStatus(`导入失败：${lastError}。建议在主页面直接上传音频文件。`, true);
  } else if (failCount > 0) {
    setStatus(`已导入 ${successCount} 个文件（${failCount} 个失败）`);
  } else {
    setStatus(`已导入 ${successCount} 个文件`);
  }
}

async function audioFromVideo(file) {
  const arrayBuffer = await file.arrayBuffer();
  // Modern browsers (Chrome, Firefox, Edge, Safari) can demux audio
  // from common video containers (MP4/AAC, WebM/Vorbis, WebM/Opus, MOV)
  // via decodeAudioData itself.
  var ctx = getAudioContext();
  if (!ctx) throw new Error("浏览器不支持音频解码");
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch (e) { console.warn("resume failed:", e); }
  }
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    console.warn("decodeAudioData for video failed:", e);
    // Fallback: render short video segments via <video> element
    return extractAudioFromVideoElement(file);
  }
}

async function extractAudioFromVideoElement(file) {
  const url = URL.createObjectURL(file);

  try {
    // Probe duration
    const probe = document.createElement("video");
    probe.preload = "auto";
    probe.muted = true;
    probe.src = url;
    await new Promise((resolve, reject) => {
      probe.addEventListener("loadedmetadata", resolve, { once: true });
      probe.addEventListener("error", () => reject(new Error("视频加载失败")), { once: true });
      probe.load();
    });

    const duration = probe.duration;
    if (!isFinite(duration) || duration <= 0) throw new Error("无法获取视频时长");

    const sampleRate = getAudioContext().sampleRate;
    const channels = Math.min(getAudioContext().destination.maxChannelCount || 2, 2);
    const totalSamples = Math.ceil(duration * sampleRate);
    const SEGMENT = 10; // seconds per chunk (keep small so render keeps up with playback)

    const merged = new AudioBuffer({
      length: totalSamples,
      numberOfChannels: channels,
      sampleRate,
    });

    for (let segStart = 0; segStart < duration; segStart += SEGMENT) {
      const segEnd = Math.min(segStart + SEGMENT, duration);
      const segSamples = Math.ceil((segEnd - segStart) * sampleRate);
      const writeOffset = Math.round(segStart * sampleRate);

      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = url;

      await new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => {
          video.currentTime = segStart;
          resolve();
        }, { once: true });
        video.addEventListener("error", () => reject(new Error("视频片段加载失败")), { once: true });
        video.load();
      });
      await new Promise((r) => video.addEventListener("seeked", r, { once: true }));

      const offlineCtx = new OfflineAudioContext({
        numberOfChannels: channels,
        sampleRate,
        length: segSamples,
      });
      const source = offlineCtx.createMediaElementSource(video);
      source.connect(offlineCtx.destination);

      await video.play();
      try {
        const chunk = await offlineCtx.startRendering();
        for (let ch = 0; ch < channels; ch++) {
          merged.getChannelData(ch).set(chunk.getChannelData(ch), writeOffset);
        }
      } finally {
        video.pause();
      }
    }

    return merged;
  } finally {
    URL.revokeObjectURL(url);
  }
}


function renderFileList() {
  if (!state.audioFiles.length) {
    elements.fileList.className = "file-list empty-state";
    elements.fileList.textContent = "尚未导入音频";
    return;
  }

  elements.fileList.className = "file-list";
  elements.fileList.innerHTML = "";

  state.audioFiles.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "file-item";
    card.innerHTML = `
      <div class="file-meta">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${formatDuration(item.audioBuffer.duration)} / ${item.audioBuffer.numberOfChannels} 声道</span>
      </div>
      <div class="item-actions">
        <button type="button" data-action="up" data-id="${item.id}" ${index === 0 ? "disabled" : ""}>上移</button>
        <button type="button" data-action="down" data-id="${item.id}" ${index === state.audioFiles.length - 1 ? "disabled" : ""}>下移</button>
        <button type="button" data-action="remove" data-id="${item.id}" class="secondary">删除</button>
      </div>
    `;
    elements.fileList.appendChild(card);
  });

  elements.fileList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", handleFileAction);
  });
}

function renderSourceOptions() {
  elements.sourceSelect.innerHTML = "";

  if (!state.audioFiles.length) {
    const option = document.createElement("option");
    option.textContent = "请先导入音频";
    option.value = "";
    elements.sourceSelect.appendChild(option);
    return;
  }

  state.audioFiles.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    elements.sourceSelect.appendChild(option);
  });
}

function renderMergeList() {
  const mergeItems = state.audioFiles.filter((item) => item.selectedForMerge);
  if (state.audioFiles.length < 2) {
    elements.mergeList.className = "merge-list empty-state";
    elements.mergeList.textContent = "至少导入两个文件后再合并";
    return;
  }

  elements.mergeList.className = "merge-list";
  elements.mergeList.innerHTML = "";

  state.audioFiles.forEach((item) => {
    const row = document.createElement("label");
    row.className = "merge-item";
    row.innerHTML = `
      <div class="merge-meta">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${formatDuration(item.audioBuffer.duration)}</span>
      </div>
      <div class="item-actions">
        <input type="checkbox" data-id="${item.id}" ${item.selectedForMerge ? "checked" : ""}>
      </div>
    `;
    elements.mergeList.appendChild(row);
  });

  elements.mergeList.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const file = state.audioFiles.find((item) => item.id === event.target.dataset.id);
      if (file) {
        file.selectedForMerge = event.target.checked;
        setStatus(`当前合并队列：${state.audioFiles.filter((item) => item.selectedForMerge).length} 个文件`);
      }
    });
  });

  if (mergeItems.length < 2) {
    setStatus("合并至少需要选中两个音频文件");
  }
}

function handleFileAction(event) {
  const { action, id } = event.target.dataset;
  const index = state.audioFiles.findIndex((item) => item.id === id);
  if (index === -1) {
    return;
  }

  if (action === "remove") {
    const removed = state.audioFiles[index];
    if (removed.blobUrl) URL.revokeObjectURL(removed.blobUrl);
    state.audioFiles.splice(index, 1);
  }

  if (action === "up" && index > 0) {
    [state.audioFiles[index - 1], state.audioFiles[index]] = [state.audioFiles[index], state.audioFiles[index - 1]];
  }

  if (action === "down" && index < state.audioFiles.length - 1) {
    [state.audioFiles[index + 1], state.audioFiles[index]] = [state.audioFiles[index], state.audioFiles[index + 1]];
  }

  renderFileList();
  renderSourceOptions();
  renderMergeList();
  syncSelectedFileStats();
  setStatus("文件列表已更新");
}

function syncSelectedFileStats() {
  const selected = getSelectedSource();
  if (!selected) {
    elements.sourceDuration.textContent = "--";
    elements.sourceRate.textContent = "--";
    elements.sourceChannels.textContent = "--";
    elements.trimStart.value = 0;
    elements.trimEnd.value = 0;
    elements.videoPreview.src = "";
    elements.videoPreview.hidden = true;
    elements.rangeStart.max = 0;
    elements.rangeEnd.max = 0;
    elements.rangeStart.value = 0;
    elements.rangeEnd.value = 0;
    updateRangeFill();
    return;
  }

  elements.sourceDuration.textContent = formatDuration(selected.audioBuffer.duration);
  elements.sourceRate.textContent = `${selected.audioBuffer.sampleRate} Hz`;
  elements.sourceChannels.textContent = `${selected.audioBuffer.numberOfChannels} ch`;
  elements.trimStart.max = selected.audioBuffer.duration.toFixed(2);
  elements.trimEnd.max = selected.audioBuffer.duration.toFixed(2);
  elements.trimEnd.value = selected.audioBuffer.duration.toFixed(2);

  if (selected.blobUrl) {
    elements.videoPreview.src = selected.blobUrl;
    elements.videoPreview.hidden = false;
  } else {
    elements.videoPreview.src = "";
    elements.videoPreview.hidden = true;
  }

  // sync range slider
  const dur = selected.audioBuffer.duration;
  elements.rangeStart.max = dur;
  elements.rangeEnd.max = dur;
  elements.rangeStart.value = 0;
  elements.rangeEnd.value = dur.toFixed(2);
  updateRangeFill();
}

function getSelectedSource() {
  return state.audioFiles.find((item) => item.id === elements.sourceSelect.value) || state.audioFiles[0] || null;
}

async function processSingleFile() {
  const selected = getSelectedSource();
  if (!selected) {
    setStatus("请先导入并选择音频文件", true);
    return;
  }

  const start = Number(elements.trimStart.value || 0);
  const requestedEnd = Number(elements.trimEnd.value || selected.audioBuffer.duration);
  const speed = Number(elements.speedControl.value);
  const shouldReverse = elements.reverseToggle.checked;
  const end = Math.min(Math.max(requestedEnd, 0), selected.audioBuffer.duration);

  if (start >= end) {
    setStatus("裁切参数无效：开始时间必须小于结束时间", true);
    return;
  }

  setStatus("正在生成处理结果...");

  try {
    let processed = trimAudioBuffer(selected.audioBuffer, start, end);
    if (shouldReverse) {
      processed = reverseAudioBuffer(processed);
    }
    if (speed !== 1) {
      processed = changeAudioSpeed(processed, speed);
    }

    await setResult(processed, `${selected.name} - 已处理`);
    setStatus("单文件处理完成");
  } catch (error) {
    setStatus("处理失败，请查看控制台日志", true);
    console.error(error);
  }
}

function previewSelectedSource() {
  const selected = getSelectedSource();
  if (!selected) {
    setStatus("请先选择音频", true);
    return;
  }

  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  const blob = audioBufferToWavBlob(selected.audioBuffer);
  state.previewUrl = URL.createObjectURL(blob);
  elements.resultPlayer.src = state.previewUrl;
  elements.resultPlayer.play().catch(() => {});
  setStatus(`正在预览：${selected.name}`);
}

async function mergeSelectedFiles() {
  const selectedItems = state.audioFiles.filter((item) => item.selectedForMerge);
  if (selectedItems.length < 2) {
    setStatus("请至少勾选两个音频用于合并", true);
    return;
  }

  setStatus("正在合并音频...");

  try {
    const sampleRate = Math.max(...selectedItems.map((item) => item.audioBuffer.sampleRate));
    const channels = Math.max(...selectedItems.map((item) => item.audioBuffer.numberOfChannels));
    const totalDuration = selectedItems.reduce((sum, item) => sum + item.audioBuffer.duration, 0);
    const mergedBuffer = new AudioBuffer({
      length: Math.ceil(totalDuration * sampleRate),
      numberOfChannels: channels,
      sampleRate,
    });

    let writeOffset = 0;
    selectedItems.forEach((item) => {
      const normalized = normalizeBuffer(item.audioBuffer, channels, sampleRate);
      for (let channel = 0; channel < channels; channel += 1) {
        mergedBuffer.getChannelData(channel).set(normalized.getChannelData(channel), writeOffset);
      }
      writeOffset += normalized.length;
    });

    await setResult(mergedBuffer, "merged-audio");
    setStatus("音频合并完成");
  } catch (error) {
    setStatus("合并失败，请查看控制台日志", true);
    console.error(error);
  }
}

async function setResult(audioBuffer, filename) {
  if (state.result?.wavUrl) {
    URL.revokeObjectURL(state.result.wavUrl);
  }

  const wavBlob = audioBufferToWavBlob(audioBuffer);
  const wavUrl = URL.createObjectURL(wavBlob);
  const baseName = filename.replace(/\.wav$/i, "");

  state.result = { audioBuffer, wavBlob, wavUrl, filename: baseName };
  elements.resultFileName.value = baseName;
  elements.resultPlayer.src = wavUrl;
  elements.downloadBtn.disabled = false;
}

function triggerDownload(url, filename) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}

function getDownloadFilename(baseName, ext) {
  const dot = "." + ext;
  const trimmed = (baseName || "").trim();
  if (!trimmed) return "output" + dot;
  return trimmed.replace(/\.(wav|mp3|flac|webm)$/i, "") + dot;
}

async function downloadResult() {
  if (!state.result) return;

  const baseName = elements.resultFileName.value.trim() || state.result.filename || "output";
  const format = elements.formatSelect.value;

  if (format === "wav") {
    triggerDownload(state.result.wavUrl, getDownloadFilename(baseName, "wav"));
    return;
  }

  await encodeAndDownload(baseName, format);
}

async function encodeAndDownload(baseName, format) {
  const statusMap = {
    mp3: "正在编码 MP3（从 CDN 加载编码器）...",
    flac: "正在编码 FLAC...",
    webm: "正在编码 WebM（实时编码，请等待）...",
  };
  const encoderMap = {
    mp3: encodeMP3,
    flac: encodeFLAC,
    webm: encodeWebM,
  };

  setStatus(statusMap[format] || "正在编码...");
  elements.downloadBtn.disabled = true;
  try {
    const blob = await encoderMap[format](state.result.audioBuffer);
    const url = URL.createObjectURL(blob);
    triggerDownload(url, getDownloadFilename(baseName, format));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus(`${format.toUpperCase()} 导出完成`);
  } catch (err) {
    setStatus(`${format.toUpperCase()} 编码失败：${err.message}`, true);
    console.error(err);
  } finally {
    elements.downloadBtn.disabled = false;
  }
}

function encodeWebM(audioBuffer) {
  return new Promise((resolve, reject) => {
    let mimeType = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "audio/webm";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        reject(new Error("浏览器不支持 WebM 编码"));
        return;
      }
    }

    const ctx = new AudioContext({ sampleRate: audioBuffer.sampleRate });

    const streamDest = ctx.createMediaStreamDestination();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(streamDest);

    const chunks = [];
    const recorder = new MediaRecorder(streamDest.stream, { mimeType });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      ctx.close();
      resolve(new Blob(chunks, { type: mimeType }));
    };
    recorder.onerror = () => { ctx.close(); reject(new Error("编码出错")); };

    (ctx.state === "suspended" ? ctx.resume() : Promise.resolve()).then(() => {
      recorder.start();
      source.start(0);
    }).catch(reject);

    // safety: stop when source ends
    source.onended = () => {
      if (recorder.state === "recording") recorder.stop();
    };
    setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, audioBuffer.duration * 1000 + 5000);
  });
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error("加载编码库失败，请检查网络"));
    document.head.appendChild(s);
  });
}

function floatTo16BitPCM(src) {
  const buf = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return buf;
}

async function encodeMP3(audioBuffer) {
  if (typeof lamejs === "undefined") {
    await loadScript("https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js");
  }

  const ch = audioBuffer.numberOfChannels;
  const sr = audioBuffer.sampleRate;
  const chData = [];
  for (let c = 0; c < ch; c++) chData.push(floatTo16BitPCM(audioBuffer.getChannelData(c)));

  const enc = new lamejs.Mp3Encoder(ch, sr, 192);
  const parts = [];
  const BS = 1152;

  for (let i = 0; i < chData[0].length; i += BS) {
    const end = Math.min(i + BS, chData[0].length);
    const L = chData[0].subarray(i, end);
    const R = ch > 1 ? chData[1].subarray(i, end) : null;
    const buf = R ? enc.encodeBuffer(L, R) : enc.encodeBuffer(L);
    if (buf.length) parts.push(new Uint8Array(buf));
  }

  const last = enc.flush();
  if (last.length) parts.push(new Uint8Array(last));
  return new Blob(parts, { type: "audio/mpeg" });
}

// ── Minimal FLAC encoder (VERBATIM subframes) ────────────

function flacCRC8(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

function flacCRC16(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= (bytes[i] << 8);
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

function flacUtf8(v) {
  if (v < 128) return [v];
  if (v < 16384) return [0xc0 | (v >> 6), 0x80 | (v & 0x3f)];
  if (v < 2097152) return [0xe0 | (v >> 12), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f)];
  return [0xf0 | (v >> 18), 0x80 | ((v >> 12) & 0x3f), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f)];
}

function encodeFLAC(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const sr = audioBuffer.sampleRate;
  const BS = 4096;
  const total = audioBuffer.length;
  const nf = Math.ceil(total / BS);
  const int = [];
  for (let c = 0; c < ch; c++) int.push(floatTo16BitPCM(audioBuffer.getChannelData(c)));

  const parts = [];

  // ── STREAMINFO metadata block (38 bytes: 4 header + 34 data) ──
  const info = new ArrayBuffer(38);
  const dv = new DataView(info);
  dv.setUint8(0, 0x80);                  // is_last=1, type=STREAMINFO(0)
  dv.setUint8(1, 0); dv.setUint8(2, 0); dv.setUint8(3, 34); // length=34
  dv.setUint16(4, BS, false);             // min block size
  dv.setUint16(6, BS, false);             // max block size
  // min/max frame size (24-bit each) stay 0 (unknown)
  const bps = 16, bps1 = bps - 1, ch1 = ch - 1;
  dv.setUint8(14, (sr >> 12) & 0xff);
  dv.setUint8(15, (sr >> 4) & 0xff);
  dv.setUint8(16, ((sr & 0xf) << 4) | ((ch1 & 7) << 1) | ((bps1 >> 4) & 1));
  dv.setUint8(17, ((bps1 & 0xf) << 4) | 0); // total_samples[35:32] = 0 (fits in 32-bit)
  dv.setUint8(18, (total >>> 24) & 0xff);
  dv.setUint8(19, (total >>> 16) & 0xff);
  dv.setUint8(20, (total >>> 8) & 0xff);
  dv.setUint8(21, total & 0xff);
  // MD5 (bytes 22-37) is already zero
  parts.push(new Uint8Array(info));

  // ── Frame encoding ──
  function bscode(s) { const m = {192:1, 576:2, 1152:3, 2304:4, 4608:5, 256:8, 512:9, 1024:10, 2048:11, 4096:12, 8192:13, 16384:14, 32768:15}; return m[s] || 12; }
  function srcode(s) { const m = {88200:1, 176400:2, 192000:3, 8000:4, 16000:5, 22050:6, 24000:7, 32000:8, 44100:9, 48000:10, 96000:11}; return m[s] !== undefined ? m[s] : 0; }

  const bsc = bscode(BS);
  const src = srcode(sr);

  for (let f = 0; f < nf; f++) {
    const off = f * BS;
    const cur = Math.min(BS, total - off);

    // frame header
    const h = [0xff, 0xf8, (bsc << 4) | src, ((ch1) << 4) | (3 << 1), ...flacUtf8(f)];
    h.push(flacCRC8(h));

    // subframes (VERBATIM)
    const fb = h.slice();
    for (let c = 0; c < ch; c++) {
      fb.push(0x02);
      for (let i = 0; i < cur; i++) {
        const v = int[c][off + i];
        fb.push((v >> 8) & 0xff, v & 0xff);
      }
    }

    const crc16 = flacCRC16(fb);
    fb.push((crc16 >> 8) & 0xff, crc16 & 0xff);
    parts.push(new Uint8Array(fb));
  }

  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return new Blob([out], { type: "audio/flac" });
}

function clearResult() {
  if (state.result?.wavUrl) {
    URL.revokeObjectURL(state.result.wavUrl);
  }
  state.result = null;
  elements.resultFileName.value = "";
  elements.resultPlayer.removeAttribute("src");
  elements.resultPlayer.load();
  elements.downloadBtn.disabled = true;
  setStatus("结果已清空");
}

function trimAudioBuffer(audioBuffer, startSeconds, endSeconds) {
  const startOffset = Math.floor(startSeconds * audioBuffer.sampleRate);
  const endOffset = Math.floor(endSeconds * audioBuffer.sampleRate);
  const frameCount = endOffset - startOffset;
  const trimmed = new AudioBuffer({
    length: frameCount,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
  });

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const slice = audioBuffer.getChannelData(channel).slice(startOffset, endOffset);
    trimmed.copyToChannel(slice, channel);
  }

  return trimmed;
}

function reverseAudioBuffer(audioBuffer) {
  const reversed = new AudioBuffer({
    length: audioBuffer.length,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
  });

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const source = audioBuffer.getChannelData(channel);
    const target = reversed.getChannelData(channel);
    for (let i = 0; i < source.length; i += 1) {
      target[i] = source[source.length - 1 - i];
    }
  }

  return reversed;
}

function changeAudioSpeed(audioBuffer, speed) {
  const targetLength = Math.max(1, Math.floor(audioBuffer.length / speed));
  const spedUp = new AudioBuffer({
    length: targetLength,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
  });

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const source = audioBuffer.getChannelData(channel);
    const target = spedUp.getChannelData(channel);
    for (let i = 0; i < targetLength; i += 1) {
      const sourceIndex = i * speed;
      const left = Math.floor(sourceIndex);
      const right = Math.min(source.length - 1, left + 1);
      const ratio = sourceIndex - left;
      target[i] = source[left] * (1 - ratio) + source[right] * ratio;
    }
  }

  return spedUp;
}

function normalizeBuffer(audioBuffer, targetChannels, targetRate) {
  let buffer = audioBuffer;
  if (buffer.sampleRate !== targetRate) {
    buffer = resampleBuffer(buffer, targetRate);
  }

  if (buffer.numberOfChannels === targetChannels) {
    return buffer;
  }

  const normalized = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: targetChannels,
    sampleRate: targetRate,
  });

  for (let channel = 0; channel < targetChannels; channel += 1) {
    const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
    normalized.copyToChannel(buffer.getChannelData(sourceChannel), channel);
  }

  return normalized;
}

function resampleBuffer(audioBuffer, targetRate) {
  const targetLength = Math.max(1, Math.round(audioBuffer.duration * targetRate));
  const resampled = new AudioBuffer({
    length: targetLength,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: targetRate,
  });

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const source = audioBuffer.getChannelData(channel);
    const target = resampled.getChannelData(channel);
    for (let i = 0; i < targetLength; i += 1) {
      const sourceIndex = (i / targetRate) * audioBuffer.sampleRate;
      const left = Math.floor(sourceIndex);
      const right = Math.min(source.length - 1, left + 1);
      const ratio = sourceIndex - left;
      target[i] = source[left] * (1 - ratio) + source[right] * ratio;
    }
  }

  return resampled;
}

function audioBufferToWavBlob(audioBuffer) {
  const wavArrayBuffer = encodeWav(audioBuffer);
  return new Blob([wavArrayBuffer], { type: "audio/wav" });
}

function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = samples * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let channel = 0; channel < channels; channel += 1) {
    channelData.push(audioBuffer.getChannelData(channel));
  }

  let offset = 44;
  for (let sample = 0; sample < samples; sample += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, channelData[channel][sample]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  }

  return buffer;
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}
