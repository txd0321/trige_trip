const CLASS_OPTIONS = [
  'pattern_circle_1',
  'pattern_circle_2',
  'pattern_circle_3',
  'pattern_circle_4',
  'pattern_circle_5',
  'pattern_all_cross',
];

const MANIFEST_KEY = 'pattern_collector_manifest_v2';

const COS_CONFIG = {
  bucket: 'miniapp-assets-cupi-1327655007',
  region: 'ap-guangzhou',
  workerBaseUrl: 'https://surface-irrigation-freely-highest.trycloudflare.com',
};

// ROI 统一比例（宽/高）。这个值保持 UI 蓝框与实际 ROI 的固定形状一致。
const ROI_ASPECT_RATIO = 0.34;

// ROI 校准参数：用于不同机型微调预览框与实际裁剪的一致性
// offsetX/offsetY：像素偏移（正数表示向右/向下）
// scaleX/scaleY：缩放系数（>1 变大，<1 变小）
const ROI_CALIBRATION = {
  offsetX: 0,
  offsetY: 18,
  scaleX: 1.12,
  scaleY: 1.12,
};

function mapRectUiToImage(uiRect, uiSize, imgSize) {
  // camera 预览更接近 aspectFill（cover），而不是 contain
  // 所以需要用 cover 的映射关系，把 UI 框坐标准确反推回原图坐标
  const uiAspect = uiSize.width / uiSize.height;
  const imgAspect = imgSize.width / imgSize.height;

  let scale = 1;
  let cropOffsetX = 0;
  let cropOffsetY = 0;

  if (imgAspect > uiAspect) {
    // 图更宽：按高度铺满，左右会被裁掉
    scale = uiSize.height / imgSize.height;
    const displayedW = imgSize.width * scale;
    cropOffsetX = (displayedW - uiSize.width) / 2;
  } else {
    // 图更高：按宽度铺满，上下会被裁掉
    scale = uiSize.width / imgSize.width;
    const displayedH = imgSize.height * scale;
    cropOffsetY = (displayedH - uiSize.height) / 2;
  }

  return {
    x: Math.round((uiRect.x + cropOffsetX) / scale),
    y: Math.round((uiRect.y + cropOffsetY) / scale),
    width: Math.round(uiRect.width / scale),
    height: Math.round(uiRect.height / scale),
  };
}

function sanitizeClassName(name) {
  return (name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function applyRoiCalibration(rect) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const width = Math.round(rect.width * ROI_CALIBRATION.scaleX);
  const height = Math.round(rect.height * ROI_CALIBRATION.scaleY);

  const x = Math.round(centerX - width / 2 + ROI_CALIBRATION.offsetX);
  const y = Math.round(centerY - height / 2 + ROI_CALIBRATION.offsetY);

  return {
    x,
    y,
    width,
    height,
  };
}

Page({
  data: {
    classOptions: CLASS_OPTIONS,
    classIndex: 0,
    currentClass: CLASS_OPTIONS[0],
    classCounters: {},
    totalCount: 0,
    lastRoiPath: '',
    lastCosKey: '',
    lastCosUrl: '',
    inferLabel: '',
    inferConfidence: 0,
    inferConfidenceText: '',
    inferRaw: null,
    inferDebugText: '',
    showRoiPreview: true,
    canvasWidth: 375,
    canvasHeight: 667,
    cropCanvasWidth: 300,
    cropCanvasHeight: 300,
    inferCanvasSize: 640,
  },

  onLoad() {
    const sys = wx.getSystemInfoSync();
    const saved = wx.getStorageSync(MANIFEST_KEY) || [];
    const counters = {};
    saved.forEach((item) => {
      counters[item.label] = (counters[item.label] || 0) + 1;
    });

    this.manifest = saved;
    this.screenW = sys.windowWidth;
    this.screenH = sys.windowHeight;
    this.roiRect = this.getRoiRect(this.screenW, this.screenH);

    this.setData({
      canvasWidth: this.screenW,
      canvasHeight: this.screenH,
      classCounters: counters,
      totalCount: saved.length,
      cropCanvasWidth: this.roiRect.width,
      cropCanvasHeight: this.roiRect.height,
    });
  },

  onReady() {
    this.cameraCtx = wx.createCameraContext();
    this.overlayCtx = wx.createCanvasContext('collectorOverlay', this);
    this.cropCtx = wx.createCanvasContext('collectorCropCanvas', this);
    this.drawOverlay();
  },

  getRoiRect(w, h) {
    const roiH = Math.round(h * 0.66);
    const roiW = Math.round(roiH * ROI_ASPECT_RATIO);
    const roiX = Math.round((w - roiW) / 2);
    const roiY = Math.round((h - roiH) / 2);
    return { x: roiX, y: roiY, width: roiW, height: roiH };
  },

  drawOverlay() {
    if (!this.overlayCtx || !this.roiRect) return;
    const ctx = this.overlayCtx;
    const { x, y, width, height } = this.roiRect;

    ctx.clearRect(0, 0, this.screenW, this.screenH);
    ctx.setLineWidth(3);
    ctx.setStrokeStyle('#00c2ff');
    ctx.strokeRect(x, y, width, height);

    const segH = height / 5;
    ctx.setLineWidth(1);
    ctx.setStrokeStyle('rgba(255,255,255,0.35)');
    for (let i = 1; i < 5; i++) {
      const yy = y + segH * i;
      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x + width, yy);
      ctx.stroke();
    }

    ctx.setFillStyle('rgba(0,0,0,0.45)');
    ctx.fillRect(0, 0, this.screenW, y);
    ctx.fillRect(0, y + height, this.screenW, this.screenH - (y + height));
    ctx.fillRect(0, y, x, height);
    ctx.fillRect(x + width, y, this.screenW - (x + width), height);

    ctx.draw();
  },

  onClassChange(e) {
    const idx = Number(e.detail.value || 0);
    this.setData({
      classIndex: idx,
      currentClass: this.data.classOptions[idx],
    });
  },

  togglePreviewRoi() {
    this.setData({ showRoiPreview: !this.data.showRoiPreview });
  },

  captureRoi() {
    if (!this.cameraCtx) return;
    wx.showLoading({ title: '上传中', mask: true });

    this.cameraCtx.takePhoto({
      quality: 'high',
      success: async (res) => {
        try {
          const result = await this.cropAndUploadRoi(res.tempImagePath);
          wx.hideLoading();
          wx.showToast({ title: '已上传COS', icon: 'success' });
          this.setData({
            lastRoiPath: result.localPreviewPath,
            lastCosKey: result.cosKey,
            lastCosUrl: result.cosUrl,
          });
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: err?.message || '上传失败', icon: 'none' });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '拍照失败', icon: 'none' });
      },
    });
  },

  captureAndInfer() {
    if (!this.cameraCtx) return;
    wx.showLoading({ title: '识别中', mask: true });

    this.cameraCtx.takePhoto({
      quality: 'high',
      success: async (res) => {
        try {
          const cropRes = await this.cropRoiOnly(res.tempImagePath);
          const inferResPath = await this.buildInferInputImage(cropRes.tempFilePath, cropRes.width, cropRes.height, 640);
          const inferRes = await this.inferByRoboflow(inferResPath);
          const top = this.pickTopPrediction(inferRes);

          console.log(
            '[infer-debug-json]',
            JSON.stringify(
              {
                workerBaseUrl: COS_CONFIG.workerBaseUrl,
                top,
                normalized: inferRes?.__normalized,
                keys: Object.keys(inferRes || {}),
                predictionsType: Array.isArray(inferRes?.predictions)
                  ? 'array'
                  : typeof inferRes?.predictions,
                inferRes,
              },
              null,
              2
            )
          );

          wx.hideLoading();
          const confidence = top?.confidence || 0;
          const debugPayload = {
            top,
            normalized: inferRes?.__normalized || null,
            keys: inferRes ? Object.keys(inferRes) : [],
            predictionsType: Array.isArray(inferRes?.predictions)
              ? 'array'
              : typeof inferRes?.predictions,
          };

          this.setData({
            lastRoiPath: cropRes.tempFilePath,
            inferLabel: top?.label || 'unknown',
            inferConfidence: confidence,
            inferConfidenceText: `${(confidence * 100).toFixed(1)}%`,
            inferRaw: inferRes,
            inferDebugText: JSON.stringify(debugPayload),
          });
          wx.showToast({ title: '识别完成', icon: 'success' });
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: err?.message || '识别失败', icon: 'none' });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '拍照失败', icon: 'none' });
      },
    });
  },

  getImageInfo(src) {
    return new Promise((resolve, reject) => {
      wx.getImageInfo({
        src,
        success: resolve,
        fail: reject,
      });
    });
  },

  canvasToTempFilePath(params) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath(
        {
          ...params,
          success: resolve,
          fail: reject,
        },
        this
      );
    });
  },

  setCropCanvasSize(width, height) {
    return new Promise((resolve) => {
      this.setData(
        {
          cropCanvasWidth: width,
          cropCanvasHeight: height,
        },
        resolve
      );
    });
  },

  requestSignedUpload(className, ext) {
    const safeClassName = sanitizeClassName(className);
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${COS_CONFIG.workerBaseUrl}/api/cos/sign-upload`,
        method: 'GET',
        data: {
          className: safeClassName,
          ext,
        },
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300 && res.data?.uploadUrl) {
            resolve(res.data);
            return;
          }
          reject(new Error(res.data?.error || '签名接口返回异常'));
        },
        fail: (err) => reject(new Error(`签名接口请求失败: ${err?.errMsg || 'network error'}`)),
      });
    });
  },

  uploadFileToCos(filePath, uploadUrl) {
    const fs = wx.getFileSystemManager();
    return new Promise((resolve, reject) => {
      fs.readFile({
        filePath,
        success: (readRes) => {
          wx.request({
            url: uploadUrl,
            method: 'PUT',
            data: readRes.data,
            header: {
              'Content-Type': 'image/jpeg',
            },
            success: (res) => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(res);
                return;
              }
              reject(new Error(`COS上传失败(${res.statusCode})`));
            },
            fail: (err) => reject(new Error(err?.errMsg || '上传到COS失败')),
          });
        },
        fail: (err) => reject(new Error(err?.errMsg || '读取文件失败')),
      });
    });
  },

  async cropRoiOnly(photoPath) {
    const info = await this.getImageInfo(photoPath);

    const mappedRect = mapRectUiToImage(
      this.roiRect,
      { width: this.screenW, height: this.screenH },
      { width: info.width, height: info.height }
    );

    const cropRect = applyRoiCalibration(mappedRect);

    const sx = Math.max(0, Math.min(info.width - 1, cropRect.x));
    const sy = Math.max(0, Math.min(info.height - 1, cropRect.y));
    const sw = Math.max(10, Math.min(info.width - sx, cropRect.width));
    const sh = Math.max(10, Math.min(info.height - sy, cropRect.height));

    await this.setCropCanvasSize(sw, sh);
    this.cropCtx = wx.createCanvasContext('collectorCropCanvas', this);

    this.cropCtx.clearRect(0, 0, sw, sh);
    // 兼容旧版 CanvasContext：不使用 9 参数裁剪，改为整图平移后导出可见区域
    this.cropCtx.drawImage(photoPath, -sx, -sy, info.width, info.height);

    await new Promise((resolve) => this.cropCtx.draw(false, resolve));

    const cropRes = await this.canvasToTempFilePath({
      canvasId: 'collectorCropCanvas',
      x: 0,
      y: 0,
      width: sw,
      height: sh,
      destWidth: sw,
      destHeight: sh,
      fileType: 'jpg',
      quality: 0.92,
    });

    return {
      tempFilePath: cropRes.tempFilePath,
      width: sw,
      height: sh,
    };
  },

  async cropAndUploadRoi(photoPath) {
    const currentLabel = this.data.currentClass;
    const cropRes = await this.cropRoiOnly(photoPath);

    const signed = await this.requestSignedUpload(currentLabel, 'jpg');
    await this.uploadFileToCos(cropRes.tempFilePath, signed.uploadUrl);

    const ts = Date.now();
    const record = {
      label: currentLabel,
      ts,
      roi: this.roiRect,
      cosKey: signed.key,
      cosUrl: signed.fileUrl,
      localPreviewPath: cropRes.tempFilePath,
      bucket: COS_CONFIG.bucket,
      region: COS_CONFIG.region,
    };

    this.manifest.push(record);
    wx.setStorageSync(MANIFEST_KEY, this.manifest);

    const classCounters = { ...(this.data.classCounters || {}) };
    classCounters[currentLabel] = (classCounters[currentLabel] || 0) + 1;

    this.setData({
      classCounters,
      totalCount: this.manifest.length,
    });

    return {
      localPreviewPath: cropRes.tempFilePath,
      cosKey: signed.key,
      cosUrl: signed.fileUrl,
    };
  },

  buildInferInputImage(sourcePath, srcW, srcH, targetSize = 320) {
    return new Promise((resolve, reject) => {
      this.setData(
        { inferCanvasSize: targetSize },
        () => {
          const inferCtx = wx.createCanvasContext('collectorInferCanvas', this);

          // 按你的要求：stretch 拉伸占满 320x320
          inferCtx.clearRect(0, 0, targetSize, targetSize);
          inferCtx.drawImage(sourcePath, 0, 0, targetSize, targetSize);
          inferCtx.draw(false, () => {
            wx.canvasToTempFilePath(
              {
                canvasId: 'collectorInferCanvas',
                x: 0,
                y: 0,
                width: targetSize,
                height: targetSize,
                destWidth: targetSize,
                destHeight: targetSize,
                fileType: 'jpg',
                quality: 0.92,
                success: (res) => resolve(res.tempFilePath),
                fail: (err) => reject(new Error(err?.errMsg || '生成识别输入图失败')),
              },
              this
            );
          });
        }
      );
    });
  },

  inferByRoboflow(filePath) {
    const fs = wx.getFileSystemManager();
    return new Promise((resolve, reject) => {
      fs.readFile({
        filePath,
        encoding: 'base64',
        success: (readRes) => {
          wx.request({
            url: `${COS_CONFIG.workerBaseUrl}/api/infer`,
            method: 'POST',
            header: {
              'Content-Type': 'application/json',
            },
            data: {
              imageBase64: readRes.data,
            },
            success: (res) => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(res.data || {});
                return;
              }
              reject(new Error(res.data?.error || `识别接口失败(${res.statusCode})`));
            },
            fail: (err) => reject(new Error(`识别请求失败: ${err?.errMsg || 'network error'}`)),
          });
        },
        fail: (err) => reject(new Error(err?.errMsg || '读取识别图片失败')),
      });
    });
  },

  pickTopPrediction(inferRes) {
    const pickLabel = (obj) =>
      obj?.label || obj?.class || obj?.class_name || obj?.classname || obj?.name || obj?.top || null;
    const pickScore = (obj) => {
      const v = obj?.confidence ?? obj?.score ?? obj?.probability ?? obj?.prob ?? obj?.conf;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    if (inferRes?.__normalized?.label) {
      return {
        label: String(inferRes.__normalized.label),
        confidence: Number(inferRes.__normalized.confidence || 0),
      };
    }

    const preds = inferRes?.predictions;

    if (Array.isArray(preds) && preds.length) {
      let topItem = preds[0];
      let topScore = pickScore(topItem);

      for (let i = 1; i < preds.length; i += 1) {
        const s = pickScore(preds[i]);
        if (s > topScore) {
          topScore = s;
          topItem = preds[i];
        }
      }

      const label = pickLabel(topItem) || (typeof inferRes?.top === 'string' ? inferRes.top : null) || 'unknown';
      return {
        label: String(label),
        confidence: Number(topScore || pickScore(inferRes) || 0),
      };
    }

    if (preds && typeof preds === 'object') {
      let bestLabel = 'unknown';
      let bestScore = 0;
      Object.keys(preds).forEach((k) => {
        const score = Number(preds[k] || 0);
        if (score > bestScore) {
          bestScore = score;
          bestLabel = k;
        }
      });
      return {
        label: String(typeof inferRes?.top === 'string' ? inferRes.top : bestLabel),
        confidence: Number(pickScore(inferRes) || bestScore || 0),
      };
    }

    if (Array.isArray(inferRes?.predicted_classes) && inferRes.predicted_classes.length) {
      const first = inferRes.predicted_classes[0] || {};
      return {
        label: String(pickLabel(first) || 'unknown'),
        confidence: Number(pickScore(first) || 0),
      };
    }

    if (typeof inferRes?.top === 'string') {
      return {
        label: inferRes.top,
        confidence: Number(pickScore(inferRes) || 0),
      };
    }

    return null;
  },

  exportManifest() {
    const fs = wx.getFileSystemManager();
    const userPath = wx.env.USER_DATA_PATH;
    const outPath = `${userPath}/pattern_dataset_manifest_${Date.now()}.json`;
    const payload = {
      exportedAt: Date.now(),
      total: this.manifest.length,
      classCounters: this.data.classCounters,
      items: this.manifest,
    };

    fs.writeFile({
      filePath: outPath,
      data: JSON.stringify(payload, null, 2),
      encoding: 'utf8',
      success: () => {
        wx.showModal({
          title: '导出成功',
          content: `清单已导出:\n${outPath}`,
          showCancel: false,
        });
      },
      fail: () => {
        wx.showToast({ title: '导出失败', icon: 'none' });
      },
    });
  },
});