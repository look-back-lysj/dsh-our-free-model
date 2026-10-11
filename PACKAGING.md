# Our Free Model · 跨电脑打包指南

## 两个版本

| 版本 | 说明 | 入口 | 依赖 |
|------|------|------|------|
| **插件版** | DSH 插件 + 独立服务 | `node packages/standalone/cli.mjs` | Node.js 18+ |
| **桌面版** | Tauri 桌面应用 | `packages/desktop/src-tauri/target/release/ofm-desktop.exe` | Rust + Node.js |

两个版本共享同一套前端（`packages/standalone/web/`），后端逻辑完全一致。

## 插件版·快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/Ebony-Vinyl/dsh-our-free-model.git
cd dsh-our-free-model

# 2. 安装依赖
npm install

# 3. 构建前端
node scripts/build-standalone-ui.mjs

# 4. 启动独立服务
node packages/standalone/cli.mjs
# 默认端口 18900，冲突时自动选可用端口
# 打开浏览器访问 http://127.0.0.1:18900
```

### DSH 插件安装

```bash
# 把仓库里的 client.js + index.js + package.json 复制到 DSH 插件目录
# Windows: %USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-our-free-model\
```

## 桌面版·打包

### 前置要求

- **Rust** 1.77+（https://rustup.rs）
- **Node.js** 18+（https://nodejs.org）
- **Windows**：WebView2（Windows 10 1803+ 预装）

### 打包步骤

```bash
# 1. 克隆仓库（如果还没克隆）
git clone https://github.com/Ebony-Vinyl/dsh-our-free-model.git
cd dsh-our-free-model

# 2. 安装依赖 + 构建前端
npm install
node scripts/build-standalone-ui.mjs

# 3. 安装桌面版依赖
cd packages/desktop
npm install

# 4. 编译桌面版（产出可执行文件 + NSIS 安装包）
npx tauri build

# 产物位置：
# 可执行文件：packages/desktop/src-tauri/target/release/ofm-desktop.exe
# 安装包：packages/desktop/src-tauri/target/release/bundle/nsis/Our Free Model_0.1.0_x64-setup.exe
```

### 桌面版特性

- 启动时自动拉起后端服务（固定端口 18900）
- 启动动画（夜·赛博终端 / 昼·流光岁月双主题）
- 自定义标题栏（无边框窗口）
- 系统托盘（左键切换显示/隐藏，右键菜单退出）
- NSIS 安装包（简体中文界面，赛博终端风格安装页）

## 前端主题

- **夜·赛博终端**：深色背景 + 青色扫描线 + 切角卡片 + 等宽字体
- **昼·流光岁月**：纸白背景 + 黄铜色点缀 + 衬线字体 + 光束装饰

两套主题共享同一套 CSS 令牌系统，切换键在侧边栏底部。

## 测试

```bash
# 跑全部测试（43 个测试套件）
node scripts/test-all.mjs --mode contributor
```

## 目录结构

```
dsh-our-free-model/
├── client.js                  # DSH 插件面板（含 v5 精密仪器样式）
├── index.js                   # DSH 插件入口
├── src/                       # 后端核心（路由/转发/聚合/存储）
├── packages/
│   ├── standalone/
│   │   ├── cli.mjs            # 独立服务启动脚本
│   │   ├── frontend/          # 前端源码（app.css/usage.css/...）
│   │   └── web/               # 前端编译产物（app.css/app.js/...）
│   └── desktop/
│       ├── splash/            # 启动动画（夜/昼双主题）
│       ├── ui/                # 自定义标题栏
│       └── src-tauri/         # Tauri 配置 + Rust 源码
└── scripts/                   # 构建/测试脚本
```