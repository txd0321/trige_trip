from fastapi import FastAPI
from pydantic import BaseModel
import base64
import time
from typing import List
import cv2
import numpy as np

# =====================
# App / 基础依赖
# =====================
app = FastAPI()

# =====================
# API 请求/响应模型
# =====================
class RoiRequest(BaseModel):
    imageBase64: str
    roiWidth: int | None = None
    roiHeight: int | None = None
    cannyLow: int | None = None
    cannyHigh: int | None = None
    edgeRatioEmpty: float | None = None
    matchThreshold: float | None = None
    seq: int | None = None
    timestamp: int | None = None

class ShapeItem(BaseModel):
    label: str
    y: float
    x: float | None = None
    yNorm: float | None = None
    xNorm: float | None = None
    inRoi: bool | None = None
    confidence: float | None = None


class RoiResponse(BaseModel):
    slots: List[str]
    confidence: float
    latencyMs: int
    items: List[ShapeItem] | None = None
    debug: dict | None = None


# =====================
# 图像解码与预处理
# =====================
def decode_image(image_base64: str, width: int | None, height: int | None) -> np.ndarray:
    data = base64.b64decode(image_base64)
    arr = np.frombuffer(data, dtype=np.uint8)
    decoded = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if decoded is not None:
        return decoded
    if width and height and arr.size == width * height:
        return arr.reshape((height, width))
    return None


def preprocess(gray: np.ndarray) -> np.ndarray:
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    return gray


def auto_adjust(gray: np.ndarray) -> np.ndarray:
    if gray.size == 0:
        return gray
    min_val, max_val = np.percentile(gray, (2, 98))
    if max_val - min_val < 5:
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
def find_dynamic_boxes(gray: np.ndarray, segments: int = 5) -> tuple[list[tuple[int, int, int, int]], str, dict]:
    h, w = gray.shape[:2]
    if h == 0 or w == 0:
        return [], "empty", {"candidateCount": 0, "filteredByArea": 0, "filteredByRatio": 0, "edgeMean": 0.0}

    edge = cv2.Canny(gray, 40, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edge = cv2.morphologyEx(edge, cv2.MORPH_CLOSE, kernel, iterations=2)

    edge_vals = edge.astype(np.float32) / 255.0
    edge_mean = float(np.mean(edge_vals))
    edge_std = float(np.std(edge_vals))

    contours, _ = cv2.findContours(edge, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return [], "no_contour", {"candidateCount": 0, "filteredByArea": 0, "filteredByRatio": 0, "edgeMean": edge_mean}

    min_area = max(60, int(h * w * 0.0012))
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
        "contours": contour_debug,
    }

    if len(candidates) < segments:
        return [(x, y, cw, ch) for (x, y, cw, ch, _area) in candidates], "too_few", diag

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


TEMPLATES = build_templates()


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
        return "empty", 0.8

    circle_score = detect_circle(edge)
    cross_score = detect_cross(edge)
    contour_circle, contour_cross = contour_shape_score(edge)

    circle_score = max(circle_score, contour_circle)
    cross_score = max(cross_score, contour_cross)

    if circle_score >= 0.7 or cross_score >= 0.7:
        if circle_score >= cross_score:
            return "circle", circle_score
        return "cross", cross_score

    label, conf = match_template(edge, match_threshold)
    return label, conf


# =====================
# API 接口：ROI 识别
# =====================
@app.post("/api/vision/roi", response_model=RoiResponse)
def detect_roi(payload: RoiRequest):
    start = time.time()
    gray = decode_image(payload.imageBase64, payload.roiWidth, payload.roiHeight)
    if gray is None:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}

    gray = preprocess(gray)
    gray = auto_adjust(gray)
    gray = adaptive_threshold(gray)

    roi_mean = float(np.mean(gray)) if gray.size else 0.0
    roi_std = float(np.std(gray)) if gray.size else 0.0

    h, w = gray.shape[:2]
    if h > 0 and w > 0:
        pad = int(min(h, w) * 0.04)
        gray[:pad, :] = 0
        gray[-pad:, :] = 0
        gray[:, :pad] = 0
        gray[:, -pad:] = 0

    canny_low = int(payload.cannyLow or 40)
    canny_high = int(payload.cannyHigh or 120)
    edge_ratio_empty = float(payload.edgeRatioEmpty or 0.015)
    match_threshold = float(payload.matchThreshold or 0.32)

    boxes, box_mode, box_diag = find_dynamic_boxes(gray, 5)
    if not boxes:
        debug = {"boxMode": box_mode, "diagnostic": {**box_diag, "boxMode": box_mode}}
        return {"slots": [], "confidence": 0.0, "latencyMs": 0, "items": [], "debug": debug}

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
        else:
            seg_h = h / max(1, len(segments))
            cx = float(w * 0.5)
            cy = float((idx + 0.5) * seg_h)

        items.append(
            {
                "label": labels[-1],
                "y": cy,
                "x": cx,
                "yNorm": float(cy / max(1.0, h)),
                "xNorm": float(cx / max(1.0, w)),
                "inRoi": 0 <= cx <= w and 0 <= cy <= h,
                "confidence": float(confs[-1]),
            }
        )

    confidence = float(sum(confs) / max(1, len(confs)))
    latency_ms = int((time.time() - start) * 1000)
    debug = {
        "edgeRatios": edge_ratios,
        "meanIntensity": mean_intensity,
        "canny": [canny_low, canny_high],
        "edgeRatioEmpty": edge_ratio_empty,
        "matchThreshold": match_threshold,
        "matchScores": match_scores,
        "boxMode": box_mode,
        "boxCount": len(boxes),
        "roiMean": roi_mean,
        "roiStd": roi_std,
        "sortedY": sorted([float(item.get("y", 0)) for item in items]) if items else [],
        "diagnostic": {**box_diag, "boxMode": box_mode},
    }
    return {"slots": labels, "confidence": confidence, "latencyMs": latency_ms, "items": items, "debug": debug}
