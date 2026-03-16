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

const REQUEST_INTERVAL_MS = 160;
const REQUEST_INTERVAL_WEAK_MS = 330;
const REQUEST_TIMEOUT_MS = 1200;
const COOLDOWN_MS = 2000;
const MATCHED_MS = 800;

const FRAME_MIN_CONF = 0.65;
const STABLE_MIN_AVG_CONF = 0.82;
const VOTE_WINDOW = 5;
const VOTE_MIN_HIT = 2;

const BLOW_THRESHOLD = 0.35;
const BLOW_HOLD_MS = 600;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function callFunctionWithTimeout(name, data, timeout = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    wx.cloud.callFunction({ name, data }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
  ]);
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
  },

  onLoad(options) {
    if (options.cupId) this.cupId = options.cupId;
  },

  onReady() {
    this.camCtx = wx.createCameraContext();
    this.overlayCtx = wx.createCanvasContext('overlay', this);

    const sysInfo = wx.getSystemInfoSync();
    this.windowWidth = sysInfo.windowWidth;
    this.windowHeight = sysInfo.windowHeight;

    this.setData({
      canvasWidth: this.windowWidth,
      canvasHeight: this.windowHeight,
    });

    this.uiRoiW = Math.floor((100 * this.windowWidth) / 750);
    this.uiRoiH = Math.floor((700 * this.windowWidth) / 750);
    this.uiRoiX = Math.floor(this.windowWidth / 2 - this.uiRoiW / 2);
    this.uiRoiY = Math.floor(this.windowHeight / 2 - this.uiRoiH / 2);

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

    this.listener = this.camCtx.onCameraFrame(this.handleFrame.bind(this));
    this.listener.start();
  },

  onHide() {
    this.stopAll();
  },

  onUnload() {
    this.stopAll();
  },

  stopAll() {
    if (this.listener) this.listener.stop();
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
    this.stopRecorder();
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

  drawOverlay(boxes, labels, scaleX, scaleY) {
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.windowWidth, this.windowHeight);

    if (!boxes || !boxes.length) {
      ctx.setStrokeStyle('#ffffffaa');
      ctx.setLineWidth(3);
      ctx.strokeRect(this.uiRoiX, this.uiRoiY, this.uiRoiW, this.uiRoiH);
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
        color = '#ffffff55';
        text = '—';
      }

      const x = b.x / scaleX;
      const y = b.y / scaleY;
      const w = b.w / scaleX;
      const h = b.h / scaleY;

      ctx.setStrokeStyle(color);
      ctx.setLineWidth(3);
      ctx.strokeRect(x, y, w, h);
      ctx.setFillStyle(color);
      ctx.setFontSize(16);
      ctx.fillText(text, x + w / 2 - 6, y + h / 2 + 6);
    }

    ctx.draw();
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

    if (stableCnt < VOTE_MIN_HIT || stableAvg < this.data.stableMinAvgConf) return { ok: false };
    return { ok: true, idx: stableIdx };
  },

  async handleFrame(frame) {
    const { width, height } = frame;
    if (!width || !height || !frame.data) return;

    if (this.data.step !== 'scan' && this.data.step !== 'winder') return;

    const now = Date.now();
    const interval = this.scanWeakNetwork ? REQUEST_INTERVAL_WEAK_MS : REQUEST_INTERVAL_MS;
    if (now - this.lastRequestAt < interval) return;
    this.lastRequestAt = now;

    const scaleX = width / this.windowWidth;
    const scaleY = height / this.windowHeight;
    const yPlane = new Uint8Array(frame.data);

    if (this.data.step === 'scan') {
      await this.handleScanFrame(yPlane, width, height, scaleX, scaleY);
    } else if (this.data.step === 'winder') {
      await this.handleWinderFrame(yPlane, width, height, scaleX, scaleY);
    }
  },

  async handleScanFrame(yPlane, width, height, scaleX, scaleY) {
    if (this.requestPending || this.data.scanState === 'cooldown' || this.data.scanState === 'matched') return;

    const roiW = Math.max(10, Math.floor(this.uiRoiW * scaleX));
    const roiH = Math.max(60, Math.floor(this.uiRoiH * scaleY));
    const roiX = clamp(Math.floor(this.uiRoiX * scaleX), 0, Math.max(0, width - roiW));
    const roiY = clamp(Math.floor(this.uiRoiY * scaleY), 0, Math.max(0, height - roiH));

    const samples = [];
    const sx = Math.max(2, Math.floor(roiW / 8));
    const sy = Math.max(2, Math.floor(roiH / 14));
    for (let y = roiY; y < roiY + roiH; y += sy) {
      for (let x = roiX; x < roiX + roiW; x += sx) {
        samples.push(yPlane[y * width + x]);
      }
    }
    const threshold = clamp(Math.floor(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length) * 0.82), 35, 210);

    const boxes = this.detectOrderedBoxes(yPlane, width, roiX, roiY, roiW, roiH, threshold) || this.getFallbackBoxes(roiX, roiY, roiW, roiH);

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
    let latencyMs = 0;
    try {
      const startAt = Date.now();
      const res = await callFunctionWithTimeout('opencvDetect', {
        roiGray: wx.arrayBufferToBase64(roiGray.buffer),
        roiWidth: roiW,
        roiHeight: roiH,
        thresholdHint: threshold,
        scene: 'ar_scan',
      });
      latencyMs = Date.now() - startAt;
      result = res && res.result && res.result.result;
    } catch (err) {
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
    if (!result || !Array.isArray(result.slots)) return;

    const labels = result.slots.slice(0, SEGMENTS);
    const confs = Array.isArray(result.confidences) ? result.confidences.slice(0, SEGMENTS) : [];
    const safeLabels = labels.map((label, i) => {
      const conf = Number(confs[i] || 0);
      if (!label || label === 'unknown' || conf < this.data.frameMinConf) return 'unknown';
      return label;
    });

    const patternSymbols = safeLabels.map((c) => (c === 'circle' ? '●' : c === 'cross' ? '❌' : c === 'empty' ? '—' : '?'));
    const patternStr = patternSymbols.join(' ');
    if (patternStr !== this.data.scanPattern) this.setData({ scanPattern: patternStr, scanHint: '' });

    this.drawOverlay(boxes, safeLabels, scaleX, scaleY);

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
    if (score < this.data.frameMinConf) return;

    const stable = this.pushVoteAndGetStable(circleIdx, score);
    if (!stable.ok) return;

    const stepIdx = this.data.collected.length;
    const expectedIdx = CIRCLE_IDX_SEQ[stepIdx];
    if (stable.idx !== expectedIdx) return;

    this.voteBuffer = [];
    this.setData({ scanState: 'matched' });
    this.handleScanSuccess(stepIdx, latencyMs, score, stable.idx);
  },

  handleScanSuccess(stepIdx) {
    const collected = this.data.collected.concat(stepIdx);
    const percent = (collected.length / TOTAL_COUNT) * 100;
    const expectedIdx = CIRCLE_IDX_SEQ[stepIdx];
    const noteName = STEP_NOTE_NAME[stepIdx];

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
      }, 1200);
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

  async handleWinderFrame(yPlane, width, height, scaleX, scaleY) {
    if (this.requestPending || this.data.winderStatus !== 'scan') return;

    const roiSize = Math.floor(this.windowWidth * 0.52);
    const roiW = Math.max(120, Math.floor(roiSize * scaleX));
    const roiH = roiW;
    const roiX = clamp(Math.floor((this.windowWidth / 2 - roiSize / 2) * scaleX), 0, Math.max(0, width - roiW));
    const roiY = clamp(Math.floor((this.windowHeight / 2 - roiSize / 2) * scaleY), 0, Math.max(0, height - roiH));

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

  goHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },
});
