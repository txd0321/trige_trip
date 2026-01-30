/**
 * 核心逻辑：5插槽形状模式识别
 * 规则：从上往下扫描，识别第一个出现的圆形(CIRCLE)对应的音符
 */

const video = document.getElementById('videoInput');
const canvas = document.getElementById('canvasOutput');
const ctx = canvas.getContext('2d');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusElement = document.getElementById('status');

let cap, src, audioCtx, videoStream;
let isProcessing = false;
let lastDetectedPitches = [];

// 🎯 配置项
const ROI_W = 40; // ROI宽度
const TARGET_NOTES = [
    { name: "F5", midi: 77 }, // 插槽 0 (顶)
    { name: "E5", midi: 76 }, // 插槽 1
    { name: "D5", midi: 74 }, // 插槽 2
    { name: "C5", midi: 72 }, // 插槽 3
    { name: "B4", midi: 71 }  // 插槽 4 (底)
];

let PITCH_MAP = [];
let lastTopY = null, lastBottomY = null;

/**
 * OpenCV 加载回调
 */
function onOpenCvLoaded() {
    statusElement.innerHTML = '引擎就绪。请确保在良好的光线下使用圆形与❌标识。';
    startButton.disabled = false;
}

/**
 * 初始化摄像头与音频
 */
async function init() {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        videoStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment" }, 
            audio: false 
        });
        video.srcObject = videoStream;
        video.play();

        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            // 初始映射
            updateGridSlots(null, null, canvas.height);
            
            cap = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
            src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC1);
            
            isProcessing = true;
            startButton.disabled = true;
            stopButton.disabled = false;
            requestAnimationFrame(processFrame);
        };
    } catch (err) {
        statusElement.innerHTML = "错误: " + err.message;
    }
}

/**
 * 更新 5 个插槽的 Y 轴范围
 */
function updateGridSlots(topY, bottomY, canvasHeight) {
    const fTop = topY || 50;
    const fBot = bottomY || canvasHeight - 50;
    const step = (fBot - fTop) / 6;

    PITCH_MAP = TARGET_NOTES.map((note, i) => {
        const midY = fTop + (i + 1) * step;
        return {
            ...note,
            index: i,
            freq: 440 * Math.pow(2, (note.midi - 69) / 12),
            minY: midY - step / 2,
            maxY: midY + step / 2,
            midY: midY
        };
    });
}

/**
 * 绘制并播放音符
 */
function playTone(freqs) {
    freqs.forEach(f => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, audioCtx.currentTime);
        
        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.4, audioCtx.currentTime + 0.01);
        gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.2);
        
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(); 
        osc.stop(audioCtx.currentTime + 0.25);
    });
}

/**
 * 核心处理循环
 */
function processFrame() {
    if (!isProcessing) return;

    // 1. 采集图像
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    cap.data.set(ctx.getImageData(0, 0, canvas.width, canvas.height).data);

    // 2. 图像预处理 (灰度 + 二值化)
    cv.cvtColor(cap, src, cv.COLOR_RGBA2GRAY, 0);
    cv.threshold(src, src, 110, 255, cv.THRESH_BINARY_INV);

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(src, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let slotStates = new Array(5).fill('X');
    const roiXStart = canvas.width / 2 - ROI_W / 2;

    // 3. 轮廓扫描
    for (let i = 0; i < contours.size(); ++i) {
        let cnt = contours.get(i);
        let area = cv.contourArea(cnt);
        if (area < 250 || area > 8000) continue; // 过滤太小或太大的形状

        let rect = cv.boundingRect(cnt);
        let cx = rect.x + rect.width / 2;
        let cy = rect.y + rect.height / 2;

        // 仅在中央 ROI 区域内判断
        if (cx >= roiXStart && cx <= roiXStart + ROI_W) {
            let hull = new cv.Mat();
            cv.convexHull(cnt, hull);
            let hullArea = cv.contourArea(hull);
            let solidity = area / hullArea; // 实心度算法
            hull.delete();

            // 形状判定逻辑
            let shape = (solidity > 0.82) ? 'CIRCLE' : 'X';

            // 更新插槽状态
            PITCH_MAP.forEach(slot => {
                if (cy >= slot.minY && cy < slot.maxY) {
                    slotStates[slot.index] = shape;
                    // 绘制识别框：圆形绿色，X 蓝色
                    let color = (shape === 'CIRCLE') ? [0, 255, 0, 255] : [255, 100, 0, 255];
                    cv.rectangle(cap, new cv.Point(rect.x, rect.y), 
                                 new cv.Point(rect.x + rect.width, rect.y + rect.height), color, 2);
                }
            });
        }
    }

    // 4. 判定发声优先级 (从上往下寻找第一个 CIRCLE)
    let currentPitch = [];
    let activeName = "None";
    for (let i = 0; i < slotStates.length; i++) {
        if (slotStates[i] === 'CIRCLE') {
            currentPitch = [PITCH_MAP[i].freq];
            activeName = PITCH_MAP[i].name;
            break; // 优先级：一旦找到最高的圆形即停止
        }
    }

    // 5. 触发音频 (防抖逻辑)
    if (currentPitch.length > 0 && JSON.stringify(currentPitch) !== JSON.stringify(lastDetectedPitches)) {
        playTone(currentPitch);
    }
    lastDetectedPitches = currentPitch;

    // 6. UI 反馈
    statusElement.innerHTML = `状态: [${slotStates.join(' | ')}] 🎵 触发: ${activeName}`;
    
    // 绘制 ROI 边界
    cv.rectangle(cap, new cv.Point(roiXStart, 0), 
                 new cv.Point(roiXStart + ROI_W, canvas.height), [0, 255, 0, 150], 1);

    // 显示结果
    cv.imshow('canvasOutput', cap);

    // 7. 清理并继续
    contours.delete(); 
    hierarchy.delete();
    requestAnimationFrame(processFrame);
}

/**
 * 停止识别
 */
function stop() {
    isProcessing = false;
    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
    }
    startButton.disabled = false;
    stopButton.disabled = true;
    statusElement.innerHTML = "识别已停止。";
}

// 绑定按钮事件
startButton.onclick = init;
stopButton.onclick = stop;