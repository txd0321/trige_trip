from fastapi import FastAPI
from pydantic import BaseModel
import base64
import time
from typing import List
import cv2
import numpy as np

app = FastAPI()

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

class RoiResponse(BaseModel):
    slots: List[str]
    confidence: float
    latencyMs: int
    debug: dict | None = None


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


def split_segments(img: np.ndarray, segments: int = 5) -> List[np.ndarray]:
    h = img.shape[0]
    seg_h = h // segments
    parts = []
    for i in range(segments):
        y0 = i * seg_h
        y1 = h if i == segments - 1 else (i + 1) * seg_h
        parts.append(img[y0:y1, :])
    return parts


def find_dynamic_boxes(gray: np.ndarray, segments: int = 5) -> tuple[list[tuple[int, int, int, int]], str]:
    h, w = gray.shape[:2]
    if h == 0 or w == 0:
        return [], "empty"

    edge = cv2.Canny(gray, 40, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edge = cv2.morphologyEx(edge, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(edge, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return [], "no_contour"

    min_area = max(80, int(h * w * 0.002))
    candidates = []
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        area = cw * ch
        if area < min_area:
            continue
        ratio = ch / max(1, cw)
        if ratio < 0.25 or ratio > 4.0:
            continue
        candidates.append((x, y, cw, ch, area))

    if len(candidates) < segments:
        return [], "too_few"

    candidates.sort(key=lambda v: v[4], reverse=True)
    candidates = candidates[: max(segments * 2, 8)]
    candidates.sort(key=lambda v: v[1] + v[3] * 0.5)

    if len(candidates) > segments:
        idxs = np.linspace(0, len(candidates) - 1, segments).astype(int)
        chosen = [candidates[i] for i in idxs]
    else:
        chosen = candidates

    boxes = [(x, y, cw, ch) for (x, y, cw, ch, _area) in chosen]
    return boxes, "dynamic"


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


def classify_segment(seg: np.ndarray, canny_low: int, canny_high: int, edge_ratio_empty: float, match_threshold: float) -> tuple[str, float]:
    patch = normalize_patch(seg)
    edge = cv2.Canny(patch, canny_low, canny_high)
    edge_ratio = float(np.count_nonzero(edge)) / float(edge.size)
    if edge_ratio < edge_ratio_empty:
        return "empty", 0.8
    label, conf = match_template(edge, match_threshold)
    return label, conf


@app.post("/api/vision/roi", response_model=RoiResponse)
def detect_roi(payload: RoiRequest):
    start = time.time()
    gray = decode_image(payload.imageBase64, payload.roiWidth, payload.roiHeight)
    if gray is None:
        return {"slots": ["unknown"] * 5, "confidence": 0.0, "latencyMs": 0}

    gray = preprocess(gray)

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

    boxes, box_mode = find_dynamic_boxes(gray, 5)
    if boxes:
        segments = []
        for (x, y, bw, bh) in boxes:
            y0 = max(0, y)
            y1 = min(h, y + bh)
            x0 = max(0, x)
            x1 = min(w, x + bw)
            segments.append(gray[y0:y1, x0:x1])
    else:
        segments = split_segments(gray, 5)

    labels = []
    confs = []
    edge_ratios = []
    mean_intensity = []
    match_scores = []
    for seg in segments:
        mean_intensity.append(float(np.mean(seg)) if seg.size else 0.0)
        edge = cv2.Canny(seg, canny_low, canny_high)
        edge_ratio = float(np.count_nonzero(edge)) / float(edge.size or 1)
        edge_ratios.append(edge_ratio)
        if edge_ratio < edge_ratio_empty:
            labels.append("empty")
            confs.append(0.2)
            match_scores.append(0.0)
            continue

        patch = normalize_patch(edge)
        label, conf = match_template(patch, match_threshold)
        labels.append(label)
        confs.append(conf)
        match_scores.append(conf)

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
    }
    return {"slots": labels, "confidence": confidence, "latencyMs": latency_ms, "debug": debug}
