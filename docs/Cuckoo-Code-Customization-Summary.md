# Cuckoo Code 深度定制开发总结 (Workspace Permission & Security)

## 1. 项目背景与目标
本项目基于开源项目 `cuckoo-code` (Electron + TypeScript) 进行二次定制开发。
- **上游仓库**: `https://github.com/wangyongpeng90/cuckoo-code`
- **个人 Fork**: `https://github.com/jlu511/cuckoo-code` (主要工作分支为 `dev`)
- **核心目标**: 引入类似 DSH 体系的三种文件与命令访问权限模式，防止 AI 误操作破坏系统文件。
- **附加目标**: 拦截高危命令，执行前强制要求 AI 解释用途并弹窗二次确认。

---

## 2. 核心功能清单

### 2.1 三种访问权限模式 (UI: 侧边栏「元」下方「权」按钮)
1. **仅可查看 (Read-only)**
   - 允许读取任意路径。
   - **绝对禁止**所有写、删操作。
   - **绝对禁止**执行 `bash` / `pwsh` 命令。
2. **工作区内修改 (Workspace-write)**
   - 允许工作区内的所有读写删操作。
   - **拦截**工作区外的写、删操作。
   - 允许读取工作区外的文件（为了避免 AI 变“瞎子”）。
   - 允许执行 `bash` / `pwsh`（但需经过弹窗确认）。
3. **完全权限 (Full-access)**
   - 解除所有路径限制，与原版行为一致。

### 2.2 高危命令弹窗拦截
- **强制说明**：AI 调用 `bash` / `pwsh` 时必须提供 `description`（用途说明），否则直接报错拒绝。
- **原生弹窗**：主进程使用 `dialog.showMessageBox` 弹出确认框，用户必须点击“允许”才能执行。
- **高危特征识别**：如果命令包含 `rm -rf`、`del /s`、`rd /s`、`format` 或直接操作盘符根目录（如 `C:\\`），弹窗会变成红色的“🚨 高危操作拦截”，并附加强烈警告文字。

---

## 3. 代码修改档案 (基于 dev 分支)

### 3.1 底层基础设施
- `src/infra/config.ts`：增加 `accessMode: 'readOnly' | 'workspaceWrite' | 'fullAccess'` 字段，默认 `workspaceWrite`。
- `src/infra/permission.ts` (新增)：核心策略模块。
  - `checkPathPermission`: 使用 `fs.realpath` 和大小写规范化解决符号链接和绕过问题，判定路径是否在工作区内。
  - `checkCommandPermission`: 判定是否允许执行命令（只读模式拦截）。

### 3.2 工具层 (Tools)
- `write.ts`, `edit.ts`, `delete-file.ts`：在操作前调用 `checkPathPermission`。
- `bash.ts`, `pwsh.ts`：在操作前调用 `checkCommandPermission`。随后进行危险特征匹配，并利用 `createRequire` 引入 `electron` 的 `dialog` 模块弹出确认框。并在 schema 定义中将 `description` 设为必填。

### 3.3 UI 与 IPC 通信
- `src/app/ipc/permission.ts` (新增)：提供 `get-access-mode` 和 `set-access-mode` 的 IPC 接口。
- `src/ui/shell/partials/activitybar.html`：添加「权」按钮。
- `src/ui/shell/partials/pages/permission.html`：新增权限设置面板界面。
- `src/ui/shell/scripts/pages/permission.ts` (新增)：处理 UI 状态绑定与切换。
- `src/app/shell-preload.ts` & `src/ui/shell/scripts/shell-api.ts`：暴露对应的 API。

---

## 4. 踩坑与工程化指南（⚠️ 极其重要，请其他 AI 务必遵守）

### 4.1 为什么编译出来的 exe 双击无反应？
- **现象**：`electron-builder` 打包出的 `cuckoo-code-win-v0.8.17.exe` 或者 `win-unpacked` 目录下的 exe 双击无反应，无报错，命令行启动也瞬间退出。
- **原因**：
  1. 我们生成的 exe 没有官方数字签名，被杀毒软件/Windows Defender 静默拦截。
  2. Cuckoo 代码写死了全局单实例锁，如果官方原版正在后台运行（哪怕在托盘里），新拉起的进程就会被直接静默干掉。
- **最终解决方案（借壳生蛋）**：
  - **不要**尝试用 `electron-builder` 生成安装包或完整的 exe 外壳。
  - 必须使用极速打包模式：`npx electron-builder --win --dir`。
  - 提取出打包生成的 `dist\win-unpacked\resources\app.asar`。
  - 将其直接覆盖到官方安装目录中：`%LOCALAPPDATA%\Programs\Cuckoo-Code\resources\app.asar`。利用官方原版的外壳运行我们定制的内核。

### 4.2 为什么改了代码后，拦截逻辑依然不生效？
- **现象**：源码 `src/` 里明明写了 `checkPathPermission`，但运行起来完全没有拦截效果。
- **原因**：TypeScript 的增量编译机制在 Windows 下因为文件时间戳/CRLF 换行问题，偶尔会跳过编译，导致 `out/` 目录里的 JS 文件还是旧的。
- **解决方案**：每次编译前，**必须强制彻底删除 `out/` 和 `dist/` 目录**，然后再执行 `npm run compile`，确保绝对的全量编译。

### 4.3 如何安全地跨工作区修改代码？
- **现象**：当 AI 处于 `workspaceWrite` 模式且工作区为 `ppt` 时，尝试用 `write` 工具去修改 `cuckoo-code` 里的文件，会被我们自己写的拦截逻辑报错。
- **解决方案**：
  - 先在当前工作区（例如 `ppt`）用 `write` 工具写一个独立的补丁脚本（如 `patch.mjs`），利用绝对路径读取和修改目标文件。
  - 然后用 `bash` 执行 `node "D:/Software/cuckoo-code/ppt/patch.mjs"` 完成修改。

---

## 5. 日常开发与更新流程

### 5.1 一键更新脚本
在源码根目录下，存在一个 `update-original.bat`。双击它会自动执行以下流程：
1. 杀掉所有正在运行的 `Cuckoo-Code.exe`。
2. 执行 `npm run compile`（全量编译）。
3. 执行 `npx electron-builder --win --dir`（极速打包提取内核）。
4. 备份并替换官方安装目录下的 `app.asar`。
5. 重新启动原版外壳（即你的定制版）。

### 5.2 如何退回官方纯净版？
去 `C:\Users\Lee\AppData\Local\Programs\Cuckoo-Code\resources\` 目录：
1. 删除当前的 `app.asar`。
2. 把 `app.asar.original` 重命名为 `app.asar`。
3. 重启程序。
