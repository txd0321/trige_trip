# 2026-01-25 工作总结

## 今日总体进度
- **登录体系**：完成从 UI → 逻辑 → 跳转的完整重构。
- **核心解锁闭环（周一目标）**：后端数据结构、云函数、示例数据全部打通，并在详情页验证成功。

---
## 关键改动 & 产出

| 模块 | 产出文件 / 集合 | 关键字段/接口 | 说明 |
| ---- | --------------- | -------------- | ---- |
| 登录页 | `pages/login/*` | `userInfo.avatarUrl`, `userInfo.nickName`, `avatarReady`, `nameReady` | 头像 + 昵称分别授权；`完成` 按钮触发 `login` → `updateUser` → Loading 页；样式内联 `templet.wxss` 并修复头像正圆问题。 |
| Loading 页 | `pages/loading/*` | — | 欢迎文案 1.5 s 后 `switchTab` 首页。 |
| 卡牌集合 | `cards` | `_id`, `name`, `cupType`, `cover` | 导入 4 条示例卡牌（JSON Lines）。 |
| 用户卡牌集合 | `user_cards` | `_openid`, `cardId`, `unlockedAt` | 记录用户解锁状态。 |
| 云函数 | `unlockCard` | 入参 `cupId`；返回 `{ success, repeat, cardInfo }` | cupId→card 查询，写 `user_cards`。部署后日志验证成功。 |
| 详情页 | `pages/card/detail/*` | URL 参数 `cupId` | 调 `unlockCard`，根据 `repeat` 显示“解锁成功 / 已解锁”。 |
| 路由 | `app.json` | 新增页面顺序 | 注册 `loading`、`card/detail` 页面。 |

---
## 今日遇到的问题 & 解决方案

1. **头像显示为椭圆 / 被截断**
   - *原因*：`button` 系统样式干扰尺寸。
   - *解决*：使用 `circle-wrapper` 固定尺寸 + 透明 `button` 覆盖；`overflow:hidden` 保证正圆。

2. **导入 cards.json 报 JSON Lines 格式错误**
   - *原因*：初始文件为普通 JSON 数组。
   - *解决*：改为 `.jsonl` 一行一条记录或直接复制粘贴批量导入。

3. **unlockCard 返回 event 而非业务数据**
   - *原因*：云函数入口未部署正确代码（仍为默认模板）。
   - *解决*：确认 `unlockCard/index.js` 路径及入口 `index.main`，重新部署云端安装依赖。

4. **详情页缺少 cupId**
   - *原因*：页面路径参数拼写为 `cupid`。
   - *解决*：修正为 `/pages/card/detail?cupId=CUP_001`。

5. **头像灰色占位一直显示**
   - *原因*：`thirdwx.qlogo.cn` 未加入 downloadFile 合法域名。
   - *解决*：在公众平台 `服务器域名 → downloadFile` 添加 `thirdwx.qlogo.cn`, `wx.qlogo.cn`。

---
## 下一步计划（W2-5）
- 批量生成 URL Scheme：`pages/card/detail?cupId=xxx`。
- 制作二维码并线下测试微信扫一扫直达详情页。

> 所有代码已提交至本地 Git；推送远程时若遇 400 错误，可检查 URL、代理、2FA Token 等。

---
## 2026-01-26 AR 探索页迭代总结

- **核心决策**：由于个人主体无法使用 OpenCV/TFLite 插件实现高精度实时识别，且轻量 JS 投影法在 8mm 小图案 + 手抖场景下稳定性不足，**决定暂停当前 AR 识别算法优化**，待小程序主体升级为**企业主体**后，再用 **OpenCV** 或 **TensorFlow Lite** 插件重构该功能。

- **AR 页面 MVP** (`pages/ar/index`):
  - **UI**：实现了全屏摄像头、居中竖向 ROI 框（100*700rpx）、5 段分割线、顶部状态文本和底部进度条。
  - **识别逻辑探索**（已写入代码，但效果不佳）：
    1. **投影峰值法**：通过横向投影曲线的峰值数量区分 `●` 和 `❌`。
    2. **3×3 网格密度 + 模板匹配**：用 9 维向量与预设模板做余弦相似度，并加入黑量、置信差距、锁定机制等抗干扰策略。
  - **任务序列**：实现了按 13 步固定序列（`[4,4,3,...]`）匹配圆位置来推进任务的逻辑。

- **遇到的问题 & 解决方案**:
  1. **白屏/无摄像头画面**：通过强制 `position:fixed`、`z-index` 分层、`canvas` 尺寸对齐屏幕、确保相机权限等方式修复。
  2. **ROI/识别框不可见**：通过 `canvas` 尺寸对齐、移除 `type=2d`、CSS `z-index` 修正等方式解决。
  3. **识别乱跳/误判**：尝试了 EMA 平滑、中位数阈值、连续帧确认、冷却节流、置信度差距、锁定机制等多种策略，但受限于 JS 算法本身，对小尺寸+手抖场景仍不够鲁棒。
- **下一步**：
  - **搁置 AR 识别**：等待主体升级。
  - **转向其他模块**：可继续开发“发条解锁与旋转页”（烧3页面F）、“我的”页卡牌列表、AI 聊天等不受主体限制的功能。


2026-01-30