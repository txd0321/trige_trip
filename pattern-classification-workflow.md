# 整组模式识别（6类）落地流程

本文档用于指导当前项目从“规则识别”切换到“整组分类识别（6类）”的完整实施流程。

## 1. 目标定义

将一整组图案作为一个分类样本，进行 6 类分类：

- `pattern_circle_1`：`●❌❌❌❌`
- `pattern_circle_2`：`❌●❌❌❌`
- `pattern_circle_3`：`❌❌●❌❌`
- `pattern_circle_4`：`❌❌❌●❌`
- `pattern_circle_5`：`❌❌❌❌●`
- `pattern_all_cross`：`❌❌❌❌❌`

说明：circle 索引按从上到下 `0~4`。

---

## 2. 数据采集规范

### 2.1 数据目录结构

在项目中创建以下目录：

- `cloudrun/opencv-service/dataset/pattern_circle_1`
- `cloudrun/opencv-service/dataset/pattern_circle_2`
- `cloudrun/opencv-service/dataset/pattern_circle_3`
- `cloudrun/opencv-service/dataset/pattern_circle_4`
- `cloudrun/opencv-service/dataset/pattern_circle_5`
- `cloudrun/opencv-service/dataset/pattern_all_cross`

### 2.2 每类样本数量

- 起步：每类 **150 张**
- 推荐：每类 **250~400 张**
- 总量建议：**900~2400 张**

### 2.3 拍摄要求

每张图建议：

- 只包含一整组目标图案
- 整组尽量完整位于 ROI 内
- 覆盖不同条件：
  - 光照（亮/暗/侧光）
  - 距离（近/中/远）
  - 角度（轻微旋转/倾斜）
  - 清晰度（轻微模糊）
  - 背景（单一/复杂）

避免问题：

- 六类样本严重不平衡（建议差异不超过 20%）
- 全部样本拍摄条件过于一致（易过拟合）

---

## 3. 训练流程

可选平台：

1. 快速验证：Teachable Machine
2. 工程化推荐：Roboflow（分类任务）

训练建议：

- 使用 6 类分类任务
- 划分训练/验证/测试集（如 70/20/10）
- 观察每类准确率和混淆矩阵
- 重点关注 `pattern_circle_4` vs `pattern_circle_5` 等相邻类混淆

验收目标（建议）：

- 验证集总体准确率 > 90%
- 各类别召回率均衡，无明显短板类别

---

## 4. 模型导出与交付

导出可用于 Python 后端推理的模型（任选其一）：

- ONNX（推荐）
- Keras / TensorFlow SavedModel

必须同时提供：

1. 模型文件
2. 标签顺序文件（class names）

> 标签顺序必须与训练时一致，否则后端类别映射会错。

---

## 5. 后端接入（当前项目）

当前后端已接入整组分类接口骨架，支持返回：

- `patternLabel`
- `patternScore`
- `slots`
- `items`

接入真实模型后，将替换占位推理函数，保留相同响应结构，前端无需大改。

---

## 6. 前端联调要点

前端识别流程建议切换为：

1. 读取后端 `patternLabel`
2. 与当前步骤目标模式比对（13步模板）
3. 使用 3~5 帧投票做稳定判定
4. 命中后触发音符和进度推进

并保留：

- 超时重试
- 降频提示
- 识别可视化框

---

## 7. 13步模式对应（参考）

- 步骤 1/2/4/8/9/11 -> `pattern_circle_5`
- 步骤 3/10 -> `pattern_circle_4`
- 步骤 5/13 -> `pattern_circle_2`
- 步骤 6 -> `pattern_circle_3`
- 步骤 7 -> `pattern_all_cross`
- 步骤 12 -> `pattern_circle_1`

---

## 8. 测试与迭代建议

上线前测试：

- 正常光照：连续识别稳定
- 弱光环境：不崩溃，有合理提示
- 角度偏差：仍有较高命中率
- 网络波动：有降频与重试机制

持续优化：

- 收集误判样本回流数据集
- 每周/每两周小迭代一次模型
- 保持类别数量均衡，优先补难样本

---

## 9. 当前阶段说明

目前项目中“整组分类”已打通接口与前后端调试链路。
当前推理为占位逻辑，仅用于联调。
待你提供真实训练模型后，将替换为真实推理并进入准确率优化阶段。

---

## 10. `pattern-collector` 页面开发说明（当前实现）

本节记录当前 `miniprogram/pages/pattern-collector` 页面的已实现能力、依赖关系与调试要点。

### 10.1 页面目标

`pattern-collector` 页面用于两类任务：

1. **采集模式（拍照并采集）**
   - 拍照后按蓝色 ROI 框裁剪
   - 上传到 COS 的 `pattern-collector/<class>/...jpg`
   - 更新本地采集清单（manifest）与计数

2. **识别模式（拍照并识别）**
   - 拍照后按同一 ROI 裁剪
   - 调后端 `/api/infer` 转发 Roboflow 分类推理
   - 仅显示识别结果，不写入 COS 训练数据目录

### 10.2 页面文件结构

- `miniprogram/pages/pattern-collector/index.js`
- `miniprogram/pages/pattern-collector/index.wxml`
- `miniprogram/pages/pattern-collector/index.wxss`
- `miniprogram/pages/pattern-collector/index.json`

`app.json` 中已注册页面：
- `pages/pattern-collector/index`

### 10.3 关键功能点

1. **相机预览 + 蓝色 ROI 叠层**
   - `camera` 全屏预览
   - `canvas` 绘制 ROI 边框与分段辅助线

2. **ROI 裁剪链路**
   - UI 坐标映射到原图坐标（按 cover/aspectFill 近似）
   - 支持 ROI 校准参数：`offsetX/offsetY/scaleX/scaleY`
   - 采用兼容方案裁剪（避免旧版 9 参数 drawImage 在机型上的异常）

3. **COS 采集上传**
   - 小程序请求签名接口：`GET /api/cos/sign-upload`
   - 使用预签名 PUT URL 上传图片
   - 对象路径规范：`pattern-collector/<class>/<timestamp>_<rand>.jpg`

4. **Roboflow 识别**
   - 小程序将 ROI 图转 base64 后请求：`POST /api/infer`
   - 后端调用 Roboflow 分类接口并返回结果
   - 前端兼容多种返回结构（数组 predictions / 字典 predictions / top+confidence）

5. **采集统计与导出**
   - 本地存储 `manifest`（类别、时间、COS key、URL 等）
   - 可导出 JSON 采集清单

### 10.4 当前配置项（前端）

`index.js` 内主要配置：

- `COS_CONFIG.bucket`
- `COS_CONFIG.region`
- `COS_CONFIG.workerBaseUrl`（必须与当前 cloudflared 域名一致）
- `ROI_ASPECT_RATIO`
- `ROI_CALIBRATION`

说明：`trycloudflare.com` 是临时域名，重启 tunnel 后可能变化，需要同步更新 `workerBaseUrl`。

### 10.5 本地后端（Cloudflare 目录）

当前使用本地 Node 服务文件：
- `cloudflare/local-cos-signer-server.js`

功能：
- `GET /healthz`：健康检查
- `GET /api/cos/sign-upload`：生成 COS PUT 预签名上传 URL
- `POST /api/infer`：转发 Roboflow 分类推理

环境变量（`cloudflare/.env`）：
- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`
- `BUCKET`
- `REGION`
- `PORT`（建议与其他本地服务错开，如 `8081`）
- `ROBOFLOW_API_KEY`
- `ROBOFLOW_MODEL`
- `ROBOFLOW_VERSION`

### 10.6 启动与联调步骤（当前）

1. 启动本地后端（在 `cloudflare` 目录）
2. 启动 tunnel：`cloudflared tunnel --url http://localhost:<PORT>`
3. 将新生成的 `https://*.trycloudflare.com` 写入 `workerBaseUrl`
4. 小程序重新编译并真机调试
5. 分别验证“拍照并采集”和“拍照并识别”

### 10.7 已知问题与排查

1. **`unknown 0%`**
   - 常见原因：识别返回为空或解析字段不匹配
   - 处理：查看 `/api/infer` 日志与返回结构

2. **`Failed to fetch` / `UND_ERR_SOCKET`**
   - 常见原因：本机到 Roboflow 网络链路波动
   - 处理：重试、切换网络（如手机热点）、保持 tunnel 稳定

3. **`EADDRINUSE` 端口占用**
   - 常见原因：多个服务同时占用 8080
   - 处理：改用独立端口（如 8081）并同步更新 tunnel

4. **真机无日志但功能异常**
   - 常见原因：真机未加载最新代码/仍用旧 tunnel 地址
   - 处理：清缓存重编译，核对 `workerBaseUrl`

### 10.8 数据采集建议（页面层面）

- 采集与识别分开使用，避免把识别测试图混入训练集
- 每类保持数量平衡，建议先每类 80+，再补到 150+
- 定期检查 ROI 对齐与图像清晰度，避免无效样本
- 统一类别命名，避免多套命名并存导致训练混乱
