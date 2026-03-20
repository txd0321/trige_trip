from fastapi import FastAPI
from pydantic import BaseModel
import base64
import time
from typing import List, Optional, Dict
import os
import numpy as np

MOCK_MODE = os.getenv("XR_MOCK_MODE", "0") == "1"
USE_PATTERN_CLASSIFIER = os.getenv("XR_USE_PATTERN_CLASSIFIER", "1") == "1"

# 6 组模式（整组分类）映射到 circle 索引（从上到下 0~4）
# pattern_all_cross 表示无圆
PATTERN_TO_CIRCLE_IDX = {
    "pattern_circle_1": 0,
    "pattern_circle_2": 1,
    "pattern_circle_3": 2,
    "pattern_circle_4": 3,
    "pattern_circle_5": 4,
    "pattern_all_cross": -1,
}
PATTERN_LABELS = [
    "pattern_circle_1",
    "pattern_circle_2",
    "pattern_circle_3",
    "pattern_circle_4",
    "pattern_circle_5",
    "pattern_all_cross",
]

if not MOCK_MODE:
    import cv2
    cv2.setNumThreads(1)
    try:
        cv2.setNumThreads(1)
        cv2.ocl.setUseOpenCL(False)
    except Exception:
        pass
else:
    cv2 = None

# =====================
# App / 基础依赖
# =====================
app = FastAPI()

# =====================
# API 请求/响应模型
# =====================
class RoiRequest(BaseModel):
    imageBase64: str
    imageWidth: Optional[int] = None
    imageHeight: Optional[int] = None
    roiXRatio: Optional[float] = None
    roiYRatio: Optional[float] = None
    roiWRatio: Optional[float] = None
    roiHRatio: Optional[float] = None
    roiWidth: Optional[int] = None
    roiHeight: Optional[int] = None
    cannyLow: Optional[int] = None
    cannyHigh: Optional[int] = None
    edgeRatioEmpty: Optional[float] = None
    matchThreshold: Optional[float] = None
    seq: Optional[int] = None
    timestamp: Optional[int] = None

class ShapeItem(BaseModel):
    label: str
    y: float
    x: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    yNorm: Optional[float] = None
    xNorm: Optional[float] = None
    inRoi: Optional[bool] = None
    confidence: Optional[float] = None


class RoiResponse(BaseModel):
    slots: List[str]
    confidence: float
    latencyMs: int
    items: Optional[List[ShapeItem]] = None
    patternLabel: Optional[str] = None
    patternScore: Optional[float] = None
    debug: Optional[Dict] = None


# =====================
# 图像解码与预处理
# =====================
def decode_image(image_base64: str, width: Optional[int], height: Optional[int]) -> np.ndarray:
    if not image_base64:
        return None
    payload = image_base64
    if "base64," in payload:
        payload = payload.split("base64,", 1)[-1]
    try:
        data = base64.b64decode(payload, validate=False)
    except Exception:
        return None
    if not data:
        return None
    arr = np.frombuffer(data, dtype=np.uint8)
    if arr.size == 0:
        return None
    decoded = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if decoded is not None and decoded.size > 0:
        return decoded
    if width and height and width > 0 and height > 0:
        expected = width * height
        if arr.size == expected:
            return arr.reshape((height, width))
        if arr.size > expected and arr.size <= expected * 4:
            return arr[:expected].reshape((height, width))
    return None


def encode_debug_image(gray: np.ndarray, max_size: int = 160) -> str:
    if gray is None or gray.size == 0:
        return ""
    h, w = gray.shape[:2]
    scale = min(1.0, max_size / max(h, w))
    if scale < 1.0:
        gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode('.jpg', gray, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    if not ok:
        return ""
    return base64.b64encode(buf.tobytes()).decode('utf-8')


def infer_pattern_group(gray_roi: np.ndarray) -> (str, float, List[float]):
    """
    占位版整组 6 分类（后续替换为真实模型推理）。
    类别：circle_1~circle_5 + all_cross
    """
    if gray_roi is None or gray_roi.size == 0:
        return "pattern_circle_5", 0.0, [0.0] * len(PATTERN_LABELS)

    h, w = gray_roi.shape[:2]
    if h <= 0 or w <= 0:
        return "pattern_circle_5", 0.0, [0.0] * len(PATTERN_LABELS)

    seg_h = max(1, h // 5)
    vals = []
    for i in range(5):
        y0 = i * seg_h
        y1 = h if i == 4 else min(h, (i + 1) * seg_h)
        patch = gray_roi[y0:y1, :]
        vals.append(float(np.mean(patch)) if patch.size else 0.0)

    std_v = float(np.std(vals))
    if std_v < 3.0:
        label = "pattern_all_cross"
        probs = [0.04] * len(PATTERN_LABELS)
        probs[PATTERN_LABELS.index("pattern_all_cross")] = 0.80
        return label, 0.80, [float(p) for p in probs]

    dark_idx = int(np.argmin(vals))
    label = f"pattern_circle_{dark_idx + 1}"
    probs = [0.04] * len(PATTERN_LABELS)
    probs[PATTERN_LABELS.index(label)] = 0.80
    return label, 0.80, [float(p) for p in probs]


def preprocess(gray: np.ndarray) -> np.ndarray:
    clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    gray = cv2.addWeighted(gray, 1.4, blur, -0.4, 0)
    return gray


def auto_adjust(gray: np.ndarray) -> np.ndarray:
    if gray.size == 0:
        return gray
    min_val, max_val = np.percentile(gray, (1, 99))
    if max_val - min_val < 3:
        return gray
    scaled = np.clip((gray - min_val) * (255.0 / (max_val - min_val)), 0, 255)
    return scaled.astype(np.uint8)


def adaptive_threshold(gray: np.ndarray) -> np.ndarray:
    if gray.size == 0:
        return gray
    block_size = 21 if min(gray.shape[:2]) >= 21 else 11
    if block_size % 2 == 0:
        block_size += 1
    return cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        block_size,
        5,
    )


# =====================
# ROI 候选框检测（严格 y 轴识别）
# =====================
def find_dynamic_boxes(gray: np.ndarray, segments: int = 5, canny_low: int = 40, canny_high: int = 120) -> tuple[list[tuple[int, int, int, int]], str, dict]:
    h, w = gray.shape[:2]
    if h == 0 or w == 0:
        return [], "empty", {"candidateCount": 0, "filteredByArea": 0, "filteredByRatio": 0, "edgeMean": 0.0}

    edge_src = cv2.medianBlur(gray, 3)
    edge = cv2.Canny(edge_src, canny_low, canny_high)
    if np.count_nonzero(edge) == 0:
        low_boost = cv2.Canny(edge_src, 5, 20)
        if np.count_nonzero(low_boost) == 0:
            gmin = int(np.min(edge_src)) if edge_src.size else 0
            gmax = int(np.max(edge_src)) if edge_src.size else 0
            if gmax > gmin:
                boosted = ((edge_src.astype(np.float32) - gmin) * (255.0 / (gmax - gmin))).astype(np.uint8)
                low_boost = cv2.Canny(boosted, 5, 20)
                if np.count_nonzero(low_boost) == 0:
                    low_boost = cv2.Laplacian(boosted, cv2.CV_8U, ksize=3)
            else:
                low_boost = cv2.Laplacian(edge_src, cv2.CV_8U, ksize=3)
        edge = low_boost

    # 先轻去噪，避免整块连通导致 overflow
    kernel_open = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    edge = cv2.morphologyEx(edge, cv2.MORPH_OPEN, kernel_open, iterations=1)

    edge_vals = edge.astype(np.float32) / 255.0
    edge_mean = float(np.mean(edge_vals))
    edge_std = float(np.std(edge_vals))
    edge_pixel_count = int(np.count_nonzero(edge))

    # 边缘过密时自动抬高阈值重跑一次
    if edge_pixel_count > int(h * w * 0.45):
        strict_low = max(35, canny_low + 25)
        strict_high = max(strict_low + 30, canny_high + 60)
        edge_strict = cv2.Canny(edge_src, strict_low, strict_high)
        edge_strict = cv2.morphologyEx(edge_strict, cv2.MORPH_OPEN, kernel_open, iterations=1)
        strict_count = int(np.count_nonzero(edge_strict))
        if strict_count < edge_pixel_count:
            edge = edge_strict
            edge_vals = edge.astype(np.float32) / 255.0
            edge_mean = float(np.mean(edge_vals))
            edge_std = float(np.std(edge_vals))
            edge_pixel_count = strict_count

    if edge_pixel_count > int(h * w * 0.60):
        return [], "edge_overflow", {
            "candidateCount": 0,
            "filteredByArea": 0,
            "filteredByRatio": 0,
            "edgeMean": edge_mean,
            "edgeStd": edge_std,
            "edgePixelCount": edge_pixel_count,
            "contours": [],
        }

    contours, _ = cv2.findContours(edge, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours and edge_pixel_count == 0:
        grad_x = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)
        grad_y = cv2.Sobel(gray, cv2.CV_16S, 0, 1, ksize=3)
        abs_x = cv2.convertScaleAbs(grad_x)
        abs_y = cv2.convertScaleAbs(grad_y)
        edge = cv2.addWeighted(abs_x, 0.5, abs_y, 0.5, 0)
        _, edge = cv2.threshold(edge, 12, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(edge, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        edge_vals = edge.astype(np.float32) / 255.0
        edge_mean = float(np.mean(edge_vals))
        edge_std = float(np.std(edge_vals))
        edge_pixel_count = int(np.count_nonzero(edge))

    if not contours:
        return [], "no_contour", {
            "candidateCount": 0,
            "filteredByArea": 0,
            "filteredByRatio": 0,
            "edgeMean": edge_mean,
            "edgeStd": edge_std,
            "edgePixelCount": edge_pixel_count,
            "contours": [],
        }

    min_area = max(20, int(h * w * 0.00045))
    candidates = []
    filtered_by_area = 0
    filtered_by_ratio = 0
    contour_debug = []

    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        area = cw * ch
        ratio = ch / max(1, cw)
        status = "kept"
        if area < min_area:
            filtered_by_area += 1
            status = "area"
        elif ratio < 0.2 or ratio > 5.0:
            filtered_by_ratio += 1
            status = "ratio"
        else:
            candidates.append((x, y, cw, ch, area))

        contour_debug.append(
            {
                "x": int(x),
                "y": int(y),
                "w": int(cw),
                "h": int(ch),
                "area": int(area),
                "ratio": float(ratio),
                "status": status,
            }
        )

    diag = {
        "candidateCount": len(candidates),
        "filteredByArea": filtered_by_area,
        "filteredByRatio": filtered_by_ratio,
        "edgeMean": edge_mean,
        "edgeStd": edge_std,
        "edgePixelCount": edge_pixel_count,
        "canny": [int(canny_low), int(canny_high)],
        "contours": contour_debug,
    }

    if len(candidates) < segments:
        return [(x, y, cw, ch) for (x, y, cw, ch, _area) in candidates], "too_few", diag

    if len(candidates) > segments:
        avg_h = float(np.mean([c[3] for c in candidates])) if candidates else 0.0
        avg_w = float(np.mean([c[2] for c in candidates])) if candidates else 0.0
        candidates = [c for c in candidates if c[3] >= avg_h * 0.45 and c[2] >= avg_w * 0.45]

    candidates.sort(key=lambda v: v[4], reverse=True)
    candidates = candidates[: max(segments * 2, 8)]
    candidates.sort(key=lambda v: v[1] + v[3] * 0.5)

    if len(candidates) > segments:
        idxs = np.linspace(0, len(candidates) - 1, segments).astype(int)
        chosen = [candidates[i] for i in idxs]
    else:
        chosen = candidates

    boxes = [(x, y, cw, ch) for (x, y, cw, ch, _area) in chosen]
    return boxes, "dynamic", diag


# =====================
# 模板与几何特征识别
# =====================
def normalize_patch(patch: np.ndarray, size: int = 64) -> np.ndarray:
    h, w = patch.shape[:2]
    if h == 0 or w == 0:
        return np.zeros((size, size), dtype=np.uint8)
    return cv2.resize(patch, (size, size), interpolation=cv2.INTER_AREA)


def build_templates(size: int = 64) -> dict:
    circle = np.zeros((size, size), dtype=np.uint8)
    cv2.circle(circle, (size // 2, size // 2), size // 3, 255, 4)
    cross = np.zeros((size, size), dtype=np.uint8)
    cv2.line(cross, (size // 4, size // 4), (size * 3 // 4, size * 3 // 4), 255, 4)
    cv2.line(cross, (size * 3 // 4, size // 4), (size // 4, size * 3 // 4), 255, 4)
    circle_edge = cv2.Canny(circle, 50, 150)
    cross_edge = cv2.Canny(cross, 50, 150)
    return {"circle": circle_edge, "cross": cross_edge}


TEMPLATES = build_templates() if cv2 is not None else {}


def match_template(patch: np.ndarray, match_threshold: float) -> tuple[str, float]:
    scores = {}
    for name, tmpl in TEMPLATES.items():
        res = cv2.matchTemplate(patch, tmpl, cv2.TM_CCOEFF_NORMED)
        scores[name] = float(res[0][0])
    best = max(scores.items(), key=lambda x: x[1])
    if best[1] < match_threshold:
        return "empty", best[1]
    return best[0], best[1]


def detect_circle(edge: np.ndarray) -> float:
    h, w = edge.shape[:2]
    if h == 0 or w == 0:
        return 0.0
    blur = cv2.GaussianBlur(edge, (5, 5), 0)
    min_radius = max(6, int(min(h, w) * 0.18))
    max_radius = max(min_radius + 2, int(min(h, w) * 0.45))
    circles = cv2.HoughCircles(
        blur,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=min(h, w) * 0.3,
        param1=100,
        param2=18,
        minRadius=min_radius,
        maxRadius=max_radius,
    )
    if circles is None:
        return 0.0
    return min(1.0, len(circles[0]) / 2.0 + 0.4)


def detect_cross(edge: np.ndarray) -> float:
    h, w = edge.shape[:2]
    if h == 0 or w == 0:
        return 0.0
    lines = cv2.HoughLinesP(edge, 1, np.pi / 180, threshold=40, minLineLength=min(h, w) * 0.35, maxLineGap=6)
    if lines is None:
        return 0.0
    diag_count = 0
    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
        angle = angle if angle <= 180 else angle - 180
        if 20 < angle < 70 or 110 < angle < 160:
            diag_count += 1
    if diag_count >= 2:
        return min(1.0, 0.6 + diag_count * 0.1)
    return 0.0


def contour_shape_score(edge: np.ndarray) -> tuple[float, float]:
    contours, _ = cv2.findContours(edge, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.0, 0.0

    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    best = contours[0]
    area = cv2.contourArea(best)
    if area <= 0:
        return 0.0, 0.0

    peri = cv2.arcLength(best, True)
    if peri <= 0:
        return 0.0, 0.0

    circularity = 4 * np.pi * area / (peri * peri)
    circle_score = float(np.clip((circularity - 0.45) / 0.45, 0, 1))

    hull = cv2.convexHull(best)
    hull_area = cv2.contourArea(hull) if hull is not None else area
    solidity = float(area / max(hull_area, 1.0))
    cross_score = float(np.clip((0.85 - solidity) / 0.5, 0, 1))

    return circle_score, cross_score


def classify_segment(seg: np.ndarray, canny_low: int, canny_high: int, edge_ratio_empty: float, match_threshold: float) -> tuple[str, float]:
    patch = normalize_patch(seg)
    edge = cv2.Canny(patch, canny_low, canny_high)
    edge_ratio = float(np.count_nonzero(edge)) / float(edge.size)

    if edge_ratio < edge_ratio_empty:
        boosted = auto_adjust(preprocess(patch))
        edge = cv2.Canny(boosted, max(3, canny_low // 2), max(10, canny_high // 2))
        edge_ratio = float(np.count_nonzero(edge)) / float(edge.size)
        if edge_ratio < edge_ratio_empty * 0.6:
            return "empty", 0.82

    circle_score = detect_circle(edge)
    cross_score = detect_cross(edge)
    contour_circle, contour_cross = contour_shape_score(edge)

    circle_score = max(circle_score, contour_circle)
    cross_score = max(cross_score, contour_cross)

    if circle_score >= 0.62 or cross_score >= 0.62:
        if circle_score >= cross_score:
            return "circle", circle_score
        return "cross", cross_score

    label, conf = match_template(edge, max(0.2, match_threshold - 0.08))
    return label, conf


# =====================
# API 接口：ROI 识别
# =====================
@app.post("/api/vision/roi", response_model=RoiResponse)
def detect_roi(payload: RoiRequest):
    start = time.time()
    if MOCK_MODE:
        latency_ms = int((time.time() - start) * 1000)
        mock_items = [
            {"label": "circle", "x": 40.0, "y": 40.0, "w": 30.0, "h": 30.0, "confidence": 0.9},
            {"label": "cross", "x": 40.0, "y": 110.0, "w": 30.0, "h": 30.0, "confidence": 0.9},
            {"label": "cross", "x": 40.0, "y": 180.0, "w": 30.0, "h": 30.0, "confidence": 0.9},
            {"label": "cross", "x": 40.0, "y": 250.0, "w": 30.0, "h": 30.0, "confidence": 0.9},
            {"label": "cross", "x": 40.0, "y": 320.0, "w": 30.0, "h": 30.0, "confidence": 0.9},
        ]
        return {
            "slots": [item["label"] for item in mock_items],
            "confidence": 0.9,
            "latencyMs": latency_ms,
            "items": mock_items,
            "debug": {"mock": True, "debugImages": {}},
        }
    if not payload or not payload.imageBase64:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}
    if payload.imageWidth is not None and payload.imageWidth <= 0:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}
    if payload.imageHeight is not None and payload.imageHeight <= 0:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}

    frame_gray = decode_image(payload.imageBase64, payload.imageWidth, payload.imageHeight)
    if frame_gray is None or frame_gray.size == 0:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}

    frame_h, frame_w = frame_gray.shape[:2]
    ratio_x = float(payload.roiXRatio or 0)
    ratio_y = float(payload.roiYRatio or 0)
    ratio_w = float(payload.roiWRatio or 1)
    ratio_h = float(payload.roiHRatio or 1)
    roi_x = max(0, min(frame_w - 1, int(ratio_x * frame_w)))
    roi_y = max(0, min(frame_h - 1, int(ratio_y * frame_h)))
    roi_w = max(10, min(frame_w - roi_x, int(ratio_w * frame_w)))
    roi_h = max(60, min(frame_h - roi_y, int(ratio_h * frame_h)))

    gray = frame_gray[roi_y:roi_y + roi_h, roi_x:roi_x + roi_w]
    if gray is None or gray.size == 0:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}

    raw_gray = gray.copy()
    gray = preprocess(gray)
    if gray is None or gray.size == 0:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}
    adj_gray = auto_adjust(gray)
    if adj_gray is None or adj_gray.size == 0:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}
    edge_gray = adj_gray.copy()
    roi_mean_raw = float(np.mean(raw_gray)) if raw_gray.size else 0.0
    roi_std_raw = float(np.std(raw_gray)) if raw_gray.size else 0.0
    roi_mean_adj = float(np.mean(edge_gray)) if edge_gray.size else 0.0
    roi_std_adj = float(np.std(edge_gray)) if edge_gray.size else 0.0
    gray = adaptive_threshold(adj_gray)
    if gray is None or gray.size == 0:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}

    h, w = edge_gray.shape[:2]
    if h <= 0 or w <= 0:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}
    if h > 0 and w > 0:
        pad = int(min(h, w) * 0.04)
        edge_gray[:pad, :] = 0
        edge_gray[-pad:, :] = 0
        edge_gray[:, :pad] = 0
        edge_gray[:, -pad:] = 0

    canny_low = int(payload.cannyLow or 40)
    canny_high = int(payload.cannyHigh or 120)
    edge_ratio_empty = float(payload.edgeRatioEmpty or 0.015)
    match_threshold = float(payload.matchThreshold or 0.32)

    # 整组 5 分类模式（阶段一：占位推理，后续替换为真实模型）
    if USE_PATTERN_CLASSIFIER:
        pattern_label, pattern_score, pattern_probs = infer_pattern_group(adj_gray)
        circle_idx = PATTERN_TO_CIRCLE_IDX.get(pattern_label, 4)
        labels = ["cross"] * 5
        if 0 <= circle_idx < 5:
            labels[circle_idx] = "circle"
        h5, w5 = adj_gray.shape[:2]
        seg_h = max(8, h5 // 5)
        items = []
        for i in range(5):
            y0 = i * seg_h
            y1 = h5 if i == 4 else min(h5, (i + 1) * seg_h)
            hh = max(8, y1 - y0)
            ww = max(10, int(w5 * 0.84))
            xx = max(0, int((w5 - ww) * 0.5))
            cx = float(xx + ww * 0.5)
            cy = float(y0 + hh * 0.5)
            conf_i = float(pattern_score if i == circle_idx else max(0.55, pattern_score - 0.1))
            items.append(
                {
                    "label": labels[i],
                    "y": cy,
                    "x": cx,
                    "w": float(ww),
                    "h": float(hh),
                    "yNorm": float(cy / max(1.0, h5)),
                    "xNorm": float(cx / max(1.0, w5)),
                    "inRoi": True,
                    "confidence": conf_i,
                }
            )

        confidence = float(sum([float(it["confidence"]) for it in items]) / max(1, len(items)))
        latency_ms = int((time.time() - start) * 1000)
        debug = {
            "mode": "pattern_classifier",
            "patternLabel": pattern_label,
            "patternScore": float(pattern_score),
            "patternProbs": pattern_probs,
            "canny": [canny_low, canny_high],
            "edgeRatioEmpty": edge_ratio_empty,
            "matchThreshold": match_threshold,
            "roiShape": {"width": int(w5), "height": int(h5)},
            "roiMeanRaw": roi_mean_raw,
            "roiStdRaw": roi_std_raw,
            "roiMeanAdj": roi_mean_adj,
            "roiStdAdj": roi_std_adj,
            "sortedY": sorted([float(item.get("y", 0)) for item in items]) if items else [],
            "debugImages": {},
        }
        return {
            "slots": labels,
            "confidence": confidence,
            "latencyMs": latency_ms,
            "items": items,
            "patternLabel": pattern_label,
            "patternScore": float(pattern_score),
            "debug": debug,
        }

    boxes, box_mode, box_diag = find_dynamic_boxes(edge_gray, 5, canny_low, canny_high)
    if not boxes:
        # 固定 5 槽位兜底：适配「4叉1圆」纵向排列场景
        margin_x = max(2, int(w * 0.08))
        inner_w = max(10, w - margin_x * 2)
        seg_h = max(8, h // 5)
        fallback_boxes = []
        for i in range(5):
            y0 = i * seg_h
            y1 = h if i == 4 else min(h, (i + 1) * seg_h)
            hh = max(8, y1 - y0)
            fallback_boxes.append((margin_x, y0, inner_w, hh))
        boxes = fallback_boxes
        box_mode = f"{box_mode}_fallback5"

    # 槽位内二次定位：在每个槽位里找最大连通域，尽量贴近真实图形
    refined_boxes = []
    for (x, y, bw, bh) in boxes:
        y0 = max(0, y)
        y1 = min(h, y + bh)
        x0 = max(0, x)
        x1 = min(w, x + bw)
        patch_edge = edge_gray[y0:y1, x0:x1]
        rx, ry, rw, rh = x0, y0, max(2, x1 - x0), max(2, y1 - y0)
        if patch_edge is not None and patch_edge.size > 0:
            cnts, _ = cv2.findContours(patch_edge, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if cnts:
                cnts = sorted(cnts, key=cv2.contourArea, reverse=True)
                best = cnts[0]
                area = cv2.contourArea(best)
                if area >= 6:
                    bx, by, bw2, bh2 = cv2.boundingRect(best)
                    pad = 2
                    rx = max(0, x0 + bx - pad)
                    ry = max(0, y0 + by - pad)
                    rw = min(w - rx, bw2 + pad * 2)
                    rh = min(h - ry, bh2 + pad * 2)
        refined_boxes.append((int(rx), int(ry), int(max(2, rw)), int(max(2, rh))))

    boxes = refined_boxes

    segments = []
    for (x, y, bw, bh) in boxes:
        y0 = max(0, y)
        y1 = min(h, y + bh)
        x0 = max(0, x)
        x1 = min(w, x + bw)
        segments.append(gray[y0:y1, x0:x1])

    labels = []
    confs = []
    edge_ratios = []
    mean_intensity = []
    match_scores = []
    items = []

    for idx, seg in enumerate(segments):
        mean_intensity.append(float(np.mean(seg)) if seg.size else 0.0)
        edge = cv2.Canny(seg, canny_low, canny_high)
        edge_ratio = float(np.count_nonzero(edge)) / float(edge.size or 1)
        edge_ratios.append(edge_ratio)
        if edge_ratio < edge_ratio_empty:
            labels.append("empty")
            confs.append(0.2)
            match_scores.append(0.0)
        else:
            label, conf = classify_segment(seg, canny_low, canny_high, edge_ratio_empty, match_threshold)
            labels.append(label)
            confs.append(conf)
            match_scores.append(conf)

        if boxes and idx < len(boxes):
            x, y, bw, bh = boxes[idx]
            cx = float(x + bw * 0.5)
            cy = float(y + bh * 0.5)
            item_w = float(bw)
            item_h = float(bh)
        else:
            seg_h = h / max(1, len(segments))
            cx = float(w * 0.5)
            cy = float((idx + 0.5) * seg_h)
            item_w = float(w * 0.6)
            item_h = float(seg_h * 0.8)

        items.append(
            {
                "label": labels[-1],
                "y": cy,
                "x": cx,
                "w": item_w,
                "h": item_h,
                "yNorm": float(cy / max(1.0, h)),
                "xNorm": float(cx / max(1.0, w)),
                "inRoi": 0 <= cx <= w and 0 <= cy <= h,
                "confidence": float(confs[-1]),
            }
        )

    # 业务先验：一组固定为 4 叉 + 1 圆（按槽位仅保留一个 circle）
    prior_applied = False
    prior_circle_idx = -1
    prior_circle_scores = []
    if len(labels) == 5:
        prior_applied = True
        circle_scores = []
        for i, seg in enumerate(segments):
            patch = normalize_patch(seg)
            edge = cv2.Canny(patch, canny_low, canny_high)
            circle_like = detect_circle(edge)
            contour_like = contour_shape_score(edge)[0]
            cs = max(circle_like, contour_like)
            # 边缘过低时降低得分，防止噪点当圆
            if i < len(edge_ratios):
                cs *= min(1.0, max(0.0, edge_ratios[i] / 0.04))
            # 槽位面积过小也降权
            if i < len(boxes):
                _, _, bw_i, bh_i = boxes[i]
                area_norm = float((bw_i * bh_i) / max(1, w * h))
                cs *= min(1.0, max(0.0, area_norm / 0.04))
            circle_scores.append(float(cs))

        # 业务强先验：默认最后一位（底部）更可能是圆（与你当前序列一致）
        if len(circle_scores) == 5:
            circle_scores[4] *= 1.30
            circle_scores[0] *= 0.82

        best_idx = int(np.argmax(circle_scores)) if circle_scores else 4

        # 保护：若第一位分数略高但第五位接近，则优先第五位
        if len(circle_scores) == 5 and best_idx == 0:
            if circle_scores[4] >= circle_scores[0] * 0.92:
                best_idx = 4

        prior_circle_idx = int(best_idx)
        prior_circle_scores = [float(v) for v in circle_scores]

        # 把圆所在槽位框适度放大，前端可视化更明显
        if 0 <= prior_circle_idx < len(boxes):
            cx, cy, cw, ch = boxes[prior_circle_idx]
            pad_w = max(4, int(cw * 0.20))
            pad_h = max(4, int(ch * 0.20))
            nx = max(0, cx - pad_w)
            ny = max(0, cy - pad_h)
            nw = min(w - nx, cw + pad_w * 2)
            nh = min(h - ny, ch + pad_h * 2)
            boxes[prior_circle_idx] = (int(nx), int(ny), int(max(2, nw)), int(max(2, nh)))
            if prior_circle_idx < len(items):
                items[prior_circle_idx]["x"] = float(nx + nw * 0.5)
                items[prior_circle_idx]["y"] = float(ny + nh * 0.5)
                items[prior_circle_idx]["w"] = float(nw)
                items[prior_circle_idx]["h"] = float(nh)
                items[prior_circle_idx]["xNorm"] = float((nx + nw * 0.5) / max(1.0, w))
                items[prior_circle_idx]["yNorm"] = float((ny + nh * 0.5) / max(1.0, h))

        for i in range(len(labels)):
            if i == best_idx:
                labels[i] = "circle"
                confs[i] = max(confs[i], circle_scores[i], 0.55)
            else:
                labels[i] = "cross"
                confs[i] = max(confs[i], 0.55)
            if i < len(items):
                items[i]["label"] = labels[i]
                items[i]["confidence"] = float(confs[i])

    confidence = float(sum(confs) / max(1, len(confs)))
    latency_ms = int((time.time() - start) * 1000)
    debug = {
        "edgeRatios": edge_ratios,
        "meanIntensity": mean_intensity,
        "canny": [canny_low, canny_high],
        "edgeRatioEmpty": edge_ratio_empty,
        "matchThreshold": match_threshold,
        "matchScores": match_scores,
        "priorApplied": prior_applied,
        "priorCircleIdx": prior_circle_idx,
        "priorCircleScores": prior_circle_scores,
        "boxMode": box_mode,
        "boxCount": len(boxes),
        "roiShape": {"width": int(w), "height": int(h)},
        "roiMeanRaw": roi_mean_raw,
        "roiStdRaw": roi_std_raw,
        "roiMeanAdj": roi_mean_adj,
        "roiStdAdj": roi_std_adj,
        "sortedY": sorted([float(item.get("y", 0)) for item in items]) if items else [],
        "diagnostic": {**box_diag, "boxMode": box_mode},
        "debugImages": {},
    }
    return {"slots": labels, "confidence": confidence, "latencyMs": latency_ms, "items": items, "debug": debug}
