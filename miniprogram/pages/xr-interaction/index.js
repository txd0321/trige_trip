import { playNoteAudio } from '../../utils/audio';

const SEGMENTS = 5;
const TOTAL_COUNT = 13;

const ROI_SEG_NOTE = [
  { id: 0, name: 'F5' },
  { id: 1, name: 'E5' },
  { id: 2, name: 'D5' },
  { id: 3, name: 'C5' },
  { id: 4, name: 'B4' },
];

const CIRCLE_IDX_SEQ = [4, 4, 3, 4, 1, 2, null, 4, 4, 3, 4, 0, 1];
const STEP_NOTE_NAME = ['B4', 'B4', 'C5', 'B4', 'E5', 'D5', '', 'B4', 'B4', 'C5', 'B4', 'F5', 'E5'];

const REQUEST_INTERVAL_MS = 1800;
const REQUEST_INTERVAL_WEAK_MS = 3000;
const REQUEST_TIMEOUT_MS = 5000;
const COOLDOWN_MS = 2000;
const MATCHED_MS = 800;

const OPENCV_BASE_URL = 'https://racks-animals-alfred-montreal.trycloudflare.com';

const FRAME_MIN_CONF = 0.65;
const STABLE_MIN_AVG_CONF = 0.82;
const VOTE_WINDOW = 5;
const VOTE_MIN_HIT = 2;

const BLOW_THRESHOLD = 0.35;
const BLOW_HOLD_MS = 600;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function mapRectCoverToUi(imgRect, imgSize, uiSize) {
  const uiAspect = uiSize.width / uiSize.height;
  const imgAspect = imgSize.width / imgSize.height;

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  if (imgAspect > uiAspect) {
    scale = uiSize.height / imgSize.height;
    offsetX = (uiSize.width - imgSize.width * scale) / 2;
  } else {
    scale = uiSize.width / imgSize.width;
    offsetY = (uiSize.height - imgSize.height * scale) / 2;
  }

  return {
    x: Math.round(imgRect.x * scale + offsetX),
    y: Math.round(imgRect.y * scale + offsetY),
    width: Math.round(imgRect.width * scale),
    height: Math.round(imgRect.height * scale),
  };
}

function mapRectUiToImage(uiRect, uiSize, imgSize) {
  const uiAspect = uiSize.width / uiSize.height;
  const imgAspect = imgSize.width / imgSize.height;

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  if (imgAspect > uiAspect) {
    scale = uiSize.height / imgSize.height;
    offsetX = (uiSize.width - imgSize.width * scale) / 2;
  } else {
    scale = uiSize.width / imgSize.width;
    offsetY = (uiSize.height - imgSize.height * scale) / 2;
  }

  return {
    x: Math.round((uiRect.x - offsetX) / scale),
    y: Math.round((uiRect.y - offsetY) / scale),
    width: Math.round(uiRect.width / scale),
    height: Math.round(uiRect.height / scale),
  };
}

function mapRectCoverToImage(imgRect, imgSize, targetSize) {
  const imgAspect = imgSize.width / imgSize.height;
  const targetAspect = targetSize.width / targetSize.height;

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  if (imgAspect > targetAspect) {
    scale = targetSize.height / imgSize.height;
    offsetX = (targetSize.width - imgSize.width * scale) / 2;
  } else {
    scale = targetSize.width / imgSize.width;
    offsetY = (targetSize.height - imgSize.height * scale) / 2;
  }

  return {
    x: imgRect.x * scale + offsetX,
    y: imgRect.y * scale + offsetY,
    width: imgRect.width * scale,
    height: imgRect.height * scale,
  };
}

function callFunctionWithTimeout(name, data, timeout = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    new Promise((resolve, reject) => {
      if (!wx.cloud || !wx.cloud.callFunction) {
        reject(new Error('wx.cloud.callFunction not available'));
        return;
      }
      wx.cloud.callFunction({
        name,
        data,
        success: resolve,
        fail: reject,
      });
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
  ]);
}

function requestWithTimeout(options, timeout = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    new Promise((resolve, reject) => {
      wx.request({
        ...options,
        success: (res) => resolve(res),
        fail: (err) => reject(err),
      });
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
  ]);
}

function readFileAsBase64(path) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      encoding: 'base64',
      success: (res) => resolve(res.data || ''),
      fail: reject,
    });
  });
}

function calcRms(buffer) {
  if (!buffer) return 0;
  const pcm = new Int16Array(buffer);
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

Page({
  data: {
    step: 'scan',
    scanState: 'scanning',
    scanHint: '',
    scanPattern: '',
    collected: [],
    percent: 0,
    frameMinConf: FRAME_MIN_CONF,
    stableMinAvgConf: STABLE_MIN_AVG_CONF,
    winderStatus: 'scan',
    winderHint: '请将发条图案对齐框内',
    rotateDegree: 0,
    blowState: 'idle',
    blowHint: '',
    blowLevel: 0,
    showGuideCard: false,
    showAchievement: false,
    canvasWidth: 0,
    canvasHeight: 0,
    showTuner: true,
    tuner: {
      frameMinConf: FRAME_MIN_CONF,
      stableMinAvgConf: STABLE_MIN_AVG_CONF,
      requestInterval: REQUEST_INTERVAL_MS,
      requestIntervalWeak: REQUEST_INTERVAL_WEAK_MS,
      cannyLow: 20,
      cannyHigh: 80,
      edgeRatioEmpty: 0.015,
      matchThreshold: 0.32,
    },
    tunerStats: {
      total: 0,
      empty: 0,
      circle: 0,
      cross: 0,
      unknown: 0,
      avgLatency: 0,
    },
    lastDebugText: '',
    debugImageEdge: '',
    debugImageThreshold: '',
    debugImageInput: '',
    debugRoi: true,
    debugRoiBinary: false,
    roiTransformMode: 'none',
    roiPreviewWidth: 0,
    roiPreviewHeight: 0,
    scanItemsTable: [],
    freezeDetect: true,
    sampleCollecting: false,
    sampleCollectTarget: 20,
    sampleCollectCount: 0,
    sampleLastFilePath: '',
    detectEnabled: false,
    uiRoiX: 0,
    uiRoiY: 0,
    uiRoiW: 0,
    uiRoiH: 0,
    maskSafeTop: 0,
    maskTopHeight: 0,
  },

  onLoad(options) {
    if (options.cupId) this.cupId = options.cupId;
    const savedTuner = wx.getStorageSync('xr_tuner');
    if (savedTuner) {
      this.setData({ tuner: { ...this.data.tuner, ...savedTuner } });
    }
  },

  onReady() {
    this.camCtx = wx.createCameraContext();
    this.overlayCtx = wx.createCanvasContext('overlay', this);
    this.overlayCtx.setTextAlign('center');
    this.overlayCtx.setTextBaseline('middle');

    const sysInfo = wx.getSystemInfoSync();
    this.windowWidth = sysInfo.windowWidth;
    this.windowHeight = sysInfo.windowHeight;

    this.setData({
      canvasWidth: this.windowWidth,
      canvasHeight: this.windowHeight,
      windowWidth: this.windowWidth,
      windowHeight: this.windowHeight,
    });

    const safeTop = Math.max(0, sysInfo.statusBarHeight || 0);
    const safeBottom = Math.max(0, sysInfo.safeAreaInsets ? sysInfo.safeAreaInsets.bottom || 0 : 0);

    const roiTargetRatioW = 0.26;
    const roiTargetRatioH = 0.80;

    this.uiRoiW = Math.floor(this.windowWidth * roiTargetRatioW);
    this.uiRoiH = Math.floor(this.windowHeight * roiTargetRatioH);
    this.uiRoiX = Math.floor(this.windowWidth / 2 - this.uiRoiW / 2);
    this.uiRoiY = Math.floor(this.windowHeight / 2 - this.uiRoiH / 2);

    const topOverlayRpx = 300;
    const topOverlayPx = Math.floor((topOverlayRpx * this.windowWidth) / 750);
    const maskSafeTop = Math.max(safeTop, topOverlayPx);
    const maskTopHeight = Math.max(0, this.uiRoiY - maskSafeTop);

    this.roiRectOnCamera = {
      x: this.uiRoiX,
      y: this.uiRoiY,
      width: this.uiRoiW,
      height: this.uiRoiH,
    };

    this.roiTargetRatioW = roiTargetRatioW;
    this.roiTargetRatioH = roiTargetRatioH;

    this.setData({
      uiRoiW: this.uiRoiW,
      uiRoiH: this.uiRoiH,
      uiRoiX: this.uiRoiX,
      uiRoiY: this.uiRoiY,
      maskSafeTop: maskSafeTop,
      maskTopHeight: maskTopHeight,
    });

    this.cameraRect = { left: 0, top: 0, width: this.windowWidth, height: this.windowHeight };

    setTimeout(() => {
      wx.createSelectorQuery()
        .in(this)
        .select('.camera')
        .boundingClientRect((rect) => {
          if (!rect) return;
          this.cameraRect = rect;
          this.roiRectOnCamera = {
            x: this.uiRoiX - rect.left,
            y: this.uiRoiY - rect.top,
            width: this.uiRoiW,
            height: this.uiRoiH,
          };
        })
        .exec();
    }, 200);

    this.winderCenter = {
      x: this.windowWidth / 2,
      y: this.windowHeight / 2,
    };
    this.winderMinR = Math.floor(this.windowWidth * 0.18);
    this.winderMaxR = Math.floor(this.windowWidth * 0.42);

    this.voteBuffer = [];
    this.lastRequestAt = 0;
    this.requestPending = false;
    this.scanTimeoutCount = 0;
    this.scanWeakNetwork = false;

    this.winderTimeoutCount = 0;
    this.winderLastTipAt = 0;
    this.winderAlignStart = Date.now();
    this.rotateActive = false;
    this.lastRotateAngle = 0;

    this.blowRmsBuffer = [];
    this.blowAboveStart = 0;

    // 使用 takePhoto 驱动识别，避免不同机型 frame.data 格式差异
    this.listener = null;
    this.detectLoopActive = true;
    // 默认进入页面不自动识别，需手动点击“开始识别”
  },

  toggleDebugRoiBinary() {
    this.setData({ debugRoiBinary: !this.data.debugRoiBinary });
  },

  toggleDetect() {
    const next = !this.data.detectEnabled;
    this.setData({ detectEnabled: next });
    if (next) {
      if (!this.detectLoopActive) this.detectLoopActive = true;
      if (this.scanTimer) clearTimeout(this.scanTimer);
      this.scheduleScanByPhoto();
      wx.showToast({ title: '开始识别', icon: 'none' });
    } else {
      if (this.scanTimer) clearTimeout(this.scanTimer);
      wx.showToast({ title: '已停止识别', icon: 'none' });
    }
  },

  toggleSampleCollect() {
    const next = !this.data.sampleCollecting;
    if (next) {
      this.sampleFrames = [];
      this.setData({
        sampleCollecting: true,
        sampleCollectCount: 0,
      });
      wx.showToast({ title: '开始采集', icon: 'none' });
    } else {
      this.setData({ sampleCollecting: false });
      wx.showToast({ title: `已停止，已采 ${this.data.sampleCollectCount} 帧`, icon: 'none' });
    }
  },

  exportSampleJson() {
    const filePath = this.data.sampleLastFilePath;
    if (!filePath) {
      wx.showToast({ title: '暂无采样文件', icon: 'none' });
      return;
    }
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'utf8',
      success: (res) => {
        const text = String(res.data || '');
        console.log('[sample-json-path]', filePath);
        console.log('[sample-json-content]', text);
        wx.setClipboardData({
          data: text,
          success: () => wx.showToast({ title: '已复制JSON到剪贴板', icon: 'none' }),
          fail: () => wx.showToast({ title: '导出失败', icon: 'none' }),
        });
      },
      fail: () => wx.showToast({ title: '读取文件失败', icon: 'none' }),
    });
  },

  onHide() {
    this.stopAll();
  },

  onUnload() {
    this.stopAll();
  },

  stopAll() {
    if (this.listener) this.listener.stop();
    this.detectLoopActive = false;
    this.requestPending = false;
    if (this.overlayCtx) {
      this.overlayCtx.clearRect(0, 0, this.windowWidth, this.windowHeight);
      this.overlayCtx.draw();
    }
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.scanCooldownTimer) clearTimeout(this.scanCooldownTimer);
    if (this.winderGuideTimer) clearTimeout(this.winderGuideTimer);
    if (this.blowIntroTimer) clearTimeout(this.blowIntroTimer);
    if (this.blowTimeoutTimer) clearTimeout(this.blowTimeoutTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.stopRecorder();
  },

  takePhotoWithTimeout(timeout = REQUEST_TIMEOUT_MS) {
    return Promise.race([
      new Promise((resolve, reject) => {
        this.camCtx.takePhoto({
          quality: 'low',
          success: resolve,
          fail: reject,
        });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('takePhoto timeout')), timeout)),
    ]);
  },

  getImageInfo(path) {
    return new Promise((resolve, reject) => {
      wx.getImageInfo({
        src: path,
        success: resolve,
        fail: reject,
      });
    });
  },

  buildBinaryRoi(yPlane, frameW, roiX, roiY, roiW, roiH, threshold, step) {
    const gw = Math.max(8, Math.floor(roiW / step));
    const gh = Math.max(40, Math.floor(roiH / step));
    const grid = new Uint8Array(gw * gh);

    for (let gy = 0; gy < gh; gy++) {
      const y0 = roiY + gy * step;
      const y1 = Math.min(roiY + roiH, y0 + step);
      for (let gx = 0; gx < gw; gx++) {
        const x0 = roiX + gx * step;
        const x1 = Math.min(roiX + roiW, x0 + step);

        let dark = 0;
        let total = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const v = yPlane[y * frameW + x];
            if (v < threshold) dark++;
            total++;
          }
        }

        const idx = gy * gw + gx;
        grid[idx] = total && dark / total > 0.42 ? 1 : 0;
      }
    }

    return { grid, gw, gh, step };
  },

  findConnectedComponents(grid, gw, gh) {
    const visited = new Uint8Array(grid.length);
    const comps = [];
    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const start = y * gw + x;
        if (!grid[start] || visited[start]) continue;

        const qx = [x];
        const qy = [y];
        let qHead = 0;
        visited[start] = 1;

        let minX = x;
        let minY = y;
        let maxX = x;
        let maxY = y;
        let area = 0;

        while (qHead < qx.length) {
          const cx = qx[qHead];
          const cy = qy[qHead];
          qHead++;
          area++;

          if (cx < minX) minX = cx;
          if (cy < minY) minY = cy;
          if (cx > maxX) maxX = cx;
          if (cy > maxY) maxY = cy;

          for (let i = 0; i < dirs.length; i++) {
            const nx = cx + dirs[i][0];
            const ny = cy + dirs[i][1];
            if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
            const ni = ny * gw + nx;
            if (!grid[ni] || visited[ni]) continue;
            visited[ni] = 1;
            qx.push(nx);
            qy.push(ny);
          }
        }

        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        comps.push({ minX, minY, maxX, maxY, w, h, area, cy: (minY + maxY) / 2 });
      }
    }

    return comps;
  },

  detectOrderedBoxes(yPlane, frameW, roiX, roiY, roiW, roiH, threshold) {
    const step = Math.max(2, Math.floor(roiW / 30));
    const { grid, gw, gh } = this.buildBinaryRoi(yPlane, frameW, roiX, roiY, roiW, roiH, threshold, step);
    const comps = this.findConnectedComponents(grid, gw, gh);

    const minArea = Math.max(4, Math.floor((gw * gh) * 0.0012));
    const filtered = comps.filter((c) => {
      if (c.area < minArea) return false;
      const ratio = c.h / Math.max(1, c.w);
      return ratio >= 0.28 && ratio <= 3.2;
    });

    if (filtered.length < SEGMENTS) return null;

    filtered.sort((a, b) => b.area - a.area);
    const chosen = filtered.slice(0, SEGMENTS);
    if (chosen.length !== SEGMENTS) return null;

    chosen.sort((a, b) => a.cy - b.cy);

    return chosen.map((c) => ({
      x: roiX + c.minX * step,
      y: roiY + c.minY * step,
      w: Math.max(4, c.w * step),
      h: Math.max(4, c.h * step),
    }));
  },

  getFallbackBoxes(roiX, roiY, roiW, roiH) {
    const segH = roiH / SEGMENTS;
    return new Array(SEGMENTS).fill(0).map((_, i) => ({
      x: roiX,
      y: roiY + i * segH,
      w: roiW,
      h: segH,
    }));
  },

  drawOverlay(boxes, labels, scaleX, scaleY, offsetX = 0, offsetY = 0) {
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.windowWidth, this.windowHeight);

    const baseRect = this.cameraRect || { left: 0, top: 0, width: this.windowWidth, height: this.windowHeight };
    const { roiX, roiY, roiW, roiH } = this.getFrameRoi(this.stableFrameW || this.windowWidth, this.stableFrameH || this.windowHeight);
    const mapped = mapRectCoverToUi(
      { x: roiX, y: roiY, width: roiW, height: roiH },
      { width: this.stableFrameW || this.windowWidth, height: this.stableFrameH || this.windowHeight },
      { width: baseRect.width, height: baseRect.height }
    );

    ctx.setLineWidth(3);
    ctx.setStrokeStyle('#00c2ff');
    ctx.strokeRect(mapped.x + baseRect.left, mapped.y + baseRect.top, mapped.width, mapped.height);

    if (this.debugRoiRect) {
      ctx.setLineWidth(2);
      ctx.setStrokeStyle('#ff4d4f');
      ctx.strokeRect(this.debugRoiRect.x, this.debugRoiRect.y, this.debugRoiRect.width, this.debugRoiRect.height);
    }

    if (this.data.debugRoi && this.debugRoiRect) {
      ctx.setLineWidth(2);
      ctx.setStrokeStyle('rgba(255,0,0,0.75)');
      ctx.strokeRect(this.debugRoiRect.x, this.debugRoiRect.y, this.debugRoiRect.width, this.debugRoiRect.height);
    }

    if (!boxes || !boxes.length) {
      ctx.draw();
      return;
    }

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const cls = labels && labels[i] ? labels[i] : 'unknown';

      let color = '#ffffff88';
      let text = '?';
      if (cls === 'circle') {
        color = '#00d26a';
        text = '●';
      } else if (cls === 'cross') {
        color = '#ff8a00';
        text = '✕';
      } else if (cls === 'empty') {
        color = 'rgba(255,255,255,0.35)';
        text = '—';
      }

      const x = offsetX + b.x / scaleX;
      const y = offsetY + b.y / scaleY;
      const w = b.w / scaleX;
      const h = b.h / scaleY;

      ctx.setStrokeStyle(color);
      ctx.setLineWidth(3);
      ctx.strokeRect(x, y, w, h);
      ctx.setFillStyle(color);
      ctx.setFontSize(16);
      ctx.fillText(text, x + w / 2 - 6, y + h / 2 + 6);

      ctx.setFillStyle('#ffffff');
      ctx.setFontSize(12);
      ctx.fillText(String(i + 1), x + 4, y + 14);
    }

    ctx.draw();
  },

  updateScanPreview(normalized, roiX, roiY, roiW, roiH, width, height) {
    const baseRect = this.cameraRect || { left: 0, top: 0, width: this.windowWidth, height: this.windowHeight };
    const overlayScaleX = width / baseRect.width;
    const overlayScaleY = height / baseRect.height;
    const overlayOffsetX = baseRect.left;
    const overlayOffsetY = baseRect.top;

    if (!normalized.length) {
      this.drawOverlay([], [], overlayScaleX, overlayScaleY, overlayOffsetX, overlayOffsetY);
      if (this.data.scanHint !== '识别到 0 个图形') {
        this.setData({ scanHint: '识别到 0 个图形', scanPattern: '' });
      }
      return null;
    }

    const orderedPreview = normalized.slice().sort((a, b) => a.y - b.y);
    const previewLabels = orderedPreview.map((item) => item.label || 'unknown');
    const patternSymbols = previewLabels.map((c) => (c === 'circle' ? '●' : c === 'cross' ? '❌' : c === 'empty' ? '—' : '?'));
    const patternStr = patternSymbols.join(' ');

    const overlayBoxes = orderedPreview.map((item) => ({
      x: Number.isFinite(item.x) ? item.x - (Number.isFinite(item.w) ? item.w / 2 : 0) : roiW / 2,
      y: Number.isFinite(item.y) ? item.y - (Number.isFinite(item.h) ? item.h / 2 : 0) : roiH / 2,
      w: Number.isFinite(item.w) ? item.w : roiW * 0.28,
      h: Number.isFinite(item.h) ? item.h : roiH * 0.12,
    }));

    this.drawOverlay(overlayBoxes, previewLabels, overlayScaleX, overlayScaleY, overlayOffsetX, overlayOffsetY);

    const hint = `识别到 ${normalized.length} 个图形：${patternStr}`;
    const scanItemsTable = orderedPreview.map((item, idx) => {
      const w = Number.isFinite(item.w) ? Number(item.w.toFixed(1)) : null;
      const h = Number.isFinite(item.h) ? Number(item.h.toFixed(1)) : null;
      const x = Number.isFinite(item.x) ? Number(item.x.toFixed(1)) : null;
      const y = Number.isFinite(item.y) ? Number(item.y.toFixed(1)) : null;
      return {
        idx: idx + 1,
        label: item.label || 'unknown',
        x,
        y,
        w,
        h,
      };
    });

    if (hint !== this.data.scanHint || scanItemsTable !== this.data.scanItemsTable) {
      this.setData({ scanHint: hint, scanPattern: patternStr, scanItemsTable });
    }

    return {
      orderedPreview,
      previewLabels,
      patternStr,
    };
  },

  pushVoteAndGetStable(circleIdx, confidence) {
    this.voteBuffer.push({ idx: circleIdx, confidence, ts: Date.now() });
    if (this.voteBuffer.length > VOTE_WINDOW) this.voteBuffer.shift();

    const map = {};
    this.voteBuffer.forEach((v) => {
      const key = String(v.idx);
      if (!map[key]) map[key] = { cnt: 0, sum: 0 };
      map[key].cnt += 1;
      map[key].sum += v.confidence;
    });

    let stableIdx;
    let stableCnt = 0;
    let stableAvg = 0;
    Object.keys(map).forEach((k) => {
      const item = map[k];
      const avg = item.sum / item.cnt;
      if (item.cnt > stableCnt || (item.cnt === stableCnt && avg > stableAvg)) {
        stableCnt = item.cnt;
        stableAvg = avg;
        stableIdx = k === 'null' ? null : Number(k);
      }
    });

    const stableMin = Number((this.data.tuner && this.data.tuner.stableMinAvgConf) || this.data.stableMinAvgConf);
    if (stableCnt < VOTE_MIN_HIT || stableAvg < stableMin) return { ok: false };
    return { ok: true, idx: stableIdx };
  },

  getFrameRoi(frameW, frameH) {
    const ratioW = Number(this.roiTargetRatioW || 0.28);
    const ratioH = Number(this.roiTargetRatioH || 0.7);
    const roiW = Math.max(10, Math.floor(frameW * ratioW));
    const roiH = Math.max(60, Math.floor(frameH * ratioH));
    const roiX = clamp(Math.floor((frameW - roiW) / 2), 0, Math.max(0, frameW - roiW));
    const roiY = clamp(Math.floor((frameH - roiH) / 2), 0, Math.max(0, frameH - roiH));
    return { roiX, roiY, roiW, roiH };
  },

  updateUiRoiFromFrame(frameW, frameH) {
    const baseRect = this.cameraRect || { left: 0, top: 0, width: this.windowWidth, height: this.windowHeight };
    const { roiX, roiY, roiW, roiH } = this.getFrameRoi(frameW, frameH);
    const mapped = mapRectCoverToUi(
      { x: roiX, y: roiY, width: roiW, height: roiH },
      { width: frameW, height: frameH },
      { width: baseRect.width, height: baseRect.height }
    );

    this.setData({
      uiRoiX: mapped.x + baseRect.left,
      uiRoiY: mapped.y + baseRect.top,
      uiRoiW: mapped.width,
      uiRoiH: mapped.height,
    });
  },

  async scheduleScanByPhoto() {
    if (!this.detectLoopActive) return;
    if (!this.data.detectEnabled) return;
    const tuner = this.data.tuner || {};
    const intervalBase = Number(tuner.requestInterval || REQUEST_INTERVAL_MS);
    const intervalWeak = Number(tuner.requestIntervalWeak || REQUEST_INTERVAL_WEAK_MS);
    const interval = this.scanWeakNetwork ? intervalWeak : intervalBase;

    if (this.data.step !== 'scan') {
      this.scanTimer = setTimeout(() => this.scheduleScanByPhoto(), interval);
      return;
    }

    if (this.requestPending || this.data.scanState === 'cooldown' || this.data.scanState === 'matched') {
      this.scanTimer = setTimeout(() => this.scheduleScanByPhoto(), interval);
      return;
    }

    try {
      const photo = await this.takePhotoWithTimeout(REQUEST_TIMEOUT_MS);
      const path = photo && photo.tempImagePath;
      if (path) {
        const info = await this.getImageInfo(path);
        const base64 = await readFileAsBase64(path);
        if (info && info.width && info.height && base64) {
          await this.handleScanPhoto(path, base64, info.width, info.height);
        }
      }
    } catch (e) {
      console.log('[scan-photo-error]', e);
      if (this.data.sampleCollecting) {
        this.scanWeakNetwork = true;
      }
    }

    this.scanTimer = setTimeout(() => this.scheduleScanByPhoto(), interval);
  },

  async handleScanPhoto(photoPath, frameBase64, width, height) {
    if (this.requestPending || this.data.scanState === 'cooldown' || this.data.scanState === 'matched') return;

    const previewRect = this.cameraRect || { left: 0, top: 0, width: this.windowWidth, height: this.windowHeight };
    const uiRect = {
      x: this.uiRoiX - previewRect.left,
      y: this.uiRoiY - previewRect.top,
      width: this.uiRoiW,
      height: this.uiRoiH,
    };

    const scale = Math.max(previewRect.width / width, previewRect.height / height);
    const displayW = width * scale;
    const displayH = height * scale;
    const offsetX = (previewRect.width - displayW) / 2;
    const offsetY = (previewRect.height - displayH) / 2;

    let roiX = Math.round((uiRect.x - offsetX) / scale);
    let roiY = Math.round((uiRect.y - offsetY) / scale);
    let roiW = Math.max(10, Math.round(uiRect.width / scale));
    let roiH = Math.max(60, Math.round(uiRect.height / scale));

    const transform = (this.data.roiTransformMode || 'none');
    const applyTransform = (x, y, w, h) => {
      if (transform === 'rotate90') {
        return { x: y, y: width - (x + w), w: h, h: w };
      }
      if (transform === 'rotate270') {
        return { x: height - (y + h), y: x, w: h, h: w };
      }
      if (transform === 'mirrorX') {
        return { x: width - (x + w), y, w, h };
      }
      return { x, y, w, h };
    };

    let t = applyTransform(roiX, roiY, roiW, roiH);
    roiX = clamp(t.x, 0, Math.max(0, width - 1));
    roiY = clamp(t.y, 0, Math.max(0, height - 1));
    roiW = Math.max(10, Math.min(t.w, width - roiX));
    roiH = Math.max(60, Math.min(t.h, height - roiY));

    if (this.data.debugRoi) {
      let back = t;
      if (transform === 'rotate90') {
        back = { x: width - (roiY + roiH), y: roiX, w: roiH, h: roiW };
      } else if (transform === 'rotate270') {
        back = { x: roiY, y: height - (roiX + roiW), w: roiH, h: roiW };
      } else if (transform === 'mirrorX') {
        back = { x: width - (roiX + roiW), y: roiY, w: roiW, h: roiH };
      } else {
        back = { x: roiX, y: roiY, w: roiW, h: roiH };
      }
      this.debugRoiRect = {
        x: back.x * scale + offsetX + previewRect.left,
        y: back.y * scale + offsetY + previewRect.top,
        width: back.w * scale,
        height: back.h * scale,
      };
    } else {
      this.debugRoiRect = null;
    }


    const sendW = width;
    const sendH = height;
    const frameBase64Len = frameBase64.length;

    let roiMean = 0;
    let roiStd = 0;

    if (this.data.debugRoi && photoPath) {
      const canvasId = 'roiPreviewCanvas';
      this.setData({ roiPreviewWidth: roiW, roiPreviewHeight: roiH }, () => {
        const ctx = wx.createCanvasContext(canvasId, this);
        ctx.clearRect(0, 0, roiW, roiH);
        ctx.drawImage(photoPath, roiX, roiY, roiW, roiH, 0, 0, roiW, roiH);
        ctx.draw(false, () => {
          wx.canvasToTempFilePath(
            {
              canvasId,
              x: 0,
              y: 0,
              width: roiW,
              height: roiH,
              destWidth: roiW * 4,
              destHeight: roiH * 4,
              success: (res) => this.setData({ debugImageInput: res.tempFilePath }),
              fail: () => this.setData({ debugImageInput: '' }),
            },
            this
          );
        });
      });
    }
    console.log(
      '[roi-debug]',
      JSON.stringify(
        {
          frameWidth: sendW,
          frameHeight: sendH,
          roiXRatio: Number(((roiX / width) || 0).toFixed(4)),
          roiYRatio: Number(((roiY / height) || 0).toFixed(4)),
          roiWRatio: Number(((roiW / width) || 0).toFixed(4)),
          roiHRatio: Number(((roiH / height) || 0).toFixed(4)),
          roiMean: Number(roiMean.toFixed(2)),
          roiStd: Number(roiStd.toFixed(2)),
          base64Length: frameBase64Len,
        },
        null,
        2
      )
    );

    this.requestPending = true;
    let result;
    let latencyMs = 0;
    this.scanFrameSeq = (this.scanFrameSeq || 0) + 1;
    try {
      const startAt = Date.now();
      const res = await requestWithTimeout({
        url: `${OPENCV_BASE_URL}/api/vision/roi`,
        method: 'POST',
        data: {
          imageBase64: frameBase64,
          imageWidth: sendW,
          imageHeight: sendH,
          roiXRatio: roiX / width,
          roiYRatio: roiY / height,
          roiWRatio: roiW / width,
          roiHRatio: roiH / height,
          cannyLow: Number((this.data.tuner && this.data.tuner.cannyLow) || 40),
          cannyHigh: Number((this.data.tuner && this.data.tuner.cannyHigh) || 120),
          edgeRatioEmpty: Number((this.data.tuner && this.data.tuner.edgeRatioEmpty) || 0.015),
          matchThreshold: Number((this.data.tuner && this.data.tuner.matchThreshold) || 0.32),
          seq: this.scanFrameSeq,
          timestamp: Date.now(),
        },
        header: {
          'content-type': 'application/json',
        },
      });
      latencyMs = Date.now() - startAt;
      console.log('[opencv-response]', { statusCode: res && res.statusCode, data: res && res.data });
      result = res && res.data;
      if (result && result.debug) {
        const debugText = JSON.stringify(result.debug);
        const debugImages = result.debug && result.debug.debugImages ? result.debug.debugImages : {};
        console.log('[opencv-debug]', debugText);
        this.setData({
          lastDebugText: debugText,
          debugImageEdge: debugImages.edge ? `data:image/png;base64,${debugImages.edge}` : '',
          debugImageThreshold: debugImages.threshold ? `data:image/png;base64,${debugImages.threshold}` : '',
        });
      }

      if (this.data.sampleCollecting) {
        if (!this.sampleFrames) this.sampleFrames = [];
        const sample = {
          ts: Date.now(),
          photoPath: photoPath,
          roi: {
            frameWidth: sendW,
            frameHeight: sendH,
            roiXRatio: Number(((roiX / width) || 0).toFixed(6)),
            roiYRatio: Number(((roiY / height) || 0).toFixed(6)),
            roiWRatio: Number(((roiW / width) || 0).toFixed(6)),
            roiHRatio: Number(((roiH / height) || 0).toFixed(6)),
            base64Length: frameBase64Len,
          },
          opencv: result && result.debug ? result.debug : null,
        };
        this.sampleFrames.push(sample);
        const count = this.sampleFrames.length;
        this.setData({ sampleCollectCount: count });
        if (count >= Number(this.data.sampleCollectTarget || 20)) {
          const dump = {
            createdAt: Date.now(),
            target: this.data.sampleCollectTarget,
            frames: this.sampleFrames,
          };
          const filePath = `${wx.env.USER_DATA_PATH}/roi_samples_${Date.now()}.json`;
          wx.getFileSystemManager().writeFile({
            filePath,
            data: JSON.stringify(dump, null, 2),
            encoding: 'utf8',
            success: () => {
              this.setData({ sampleCollecting: false, sampleLastFilePath: filePath });
              wx.showModal({ title: '采集完成', content: `已保存:\n${filePath}`, showCancel: false });
            },
          });
        }
      }
    } catch (err) {
      console.log('[opencv-error]', err);
      this.scanTimeoutCount += 1;
      if (this.scanTimeoutCount >= 3) {
        this.scanWeakNetwork = true;
        this.setData({ scanHint: '网络不稳定，已降低识别频率' });
      } else if (this.scanTimeoutCount >= 2) {
        this.setData({ scanHint: '识别中断，请保持对齐再试' });
      }
      this.requestPending = false;
      return;
    }

    this.requestPending = false;
    this.scanTimeoutCount = 0;
    if (!result) return;

    // ====== 1. 读取后端返回的图形列表（严格 y 轴排序） ======
    const frameMinConf = Number((this.data.tuner && this.data.tuner.frameMinConf) || this.data.frameMinConf);
    const shapeItems = Array.isArray(result.items) ? result.items : null;

    if (!shapeItems || !shapeItems.length) {
      const baseRect = this.cameraRect || { left: 0, top: 0, width: this.windowWidth, height: this.windowHeight };
      const overlayScaleX = width / baseRect.width;
      const overlayScaleY = height / baseRect.height;
      const overlayOffsetX = baseRect.left;
      const overlayOffsetY = baseRect.top;
      this.drawOverlay([], [], overlayScaleX, overlayScaleY, overlayOffsetX, overlayOffsetY);
      if (this.data.scanHint !== '识别到 0 个图形') {
        this.setData({ scanHint: '识别到 0 个图形', scanPattern: '' });
      }
      return;
    }

    const normalized = shapeItems
      .map((item) => {
        const label = item.label || item.type || item.cls || item.class || item.shape;
        const y = Number(item.y ?? item.cy ?? item.centerY ?? item.center_y);
        const x = Number(item.x ?? item.cx ?? item.centerX ?? item.center_x);
        const w = Number(item.w ?? item.width ?? item.bw);
        const h = Number(item.h ?? item.height ?? item.bh);
        const confidence = Number(item.confidence ?? item.score ?? item.prob);
        return {
          label: label || 'unknown',
          y,
          x,
          w: Number.isFinite(w) ? w : null,
          h: Number.isFinite(h) ? h : null,
          confidence: Number.isFinite(confidence) ? confidence : null,
        };
      })
      .filter((item) => Number.isFinite(item.y));

    this.updateScanPreview(normalized, roiX, roiY, roiW, roiH, width, height);

    if (normalized.length !== SEGMENTS) {
      return;
    }

    const orderedShapes = normalized.slice().sort((a, b) => a.y - b.y);
    const orderedLabels = orderedShapes.map((item) => item.label || 'unknown');
    const confList = orderedShapes.map((item) =>
      Number.isFinite(item.confidence) ? item.confidence : Number(result.confidence || 0)
    );
    const score = confList.reduce((sum, v) => sum + v, 0) / Math.max(1, confList.length);

    // ====== 2. 统计识别结果与 UI 文本 ======
    const safeLabels = orderedLabels.map((label) => label || 'unknown');
    const tunerStats = this.data.tunerStats || {};
    const countMap = { ...tunerStats };
    countMap.total = (countMap.total || 0) + 1;
    safeLabels.forEach((label) => {
      const key = label || 'unknown';
      countMap[key] = (countMap[key] || 0) + 1;
    });
    const prevAvg = Number(countMap.avgLatency || 0);
    countMap.avgLatency = prevAvg ? (prevAvg * 0.9 + latencyMs * 0.1) : latencyMs;
    this.setData({ tunerStats: countMap });

    const patternSymbols = safeLabels.map((c) => (c === 'circle' ? '●' : c === 'cross' ? '❌' : c === 'empty' ? '—' : '?'));
    const patternStr = patternSymbols.join(' ');
    if (patternStr !== this.data.scanPattern) this.setData({ scanPattern: patternStr, scanHint: '' });
    if (this.data.freezeDetect) {
      if (this.freezeDisplayTimer) clearTimeout(this.freezeDisplayTimer);
      this.freezeDisplayTimer = setTimeout(() => {
        if (this.data.freezeDetect) this.setData({ scanPattern: '' });
      }, 2000);
    }

    // ====== 3. 定位框绘制（使用后端返回的 x/y 中心点） ======
    const baseRect = this.cameraRect || { left: 0, top: 0, width: this.windowWidth, height: this.windowHeight };
    const overlayScaleX = width / baseRect.width;
    const overlayScaleY = height / baseRect.height;
    const overlayOffsetX = baseRect.left;
    const overlayOffsetY = baseRect.top;

    const overlayBoxes = orderedShapes.map((item) => ({
      x: Number.isFinite(item.x) ? item.x - (Number.isFinite(item.w) ? item.w / 2 : 0) : roiW / 2,
      y: Number.isFinite(item.y) ? item.y - (Number.isFinite(item.h) ? item.h / 2 : 0) : roiH / 2,
      w: Number.isFinite(item.w) ? item.w : roiW * 0.28,
      h: Number.isFinite(item.h) ? item.h : roiH * 0.12,
    }));

    this.drawOverlay(overlayBoxes, safeLabels, overlayScaleX, overlayScaleY, overlayOffsetX, overlayOffsetY);

    // ====== 4. 单次命中判定（circle=1 / cross=4 / 无 unknown/empty） ======
    const circleCount = safeLabels.filter((x) => x === 'circle').length;
    const crossCount = safeLabels.filter((x) => x === 'cross').length;
    const unknownCount = safeLabels.filter((x) => x === 'unknown').length;
    const emptyCount = safeLabels.filter((x) => x === 'empty').length;
    if (safeLabels.length !== SEGMENTS || circleCount !== 1 || crossCount !== 4 || unknownCount > 0 || emptyCount > 0) return;

    const circleIdx = safeLabels.findIndex((label) => label === 'circle');
    if (circleIdx < 0) return;
    if (score < frameMinConf) return;

    const stable = this.pushVoteAndGetStable(circleIdx, score);
    if (!stable.ok) return;

    const stepIdx = this.data.collected.length;
    const expectedIdx = CIRCLE_IDX_SEQ[stepIdx];
    if (stable.idx !== expectedIdx) return;

    this.voteBuffer = [];
    this.setData({ scanState: 'matched' });
    this.handleScanSuccess(stepIdx, latencyMs, score, stable.idx);
  },

  handleScanSuccess(stepIdx, latencyMs, confidence, circleIdx) {
    const collected = this.data.collected.concat(stepIdx);
    const percent = (collected.length / TOTAL_COUNT) * 100;
    const expectedIdx = CIRCLE_IDX_SEQ[stepIdx];
    const noteName = STEP_NOTE_NAME[stepIdx];

    this.trackScanEvent({
      targetIndex: stepIdx + 1,
      pattern: this.data.scanPattern,
      confidence,
      latencyMs,
      retryCount: this.scanTimeoutCount,
      note: noteName,
      circleIdx,
    });

    if (expectedIdx !== null) {
      const note = ROI_SEG_NOTE[expectedIdx];
      playNoteAudio(note.id);
      wx.showToast({ title: noteName || note.name, icon: 'none', duration: MATCHED_MS });
    } else {
      wx.showToast({ title: '识别成功', icon: 'none', duration: MATCHED_MS });
    }

    this.setData({ collected, percent });

    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.scanCooldownTimer) clearTimeout(this.scanCooldownTimer);

    if (collected.length >= TOTAL_COUNT) {
      this.setData({ scanState: 'completed' });
      this.scanTimer = setTimeout(() => {
        this.enterWinderStep();
      }, COOLDOWN_MS);
      return;
    }

    this.scanTimer = setTimeout(() => {
      this.setData({ scanState: 'cooldown' });
      this.scanCooldownTimer = setTimeout(() => {
        this.setData({ scanState: 'scanning' });
      }, COOLDOWN_MS - MATCHED_MS);
    }, MATCHED_MS);
  },

  enterWinderStep() {
    this.setData({
      step: 'winder',
      winderStatus: 'scan',
      winderHint: '请将发条图案对齐框内',
      rotateDegree: 0,
      showGuideCard: false,
    });
    this.winderAlignStart = Date.now();
    this.winderTimeoutCount = 0;
  },


  async takeSnapshot(isAuto = false) {
    if (this.data.step !== 'scan' || !this.camCtx || this.requestPending) return;
    this.requestPending = true;
    if (!isAuto) this.setData({ scanHint: '拍照中…' });
    try {
      const res = await new Promise((resolve, reject) => {
        this.camCtx.takePhoto({
          quality: 'high',
          success: resolve,
          fail: reject,
        });
      });
      if (!res || !res.tempImagePath) {
        if (!isAuto) this.setData({ scanHint: '拍照失败，请重试' });
        this.requestPending = false;
        return;
      }
      this.setData({ snapshotImage: res.tempImagePath, scanHint: '' });
      this.cacheSnapshot(res.tempImagePath);
      await this.processSnapshot(res.tempImagePath);
    } catch (err) {
      if (!isAuto) this.setData({ scanHint: '拍照失败，请重试' });
      this.requestPending = false;
    }
  },

  cacheSnapshot(path) {
    const maxKeep = 6;
    const list = Array.isArray(this.data.cachedSnapshots) ? [...this.data.cachedSnapshots] : [];
    const next = [path, ...list.filter((item) => item !== path)].slice(0, maxKeep);
    this.setData({ cachedSnapshots: next, mockIndex: 0 });
  },

  async useCachedSnapshot(e) {
    if (this.data.requestPending) return;
    const index = Number((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.index) || 0);
    const list = this.data.cachedSnapshots || [];
    const target = list[index];
    if (!target) return;
    this.requestPending = true;
    this.setData({ snapshotImage: target, mockIndex: index, scanHint: '使用缓存图片…' });
    await this.processSnapshot(target);
  },

  async processSnapshotFrame(frame) {
    const { width, height } = frame;
    const yPlane = new Uint8Array(frame.data);
    const scaleX = width / this.windowWidth;
    const scaleY = height / this.windowHeight;
    const roiW = Math.max(10, Math.floor(this.uiRoiW * scaleX));
    const roiH = Math.max(60, Math.floor(this.uiRoiH * scaleY));
    const roiX = clamp(Math.floor(this.uiRoiX * scaleX), 0, Math.max(0, width - roiW));
    const roiY = clamp(Math.floor(this.uiRoiY * scaleY), 0, Math.max(0, height - roiH));

    const roiGray = new Uint8Array(roiW * roiH);
    let k = 0;
    for (let y = 0; y < roiH; y++) {
      const srcY = roiY + y;
      const rowOffset = srcY * width + roiX;
      for (let x = 0; x < roiW; x++) {
        roiGray[k++] = yPlane[rowOffset + x];
      }
    }

    await this.sendRoiToService(roiGray, roiW, roiH);
    this.requestPending = false;
  },

  async processSnapshot(tempPath) {
    const img = await new Promise((resolve, reject) => {
      wx.getImageInfo({
        src: tempPath,
        success: resolve,
        fail: reject,
      });
    });
    const canvasId = 'collectCropCanvas';
    const ctx = wx.createCanvasContext(canvasId, this);

    const orientation = img.orientation || 'up';
    let drawW = img.width;
    let drawH = img.height;
    let rotate = 0;
    if (orientation === 'right') {
      drawW = img.height;
      drawH = img.width;
      rotate = 90;
    } else if (orientation === 'left') {
      drawW = img.height;
      drawH = img.width;
      rotate = -90;
    } else if (orientation === 'down') {
      rotate = 180;
    }

    if (drawW && drawH) {
      this.setData({ snapshotCanvasWidth: drawW, snapshotCanvasHeight: drawH });
    }
    ctx.clearRect(0, 0, drawW, drawH);
    ctx.save();
    ctx.translate(drawW / 2, drawH / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.drawImage(tempPath, -img.width / 2, -img.height / 2, img.width, img.height);
    ctx.restore();
    await new Promise((resolve) => ctx.draw(false, resolve));

    // IMPORTANT: takePhoto 的图片与 camera 预览的裁切/缩放可能不一致。
    // 为了保证“UI 框内容 == 识别裁剪内容”，这里将 takePhoto 图片裁剪映射到与相机帧一致的 ROI。
    // 具体做法：先在“假想相机帧尺寸(targetW/targetH)”里取 ROI（getFrameRoi），再用 cover 的反向映射
    // 投影到 takePhoto 实际图片(drawW/drawH)上得到最终裁剪区域。

    const frameW = Number(this.stableFrameW || this.lastFrameW || drawW);
    const frameH = Number(this.stableFrameH || this.lastFrameH || drawH);
    const targetW = frameW;
    const targetH = frameH;

    const frameRoi = this.getFrameRoi(targetW, targetH);
    const mapped = mapRectCoverToImage(
      { x: frameRoi.roiX, y: frameRoi.roiY, width: frameRoi.roiW, height: frameRoi.roiH },
      { width: targetW, height: targetH },
      { width: drawW, height: drawH }
    );

    const roiW = Math.max(10, Math.floor(mapped.width));
    const roiH = Math.max(60, Math.floor(mapped.height));
    const roiX = clamp(Math.floor(mapped.x), 0, Math.max(0, drawW - roiW));
    const roiY = clamp(Math.floor(mapped.y), 0, Math.max(0, drawH - roiH));


    const res = await new Promise((resolve, reject) => {
      wx.canvasGetImageData({
        canvasId,
        x: roiX,
        y: roiY,
        width: roiW,
        height: roiH,
        success: resolve,
        fail: reject,
      }, this);
    });

    const previewPath = await new Promise((resolve) => {
      wx.canvasToTempFilePath({
        canvasId,
        x: roiX,
        y: roiY,
        width: roiW,
        height: roiH,
        destWidth: roiW,
        destHeight: roiH,
        success: (r) => resolve(r.tempFilePath),
        fail: () => resolve(''),
      }, this);
    });
    if (previewPath) {
      this.setData({ snapshotRoiRaw: previewPath });
    }

    const rgba = res.data || new Uint8ClampedArray();
    const gray = new Uint8Array(roiW * roiH);
    for (let i = 0; i < roiW * roiH; i++) {
      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      gray[i] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    }

    await this.sendRoiToService(gray, roiW, roiH);
    this.requestPending = false;
  },

  async drawRoiPreviewWithLabels(labels) {
    const roiPath = this.data.snapshotRoiRaw || this.data.snapshotRoiPreview;
    if (!roiPath || !labels) return;

    const canvasId = 'collectCropCanvas';
    const ctx = wx.createCanvasContext(canvasId, this);

    const img = await new Promise((resolve) => {
      wx.getImageInfo({
        src: roiPath,
        success: resolve,
        fail: () => resolve(null),
      });
    });
    if (!img) return;

    const drawW = img.width;
    const drawH = img.height;
    this.setData({ snapshotCanvasWidth: drawW, snapshotCanvasHeight: drawH });

    ctx.clearRect(0, 0, drawW, drawH);
    ctx.drawImage(roiPath, 0, 0, drawW, drawH);

    const segH = drawH / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      const cls = labels[i] || 'unknown';
      let color = 'rgba(255,255,255,0.45)';
      let text = '?';
      if (cls === 'circle') {
        color = '#00d26a';
        text = '●';
      } else if (cls === 'cross') {
        color = '#ff8a00';
        text = '✕';
      } else if (cls === 'empty') {
        color = 'rgba(255,255,255,0.35)';
        text = '—';
      }

      const y = i * segH;
      ctx.setStrokeStyle(color);
      ctx.setLineWidth(3);
      ctx.strokeRect(0, y, drawW, segH);
      ctx.setFillStyle(color);
      ctx.setFontSize(24);
      ctx.fillText(text, drawW / 2 - 6, y + segH / 2 + 6);
    }

    await new Promise((resolve) => ctx.draw(false, resolve));

    const previewPath = await new Promise((resolve) => {
      wx.canvasToTempFilePath({
        canvasId,
        x: 0,
        y: 0,
        width: drawW,
        height: drawH,
        destWidth: drawW,
        destHeight: drawH,
        success: (r) => resolve(r.tempFilePath),
        fail: () => resolve(''),
      }, this);
    });

    if (previewPath) {
      this.setData({ snapshotRoiPreview: previewPath });
    }
  },

  async sendRoiToService(gray, roiW, roiH) {
    let result;
    let latencyMs = 0;
    try {
      const startAt = Date.now();
      const res = await requestWithTimeout({
        url: `${OPENCV_BASE_URL}/api/vision/roi`,
        method: 'POST',
        data: {
          imageBase64: wx.arrayBufferToBase64(gray.buffer),
          roiWidth: roiW,
          roiHeight: roiH,
          cannyLow: Number((this.data.tuner && this.data.tuner.cannyLow) || 40),
          cannyHigh: Number((this.data.tuner && this.data.tuner.cannyHigh) || 120),
          edgeRatioEmpty: Number((this.data.tuner && this.data.tuner.edgeRatioEmpty) || 0.015),
          matchThreshold: Number((this.data.tuner && this.data.tuner.matchThreshold) || 0.32),
          seq: this.data.collected.length + 1,
          timestamp: Date.now(),
        },
        header: {
          'content-type': 'application/json',
        },
      });
      latencyMs = Date.now() - startAt;
      result = res && res.data;
      if (result && result.debug) {
        const debugText = JSON.stringify(result.debug);
        console.log('[opencv-debug]', debugText);
        this.setData({ lastDebugText: debugText });
      }
    } catch (err) {
      this.scanTimeoutCount += 1;
      if (this.scanTimeoutCount >= 3) {
        this.scanWeakNetwork = true;
        this.setData({ scanHint: '网络不稳定，已降低识别频率' });
      } else if (this.scanTimeoutCount >= 2) {
        this.setData({ scanHint: '识别中断，请保持对齐再试' });
      }
      return;
    }

    this.scanTimeoutCount = 0;
    if (!result || !Array.isArray(result.slots)) return;

    const labels = result.slots.slice(0, SEGMENTS);
    const safeLabels = labels.map((label) => {
      if (!label) return 'unknown';
      return label;
    });
    const frameMinConf = Number((this.data.tuner && this.data.tuner.frameMinConf) || this.data.frameMinConf);
    const confs = new Array(SEGMENTS).fill(Number(result.confidence || 0));

    const tunerStats = this.data.tunerStats || {};
    const countMap = { ...tunerStats };
    countMap.total = (countMap.total || 0) + 1;
    labels.forEach((label) => {
      const key = label || 'unknown';
      countMap[key] = (countMap[key] || 0) + 1;
    });
    const prevAvg = Number(countMap.avgLatency || 0);
    countMap.avgLatency = prevAvg ? (prevAvg * 0.9 + latencyMs * 0.1) : latencyMs;
    this.setData({ tunerStats: countMap });

    const patternSymbols = safeLabels.map((c) => (c === 'circle' ? '●' : c === 'cross' ? '❌' : c === 'empty' ? '—' : '?'));
    const patternStr = patternSymbols.join(' ');
    if (patternStr !== this.data.scanPattern) this.setData({ scanPattern: patternStr, scanHint: '' });

    await this.drawRoiPreviewWithLabels(safeLabels);

    const circleCount = safeLabels.filter((x) => x === 'circle').length;
    const unknownCount = safeLabels.filter((x) => x === 'unknown').length;
    if (unknownCount > 1 || circleCount > 1) return;

    let circleIdx = null;
    let score = 0;
    for (let i = 0; i < SEGMENTS; i++) {
      if (safeLabels[i] === 'circle') {
        circleIdx = i;
        score = Number(confs[i] || 0);
        break;
      }
      if (safeLabels[i] === 'cross' || safeLabels[i] === 'empty') {
        score += Number(confs[i] || 0);
      }
    }
    if (circleIdx === null) score = score / SEGMENTS;
    if (score < frameMinConf) return;

    const stable = this.pushVoteAndGetStable(circleIdx, score);
    if (!stable.ok) return;

    const stepIdx = this.data.collected.length;
    const expectedIdx = CIRCLE_IDX_SEQ[stepIdx];
    if (stable.idx !== expectedIdx) return;

    this.voteBuffer = [];
    this.setData({ scanState: 'matched' });
    this.handleScanSuccess(stepIdx, latencyMs, score, stable.idx);
  },


  async handleWinderFrame(yPlane, width, height, scaleX, scaleY, baseRect) {
    if (this.requestPending || this.data.winderStatus !== 'scan') return;

    const offsetX = baseRect ? baseRect.left : 0;
    const offsetY = baseRect ? baseRect.top : 0;
    const roiSize = Math.floor(this.windowWidth * 0.52);
    const roiW = Math.max(120, Math.floor(roiSize * scaleX));
    const roiH = roiW;
    const roiX = clamp(Math.floor((this.windowWidth / 2 - roiSize / 2 - offsetX) * scaleX), 0, Math.max(0, width - roiW));
    const roiY = clamp(Math.floor((this.windowHeight / 2 - roiSize / 2 - offsetY) * scaleY), 0, Math.max(0, height - roiH));

    const roiGray = new Uint8Array(roiW * roiH);
    let k = 0;
    for (let y = 0; y < roiH; y++) {
      const srcY = roiY + y;
      const rowOffset = srcY * width + roiX;
      for (let x = 0; x < roiW; x++) {
        roiGray[k++] = yPlane[rowOffset + x];
      }
    }

    this.requestPending = true;
    let result;
    try {
      const res = await callFunctionWithTimeout('opencvDetect', {
        roiGray: wx.arrayBufferToBase64(roiGray.buffer),
        roiWidth: roiW,
        roiHeight: roiH,
        scene: 'winder',
      });
      result = res && res.result && res.result.result;
    } catch (err) {
      this.winderTimeoutCount += 1;
      if (this.winderTimeoutCount >= 2) {
        this.setData({ winderHint: '网络不稳定，请稍后再试' });
      }
      this.requestPending = false;
      return;
    }
    this.requestPending = false;

    if (!result) return;
    if (result.aligned && Number(result.score || 0) >= 0.7) {
      this.setData({ winderStatus: 'aligned', winderHint: '对齐成功！顺时针旋转发条' });
      return;
    }

    const now = Date.now();
    if (result.reason && now - this.winderLastTipAt > 2000) {
      this.winderLastTipAt = now;
      const reasonMap = {
        LOW_SCORE: '对齐度不足，请将图案更居中',
        NO_CONTOUR: '未识别到发条轮廓，请对准图案',
        BLUR: '画面有点糊，保持手机稳定',
      };
      const hint = reasonMap[result.reason] || '发条还没对齐，请将图案放在框内';
      this.setData({ winderHint: hint });
    }

    if (now - this.winderAlignStart > 8000 && !this.data.showGuideCard) {
      this.setData({ showGuideCard: true });
    }
  },

  onWinderRotateStart(e) {
    if (this.data.step !== 'winder' || this.data.winderStatus === 'scan') return;
    const { x, y } = e.touches[0] || {};
    if (typeof x !== 'number' || typeof y !== 'number') return;
    const dx = x - this.winderCenter.x;
    const dy = y - this.winderCenter.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < this.winderMinR || dist > this.winderMaxR) return;
    this.rotateActive = true;
    this.lastRotateAngle = Math.atan2(dy, dx);
    this.setData({ winderStatus: 'rotating', winderHint: '继续旋转中…' });
  },

  onWinderRotateMove(e) {
    if (!this.rotateActive || this.data.step !== 'winder') return;
    const { x, y } = e.touches[0] || {};
    if (typeof x !== 'number' || typeof y !== 'number') return;
    const dx = x - this.winderCenter.x;
    const dy = y - this.winderCenter.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < this.winderMinR || dist > this.winderMaxR) return;

    const angle = Math.atan2(dy, dx);
    let delta = angle - this.lastRotateAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    if (Math.abs(delta) < (15 * Math.PI) / 180) return;

    const nextDegree = this.data.rotateDegree + (delta * 180) / Math.PI;
    this.lastRotateAngle = angle;

    if (nextDegree >= 360) {
      this.setData({ rotateDegree: 360, winderStatus: 'completed', winderHint: '旋转完成，启动八音盒' });
      this.rotateActive = false;
      this.finishWinder();
    } else {
      this.setData({ rotateDegree: Math.max(0, nextDegree) });
    }
  },

  onWinderRotateEnd() {
    if (this.data.step !== 'winder') return;
    this.rotateActive = false;
    if (this.data.winderStatus === 'rotating') {
      this.setData({ winderStatus: 'aligned', winderHint: '继续顺时针旋转发条' });
    }
  },

  finishWinder() {
    if (this.winderGuideTimer) clearTimeout(this.winderGuideTimer);
    this.winderGuideTimer = setTimeout(() => {
      this.setData({ step: 'blow', blowState: 'intro', blowHint: '对着手机轻轻吹一口气' });
      this.startBlowFlow();
    }, 1200);
  },

  startBlowFlow() {
    if (this.blowIntroTimer) clearTimeout(this.blowIntroTimer);
    this.stopRecorder();
    this.setData({ blowState: 'intro', blowHint: '准备吹气' });

    this.blowIntroTimer = setTimeout(() => {
      if (this.data.step !== 'blow') return;
      this.setData({ blowState: 'listening', blowHint: '对着麦克风轻吹' });
      this.startRecorder();
      this.scheduleBlowTimeout();
    }, 1200);
  },

  scheduleBlowTimeout() {
    if (this.blowTimeoutTimer) clearTimeout(this.blowTimeoutTimer);
    this.blowTimeoutTimer = setTimeout(() => {
      if (this.data.step !== 'blow' || this.data.blowState !== 'listening') return;
      this.setData({ blowHint: '保持对着麦克风轻吹' });
      this.scheduleBlowTimeout();
    }, 8000);
  },

  startRecorder() {
    if (this.recorder) return;
    this.recorder = wx.getRecorderManager();
    this.recorder.onFrameRecorded((res) => {
      if (this.data.step !== 'blow' || this.data.blowState !== 'listening') return;
      const rms = calcRms(res.frameBuffer);
      this.blowRmsBuffer.push(rms);
      if (this.blowRmsBuffer.length > 3) this.blowRmsBuffer.shift();
      const avg = this.blowRmsBuffer.reduce((a, b) => a + b, 0) / this.blowRmsBuffer.length;
      this.setData({ blowLevel: avg });

      if (avg >= BLOW_THRESHOLD) {
        if (!this.blowAboveStart) this.blowAboveStart = Date.now();
        if (Date.now() - this.blowAboveStart >= BLOW_HOLD_MS) {
          this.onBlowSuccess();
        }
      } else {
        this.blowAboveStart = 0;
      }
    });

    this.recorder.onStop(() => {});
    this.recorder.start({
      duration: 600000,
      sampleRate: 16000,
      numberOfChannels: 1,
      format: 'PCM',
      frameSize: 20,
    });
  },

  stopRecorder() {
    if (this.recorder) {
      try {
        this.recorder.stop();
      } catch (err) {
        // ignore
      }
    }
    this.recorder = null;
    this.blowRmsBuffer = [];
    this.blowAboveStart = 0;
  },

  onBlowSuccess() {
    if (this.data.step !== 'blow') return;
    this.stopRecorder();
    this.setData({ blowState: 'success', blowHint: '蜡烛已熄灭，生日快乐！' });
    if (this.blowTimeoutTimer) clearTimeout(this.blowTimeoutTimer);
    if (this.blowIntroTimer) clearTimeout(this.blowIntroTimer);
    setTimeout(() => {
      this.setData({ step: 'done', blowState: 'done', showAchievement: true });
    }, 2000);
  },

  trackScanEvent(payload) {
    if (this.scanTrackTimer) clearTimeout(this.scanTrackTimer);
    this.scanTrackTimer = setTimeout(() => {
      try {
        wx.reportEvent('xr_scan_match', payload);
      } catch (err) {
        // ignore
      }
    }, 0);
  },

  toggleTuner() {
    this.setData({ showTuner: !this.data.showTuner });
  },

  toggleDebugRoi() {
    const next = !this.data.debugRoi;
    this.setData({ debugRoi: next });
    if (!next) {
      this.setData({ debugImageInput: '' });
    }
  },

  toggleDebugRoiBinary() {
    const next = !this.data.debugRoiBinary;
    this.setData({ debugRoiBinary: next });
  },

  adjustTuner(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key;
    const delta = Number(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.delta || 0);
    if (!key || !delta) return;

    const curr = Number((this.data.tuner && this.data.tuner[key]) || 0);
    let nextValue = curr + delta;
    if (key === 'frameMinConf' || key === 'stableMinAvgConf' || key === 'matchThreshold') {
      nextValue = Math.max(0, Math.min(1, Number(nextValue.toFixed(2))));
    }
    if (key === 'edgeRatioEmpty') {
      nextValue = Math.max(0, Number(nextValue.toFixed(3)));
    }
    if (key === 'cannyLow') {
      nextValue = Math.max(0, Math.min(255, Math.round(nextValue)));
    }
    if (key === 'cannyHigh') {
      nextValue = Math.max(1, Math.min(255, Math.round(nextValue)));
    }
    if (key === 'requestInterval' || key === 'requestIntervalWeak') {
      nextValue = Math.max(40, Math.round(nextValue));
    }

    const next = {
      ...(this.data.tuner || {}),
      [key]: nextValue,
    };
    this.setData({ tuner: next });
    wx.setStorageSync('xr_tuner', next);
  },

  applyTunerPreset(e) {
    const preset = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.preset;
    if (!preset) return;
    let next = null;
    if (preset === 'strict') {
      next = {
        ...(this.data.tuner || {}),
        frameMinConf: 0.7,
        stableMinAvgConf: 0.86,
        requestInterval: 180,
        cannyLow: 60,
        cannyHigh: 160,
        edgeRatioEmpty: 0.02,
        matchThreshold: 0.38,
      };
    } else if (preset === 'balanced') {
      next = {
        ...(this.data.tuner || {}),
        frameMinConf: 0.65,
        stableMinAvgConf: 0.82,
        requestInterval: 160,
        cannyLow: 40,
        cannyHigh: 120,
        edgeRatioEmpty: 0.015,
        matchThreshold: 0.32,
      };
    } else if (preset === 'loose') {
      next = {
        ...(this.data.tuner || {}),
        frameMinConf: 0.55,
        stableMinAvgConf: 0.75,
        requestInterval: 220,
        cannyLow: 30,
        cannyHigh: 100,
        edgeRatioEmpty: 0.012,
        matchThreshold: 0.28,
      };
    }

    if (next) {
      this.setData({ tuner: next });
      wx.setStorageSync('xr_tuner', next);
    }
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },
});
