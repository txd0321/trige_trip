const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const PATCH_SIZE_DEFAULT = 32;

const DEFAULT_PARAMS = {
  binarizeFactor: 0.82,
  minThreshold: 20,
  maxThreshold: 220,
  emptyFillLow: 0.05,
  overFillHigh: 0.75,
  emptyScoreGate: 0.70,
  emptyFillGate: 0.10,
  circlePreferCenterFill: 0.42,
  circlePreferFill: 0.16,
  circlePreferDiagMax: 0.72,
  circlePreferScoreMin: 0.42,
  circleDiffMin: 0.05,
  circleScoreMin: 0.52,
  crossDiffMin: 0.14,
  crossScoreMin: 0.62,
  circleFallbackCenter: 0.40,
  circleFallbackDiagMax: 0.72,
  circleFallbackScoreMin: 0.42,
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function decodePatch(base64Str, patchSize) {
  const buf = Buffer.from(base64Str, 'base64');
  const expected = patchSize * patchSize;
  if (buf.length < expected) return null;

  const arr = new Uint8Array(expected);
  for (let i = 0; i < expected; i++) arr[i] = buf[i];
  return arr;
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

function binarize(arr, patchSize, params) {
  const m = mean(arr);
  const th = clamp(Math.floor(m * params.binarizeFactor), params.minThreshold, params.maxThreshold);
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = arr[i] < th ? 1 : 0;
  }

  // 3x3 opening-like clean (simple despeckle)
  const cleaned = new Uint8Array(out.length);
  for (let y = 1; y < patchSize - 1; y++) {
    for (let x = 1; x < patchSize - 1; x++) {
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          cnt += out[(y + dy) * patchSize + (x + dx)];
        }
      }
      cleaned[y * patchSize + x] = cnt >= 4 ? 1 : 0;
    }
  }

  return cleaned;
}

function classifyPatch(grayArr, patchSize, params) {
  const bw = binarize(grayArr, patchSize, params);

  let area = 0;
  let center = 0;
  let centerTotal = 0;
  let d1 = 0;
  let d2 = 0;

  const min = Math.floor(patchSize * 0.35);
  const max = Math.floor(patchSize * 0.65);

  for (let y = 0; y < patchSize; y++) {
    for (let x = 0; x < patchSize; x++) {
      const v = bw[y * patchSize + x];
      area += v;

      if (x >= min && x < max && y >= min && y < max) {
        center += v;
        centerTotal++;
      }

      if (Math.abs(y - x) <= 1) d1 += v;
      if (Math.abs(y - (patchSize - 1 - x)) <= 1) d2 += v;
    }
  }

  const fill = area / Math.max(1, patchSize * patchSize);
  const centerFill = center / Math.max(1, centerTotal);
  const diagScore = (d1 + d2) / Math.max(1, patchSize * 2);

  if (fill < params.emptyFillLow) {
    return { label: 'empty', confidence: 0.95 };
  }

  if (fill > params.overFillHigh) {
    return { label: 'unknown', confidence: 0.2 };
  }

  const circleScore = clamp((fill - 0.20) * 2.1 + centerFill * 1.15 - (diagScore - 0.48) * 0.22, 0, 1);
  const crossScore = clamp((diagScore - 0.42) * 1.05 + (0.40 - centerFill) * 0.75 + (0.30 - fill) * 0.65, 0, 1);
  const emptyScore = clamp((0.08 - fill) * 7.0, 0, 1);

  if (emptyScore >= params.emptyScoreGate && fill < params.emptyFillGate) {
    return { label: 'empty', confidence: emptyScore };
  }

  if (centerFill >= params.circlePreferCenterFill && fill >= params.circlePreferFill && diagScore <= params.circlePreferDiagMax && circleScore >= params.circlePreferScoreMin) {
    return { label: 'circle', confidence: clamp(circleScore + 0.08, 0, 1) };
  }

  if (circleScore >= crossScore + params.circleDiffMin && circleScore >= params.circleScoreMin) {
    return { label: 'circle', confidence: circleScore };
  }

  if (crossScore >= circleScore + params.crossDiffMin && crossScore >= params.crossScoreMin) {
    return { label: 'cross', confidence: crossScore };
  }

  if (centerFill >= params.circleFallbackCenter && diagScore <= params.circleFallbackDiagMax && circleScore >= params.circleFallbackScoreMin) {
    return { label: 'circle', confidence: clamp(circleScore * 0.9 + 0.04, 0, 1) };
  }

  return { label: 'unknown', confidence: Math.max(circleScore, crossScore) * 0.7 };
}

exports.main = async (event) => {
  try {
    const patches = Array.isArray(event.patches) ? event.patches : [];
    const patchSize = Number(event.patchSize || PATCH_SIZE_DEFAULT);

    if (!patches.length) {
      return { success: false, message: 'patches required' };
    }

    const params = {
      ...DEFAULT_PARAMS,
      ...(event.params || {}),
    };

    const labels = [];
    const confidences = [];

    for (let i = 0; i < patches.length; i++) {
      const p = decodePatch(patches[i], patchSize);
      if (!p) {
        labels.push('unknown');
        confidences.push(0);
        continue;
      }
      const cls = classifyPatch(p, patchSize, params);
      labels.push(cls.label);
      confidences.push(Number(cls.confidence.toFixed(4)));
    }

    return {
      success: true,
      result: {
        labels,
        confidences,
        paramsUsed: params,
      },
    };
  } catch (err) {
    return { success: false, message: err.message || 'shape classify failed' };
  }
};
