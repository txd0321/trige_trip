import { playNoteAudio } from '../../utils/audio';

const SEGMENTS = 5;

const ROI_SEG_NOTE = [
  { id: 0, name: 'F5' },
  { id: 1, name: 'E5' },
  { id: 2, name: 'D5' },
  { id: 3, name: 'C5' },
  { id: 4, name: 'B4' },
];

// 13 步：只关心“圆在哪一段”，null 表示没有圆（第 7 步）
const CIRCLE_IDX_SEQ = [4, 4, 3, 4, 1, 2, null, 4, 4, 3, 4, 0, 1];
const STEP_NOTE_NAME = ['B4', 'B4', 'C5', 'B4', 'E5', 'D5', '', 'B4', 'B4', 'C5', 'B4', 'F5', 'E5'];
const TOTAL_COUNT = CIRCLE_IDX_SEQ.length;

function emaArray(prev, next, alpha) {
  if (!prev || prev.length !== next.length) return next;
  const out = new Array(next.length);
  for (let i = 0; i < next.length; i++) out[i] = prev[i] * (1 - alpha) + next[i] * alpha;
  return out;
}

function cosineSim(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

function normalizeVec(v) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < min) min = v[i];
    if (v[i] > max) max = v[i];
  }
  const range = max - min;
  if (range <= 1e-6) return v.map(() => 0);
  return v.map((x) => (x - min) / range);
}

// 圆模板：中心更强
const CIRCLE_TEMPLATE = [
  0.1, 0.2, 0.1,
  0.2, 1.0, 0.2,
  0.1, 0.2, 0.1,
];

// 判定阈值（可继续微调）
const CIRCLE_SCORE_TH = 0.80; // 圆模板相似度必须足够高
const BLACK_RATIO_TH = 0.10;  // 黑像素占比门槛（防白纸误判）
const MARGIN_TH = 0.12;       // 第一名与第二名分数差
const LOCK_FRAMES = 8;        // 连续帧锁定次数
const COOLDOWN_MS = 2000;     // 成功后冷却

Page({
  data: {
    collected: [],
    percent: 0,
    patternStr: '',
    canvasWidth: 0,
    canvasHeight: 0,
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

    // UI ROI：100rpx * 700rpx
    this.uiRoiW = Math.floor((100 * this.windowWidth) / 750);
    this.uiRoiH = Math.floor((700 * this.windowWidth) / 750);
    this.uiRoiX = Math.floor(this.windowWidth / 2 - this.uiRoiW / 2);
    this.uiRoiY = Math.floor(this.windowHeight / 2 - this.uiRoiH / 2);

    this.listener = this.camCtx.onCameraFrame(this.handleFrame.bind(this));
    this.listener.start();

    this.lastPushTs = 0;

    // 锁定机制
    this.lockIdx = undefined; // number|null|undefined
    this.lockCnt = 0;

    // 平滑：每段 9 维向量
    this.gridSmooth = new Array(SEGMENTS).fill(null);
  },

  onUnload() {
    this.listener && this.listener.stop();
  },

  handleFrame(frame) {
    const { width, height } = frame;
    if (!width) return;

    const yPlane = new Uint8Array(frame.data);

    const scaleX = width / this.windowWidth;
    const scaleY = height / this.windowHeight;

    const roiW_px = Math.max(10, Math.floor(this.uiRoiW * scaleX));
    const roiH_px = Math.max(60, Math.floor(this.uiRoiH * scaleY));
    const roiX = Math.max(0, Math.floor(this.uiRoiX * scaleX));
    const roiY = Math.max(0, Math.floor(this.uiRoiY * scaleY));

    const segH = Math.floor(roiH_px / SEGMENTS);

    // 阈值：ROI 中线采样中位数
    const samples = [];
    const centerX = roiX + Math.floor(roiW_px / 2);
    for (let y = roiY; y < roiY + roiH_px; y += 16) {
      samples.push(yPlane[y * width + centerX]);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] || 128;
    const threshold = median * 0.75;

    const circleScores = new Array(SEGMENTS).fill(0);
    const blackRatios = new Array(SEGMENTS).fill(0);

    for (let seg = 0; seg < SEGMENTS; seg++) {
      const yStart = roiY + seg * segH;
      const yEnd = seg === SEGMENTS - 1 ? roiY + roiH_px : yStart + segH;

      const cells = new Array(9).fill(0);
      const cellTotal = new Array(9).fill(0);
      let totalBlack = 0;
      let total = 0;

      for (let y = yStart; y < yEnd; y += 3) {
        const relY = y - yStart;
        const gy = Math.min(2, Math.floor((relY * 3) / Math.max(1, yEnd - yStart)));
        for (let x = roiX; x < roiX + roiW_px; x += 3) {
          const relX = x - roiX;
          const gx = Math.min(2, Math.floor((relX * 3) / Math.max(1, roiW_px)));
          const idx = gy * 3 + gx;
          const v = yPlane[y * width + x];
          if (v < threshold) {
            cells[idx] += 1;
            totalBlack++;
          }
          cellTotal[idx] += 1;
          total++;
        }
      }

      blackRatios[seg] = total ? totalBlack / total : 0;

      // 黑量太低直接 0 分（白纸/噪声）
      if (blackRatios[seg] < 0.02) {
        circleScores[seg] = 0;
        continue;
      }

      const dens = cells.map((b, i) => (cellTotal[i] ? b / cellTotal[i] : 0));
      const smooth = emaArray(this.gridSmooth[seg], dens, 0.30);
      this.gridSmooth[seg] = smooth;

      const vNorm = normalizeVec(smooth);
      circleScores[seg] = cosineSim(vNorm, CIRCLE_TEMPLATE);
    }

    // 找 top1/top2
    let bestIdx = 0;
    let bestScore = circleScores[0];
    let secondScore = -1;
    for (let i = 1; i < circleScores.length; i++) {
      const s = circleScores[i];
      if (s > bestScore) {
        secondScore = bestScore;
        bestScore = s;
        bestIdx = i;
      } else if (s > secondScore) {
        secondScore = s;
      }
    }
    const margin = bestScore - (secondScore < 0 ? 0 : secondScore);
    const maxBlack = Math.max.apply(null, blackRatios);

    // 最终圆判定：分数 + 黑量 + margin
    let circleIdx = null;
    if (maxBlack >= BLACK_RATIO_TH && bestScore >= CIRCLE_SCORE_TH && blackRatios[bestIdx] >= BLACK_RATIO_TH && margin >= MARGIN_TH) {
      circleIdx = bestIdx;
    }

    // 顶部显示（只显示一个圆或全叉）
    const patternArr = new Array(SEGMENTS).fill('❌');
    if (circleIdx !== null) patternArr[circleIdx] = '●';
    const patternStr = patternArr.join(' ');
    if (patternStr !== this.data.patternStr) this.setData({ patternStr });

    // 可视化：圆段绿，其余橙
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.windowWidth, this.windowHeight);
    const uiSegH = this.uiRoiH / SEGMENTS;
    for (let seg = 0; seg < SEGMENTS; seg++) {
      const y0 = this.uiRoiY + seg * uiSegH;
      const isCircle = circleIdx === seg;
      const color = isCircle ? '#00ff00' : '#ff6400';
      ctx.setStrokeStyle(color);
      ctx.setLineWidth(3);
      ctx.strokeRect(this.uiRoiX, y0, this.uiRoiW, uiSegH);
      ctx.setFillStyle(color);
      ctx.setFontSize(18);
      ctx.fillText(isCircle ? '●' : '✕', this.uiRoiX + this.uiRoiW / 2 - 6, y0 + uiSegH / 2 + 6);
    }
    ctx.draw();

    // ===== 锁定状态机：只在“稳定锁定”后才用于推进 =====
    // 候选值：circleIdx (0-4) 或 null
    const candidate = circleIdx;

    if (this.lockIdx === undefined) {
      this.lockIdx = candidate;
      this.lockCnt = 1;
    } else if (this.lockIdx === candidate) {
      this.lockCnt++;
    } else {
      // 候选变化，重置锁
      this.lockIdx = candidate;
      this.lockCnt = 1;
    }

    // 满足锁定帧数后，才认为“当前识别结果稳定”
    const stableIdx = this.lockCnt >= LOCK_FRAMES ? this.lockIdx : undefined;

    if (stableIdx === undefined) return;

    // 序列推进
    const stepIdx = this.data.collected.length;
    const expectedIdx = CIRCLE_IDX_SEQ[stepIdx];
    const matched = stableIdx === expectedIdx;

    const now = Date.now();
    if (matched && now - this.lastPushTs > COOLDOWN_MS) {
      this.lastPushTs = now;
      this.onStepSuccess(stepIdx);
    }
  },

  onStepSuccess(stepIdx) {
    const collected = this.data.collected.concat(stepIdx);
    const percent = (collected.length / TOTAL_COUNT) * 100;

    const expectedIdx = CIRCLE_IDX_SEQ[stepIdx];
    const noteName = STEP_NOTE_NAME[stepIdx];

    if (expectedIdx !== null) {
      const note = ROI_SEG_NOTE[expectedIdx];
      playNoteAudio(note.id);
      wx.showToast({ title: noteName || note.name, icon: 'none', duration: 800 });
    } else {
      wx.showToast({ title: '识别成功', icon: 'none', duration: 800 });
    }

    this.setData({ collected, percent });

    // 成功后重置锁，避免立即重复推进
    this.lockIdx = undefined;
    this.lockCnt = 0;

    if (collected.length >= TOTAL_COUNT) {
      wx.showToast({ title: '扫描完成', icon: 'success' });
      this.listener && this.listener.stop();
      setTimeout(() => wx.navigateTo({ url: '/pages/winder/index' }), 1200);
    }
  },
});
