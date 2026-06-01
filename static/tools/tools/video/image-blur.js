const blurState = {
  image: null,
  imageUrl: null,
  fileName: "",
  isDrawing: false,
  hasMask: false,
  tool: "draw",
  lastPoint: null,
  history: [],
  redoHistory: [],
  pendingHistoryCommit: false,
  restoring: false,
};

const GLASS_EFFECT = {
  blur: 22,
  saturation: 0.9,
  brightness: 1.04,
  contrast: 1.03,
};

const blurElements = {
  imageDropZone: document.getElementById("imageDropZone"),
  imageInput: document.getElementById("imageInput"),
  imageNotice: document.getElementById("imageNotice"),
  imageMeta: document.getElementById("imageMeta"),
  canvasMeta: document.getElementById("canvasMeta"),
  previewCanvas: document.getElementById("previewCanvas"),
  maskCanvas: document.getElementById("maskCanvas"),
  guideCanvas: document.getElementById("guideCanvas"),
  blurCanvasWrap: document.getElementById("blurCanvasWrap"),
  brushSizeInput: document.getElementById("brushSizeInput"),
  brushSizeValue: document.getElementById("brushSizeValue"),
  blurInput: document.getElementById("blurInput"),
  blurValue: document.getElementById("blurValue"),
  opacityInput: document.getElementById("opacityInput"),
  opacityValue: document.getElementById("opacityValue"),
  drawModeButton: document.getElementById("drawModeButton"),
  eraseModeButton: document.getElementById("eraseModeButton"),
  clearMaskButton: document.getElementById("clearMaskButton"),
  exportImageButton: document.getElementById("exportImageButton"),
  undoButton: document.getElementById("undoButton"),
  redoButton: document.getElementById("redoButton"),
};

const previewContext = blurElements.previewCanvas.getContext("2d");
const maskContext = blurElements.maskCanvas.getContext("2d");

function showImageNotice(message, type = "success") {
  blurElements.imageNotice.textContent = message;
  blurElements.imageNotice.className = `notice ${type}`;
}

function clearImageNotice() {
  blurElements.imageNotice.textContent = "";
  blurElements.imageNotice.className = "notice hidden";
}

function revokeImageUrl() {
  if (blurState.imageUrl) {
    URL.revokeObjectURL(blurState.imageUrl);
    blurState.imageUrl = null;
  }
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = /data:(.*?);base64/.exec(header);
  const mime = mimeMatch ? mimeMatch[1] : "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function updateSliderLabels() {
  blurElements.brushSizeValue.textContent = `${blurElements.brushSizeInput.value} px`;
  blurElements.blurValue.textContent = `${blurElements.blurInput.value} px`;
  blurElements.opacityValue.textContent = `${Math.round(Number(blurElements.opacityInput.value) * 100)}%`;
}

function setCanvasRatio(width, height) {
  blurElements.blurCanvasWrap.style.setProperty("--media-ratio", `${width} / ${height}`);
}

function setCanvasSize(width, height) {
  blurElements.previewCanvas.width = width;
  blurElements.previewCanvas.height = height;
  blurElements.maskCanvas.width = width;
  blurElements.maskCanvas.height = height;
  blurElements.guideCanvas.width = width;
  blurElements.guideCanvas.height = height;
  setCanvasRatio(width, height);
}

function toggleImageActions(enabled) {
  blurElements.clearMaskButton.disabled = !enabled;
  blurElements.exportImageButton.disabled = !enabled;
  blurElements.undoButton.disabled = !enabled || blurState.history.length <= 1;
  blurElements.redoButton.disabled = !enabled || !blurState.redoHistory.length;
}

function updateMaskPresence() {
  const { width, height } = blurElements.maskCanvas;
  if (!width || !height) {
    blurState.hasMask = false;
    return;
  }
  const pixels = maskContext.getImageData(0, 0, width, height).data;
  blurState.hasMask = false;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) {
      blurState.hasMask = true;
      break;
    }
  }
}

function snapshotMask() {
  const { width, height } = blurElements.maskCanvas;
  return maskContext.getImageData(0, 0, width, height);
}

function restoreMask(snapshot) {
  maskContext.clearRect(0, 0, blurElements.maskCanvas.width, blurElements.maskCanvas.height);
  if (snapshot) {
    maskContext.putImageData(snapshot, 0, 0);
  }
  updateMaskPresence();
  renderComposite();
  toggleImageActions(Boolean(blurState.image));
}

function pushHistorySnapshot() {
  blurState.history.push(snapshotMask());
  blurState.redoHistory = [];
  toggleImageActions(Boolean(blurState.image));
  void persistImageState();
}

function resetHistory() {
  blurState.history = [];
  blurState.redoHistory = [];
  if (blurState.image) {
    blurState.history.push(snapshotMask());
  }
  toggleImageActions(Boolean(blurState.image));
}

function getBrushSettings() {
  return {
    size: Number(blurElements.brushSizeInput.value),
  };
}

function renderComposite() {
  const image = blurState.image;
  if (!image) return;

  const width = blurElements.previewCanvas.width;
  const height = blurElements.previewCanvas.height;
  previewContext.clearRect(0, 0, width, height);
  previewContext.drawImage(image, 0, 0, width, height);

  if (!blurState.hasMask) {
    return;
  }

  const blurredCanvas = document.createElement("canvas");
  blurredCanvas.width = width;
  blurredCanvas.height = height;
  const blurredContext = blurredCanvas.getContext("2d");
  const blurValue = Number(blurElements.blurInput.value || GLASS_EFFECT.blur);
  blurredContext.filter = `blur(${blurValue}px) saturate(${GLASS_EFFECT.saturation}) brightness(${GLASS_EFFECT.brightness}) contrast(${GLASS_EFFECT.contrast})`;
  blurredContext.drawImage(image, 0, 0, width, height);
  blurredContext.filter = "none";

  const maskedCanvas = document.createElement("canvas");
  maskedCanvas.width = width;
  maskedCanvas.height = height;
  const maskedContext = maskedCanvas.getContext("2d");
  maskedContext.drawImage(blurredCanvas, 0, 0);
  maskedContext.globalCompositeOperation = "destination-in";
  maskedContext.drawImage(blurElements.maskCanvas, 0, 0);
  maskedContext.globalCompositeOperation = "source-over";

  previewContext.save();
  previewContext.globalAlpha = Number(blurElements.opacityInput.value || 1);
  previewContext.drawImage(maskedCanvas, 0, 0);
  previewContext.restore();
}

function clearMask(recordHistory = false) {
  maskContext.clearRect(0, 0, blurElements.maskCanvas.width, blurElements.maskCanvas.height);
  blurState.hasMask = false;
  renderComposite();
  if (recordHistory) {
    pushHistorySnapshot();
  } else {
    toggleImageActions(Boolean(blurState.image));
    void persistImageState();
  }
}

function updateToolButtons() {
  blurElements.drawModeButton.classList.toggle("active-tool", blurState.tool === "draw");
  blurElements.eraseModeButton.classList.toggle("active-tool", blurState.tool === "erase");
}

function canvasPointFromEvent(event) {
  const rect = blurElements.guideCanvas.getBoundingClientRect();
  const scaleX = blurElements.guideCanvas.width / rect.width;
  const scaleY = blurElements.guideCanvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function drawStroke(from, to) {
  const { size } = getBrushSettings();
  maskContext.save();
  maskContext.lineCap = "round";
  maskContext.lineJoin = "round";
  maskContext.lineWidth = size;

  if (blurState.tool === "erase") {
    maskContext.globalCompositeOperation = "destination-out";
    maskContext.strokeStyle = "rgba(0,0,0,1)";
  } else {
    maskContext.globalCompositeOperation = "source-over";
    maskContext.strokeStyle = "rgba(255,255,255,1)";
  }

  maskContext.beginPath();
  maskContext.moveTo(from.x, from.y);
  maskContext.lineTo(to.x, to.y);
  maskContext.stroke();
  maskContext.restore();

  blurState.hasMask = true;
  renderComposite();
}

function startDrawing(event) {
  if (!blurState.image) return;
  blurState.isDrawing = true;
  blurState.pendingHistoryCommit = true;
  const point = canvasPointFromEvent(event);
  blurState.lastPoint = point;
  drawStroke(point, point);
}

function moveDrawing(event) {
  if (!blurState.isDrawing || !blurState.lastPoint) return;
  const point = canvasPointFromEvent(event);
  drawStroke(blurState.lastPoint, point);
  blurState.lastPoint = point;
}

function stopDrawing() {
  if (blurState.isDrawing && blurState.pendingHistoryCommit) {
    pushHistorySnapshot();
  }
  blurState.isDrawing = false;
  blurState.lastPoint = null;
  blurState.pendingHistoryCommit = false;
}

function undoMask() {
  if (blurState.history.length <= 1) return;
  const current = blurState.history.pop();
  blurState.redoHistory.push(current);
  restoreMask(blurState.history[blurState.history.length - 1]);
  void persistImageState();
}

function redoMask() {
  if (!blurState.redoHistory.length) return;
  const snapshot = blurState.redoHistory.pop();
  blurState.history.push(snapshot);
  restoreMask(snapshot);
  void persistImageState();
}

async function persistImageState() {
  if (blurState.restoring || !blurState.image) {
    return;
  }

  const payload = {
    fileName: blurState.fileName,
    imageBlob: blurState.imageBlob,
    settings: {
      brushSize: blurElements.brushSizeInput.value,
      blur: blurElements.blurInput.value,
      opacity: blurElements.opacityInput.value,
      tool: blurState.tool,
    },
    maskDataUrl: blurState.hasMask ? blurElements.maskCanvas.toDataURL("image/png") : null,
  };

  await MediaStore.putImageState(payload);
}

function loadImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showImageNotice("请选择有效的图片文件。", "warn");
    return;
  }

  revokeImageUrl();
  clearImageNotice();
  const imageUrl = URL.createObjectURL(file);
  const image = new Image();

  image.onload = () => {
    revokeImageUrl();
    blurState.image = image;
    blurState.imageUrl = imageUrl;
    blurState.imageBlob = file;
    blurState.fileName = file.name.replace(/\.[^.]+$/, "");
    setCanvasSize(image.naturalWidth, image.naturalHeight);
    clearMask();
    resetHistory();
    renderComposite();
    blurElements.imageMeta.textContent = `${file.name} | ${image.naturalWidth} x ${image.naturalHeight}`;
    blurElements.canvasMeta.textContent = `${image.naturalWidth} x ${image.naturalHeight}`;
    toggleImageActions(true);
    void persistImageState();
    showImageNotice("图片已加载，可以开始绘制模糊区域。");
  };

  image.onerror = () => {
    URL.revokeObjectURL(imageUrl);
    showImageNotice("图片加载失败。", "warn");
  };

  blurState.imageUrl = imageUrl;
  image.src = imageUrl;
}

async function restoreImageState() {
  blurState.restoring = true;
  try {
    const transfer = await MediaStore.getFrameTransfer();
    if (transfer && transfer.imageBlob) {
      const file = new File([transfer.imageBlob], transfer.fileName || "frame-transfer.png", {
        type: transfer.imageBlob.type || "image/png",
        lastModified: transfer.createdAt || Date.now(),
      });
      loadImageFile(file);
      await MediaStore.clearFrameTransfer();
      return;
    }

    const saved = await MediaStore.getImageState();
    if (!saved || !saved.imageBlob) {
      return;
    }

    blurElements.brushSizeInput.value = saved.settings?.brushSize || "72";
    blurElements.blurInput.value = saved.settings?.blur || String(GLASS_EFFECT.blur);
    blurElements.opacityInput.value = saved.settings?.opacity || "1";
    blurState.tool = saved.settings?.tool || "draw";
    updateSliderLabels();
    updateToolButtons();

    const file = new File([saved.imageBlob], saved.fileName || "restored-image", {
      type: saved.imageBlob.type || "image/png",
      lastModified: Date.now(),
    });
    loadImageFile(file);

    if (saved.maskDataUrl) {
      const waitForImage = () => new Promise((resolve) => {
        const check = () => {
          if (blurState.image) {
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      });
      await waitForImage();
      const maskImage = new Image();
      await new Promise((resolve, reject) => {
        maskImage.onload = resolve;
        maskImage.onerror = reject;
        maskImage.src = saved.maskDataUrl;
      });
      maskContext.drawImage(maskImage, 0, 0, blurElements.maskCanvas.width, blurElements.maskCanvas.height);
      updateMaskPresence();
      resetHistory();
      renderComposite();
      toggleImageActions(true);
    }
  } catch (error) {
    showImageNotice("恢复上次图片状态失败。", "warn");
  } finally {
    blurState.restoring = false;
  }
}

function exportImage() {
  if (!blurState.image) return;
  renderComposite();
  blurElements.previewCanvas.toBlob((blob) => {
    if (!blob) {
      showImageNotice("导出失败。", "warn");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${blurState.fileName || "blurred-image"}-blurred.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showImageNotice("图片已导出。");
  }, "image/png");
}

function bindDropZone() {
  ["dragenter", "dragover"].forEach((eventName) => {
    blurElements.imageDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      blurElements.imageDropZone.classList.add("active");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    blurElements.imageDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      blurElements.imageDropZone.classList.remove("active");
    });
  });

  blurElements.imageDropZone.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer.files;
    loadImageFile(file);
  });

  blurElements.imageDropZone.addEventListener("click", () => blurElements.imageInput.click());
  blurElements.imageDropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      blurElements.imageInput.click();
    }
  });
}

function bindCanvasEvents() {
  blurElements.guideCanvas.addEventListener("pointerdown", (event) => {
    blurElements.guideCanvas.setPointerCapture(event.pointerId);
    startDrawing(event);
  });
  blurElements.guideCanvas.addEventListener("pointermove", moveDrawing);
  blurElements.guideCanvas.addEventListener("pointerup", stopDrawing);
  blurElements.guideCanvas.addEventListener("pointerleave", stopDrawing);
  blurElements.guideCanvas.addEventListener("pointercancel", stopDrawing);
}

function bindImageBlurEvents() {
  bindDropZone();
  bindCanvasEvents();

  blurElements.imageInput.addEventListener("change", (event) => {
    const [file] = event.target.files;
    loadImageFile(file);
    event.target.value = "";
  });

  [blurElements.brushSizeInput, blurElements.blurInput, blurElements.opacityInput].forEach((input) => {
    input.addEventListener("input", () => {
      updateSliderLabels();
      renderComposite();
      void persistImageState();
    });
  });

  blurElements.drawModeButton.addEventListener("click", () => {
    blurState.tool = "draw";
    updateToolButtons();
  });

  blurElements.eraseModeButton.addEventListener("click", () => {
    blurState.tool = "erase";
    updateToolButtons();
  });

  blurElements.clearMaskButton.addEventListener("click", () => {
    clearMask(true);
    showImageNotice("蒙版已清空。");
  });

  blurElements.exportImageButton.addEventListener("click", exportImage);
  blurElements.undoButton.addEventListener("click", undoMask);
  blurElements.redoButton.addEventListener("click", redoMask);
}

updateSliderLabels();
updateToolButtons();
toggleImageActions(false);
bindImageBlurEvents();
void restoreImageState();

window.addEventListener("beforeunload", revokeImageUrl);
