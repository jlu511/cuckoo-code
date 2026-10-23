# 03 构建流程

## 命令总览

| 命令 | 作用 |
|---|---|
| `npm start` | 编译 + 启动 Electron（开发用，日志进 `wyp/log/`） |
| `npm run compile` | 三步构建（见下） |
| `npm run typecheck` | `tsc --noEmit` + `tsc -p tsconfig.hooks.json`（两套） |
| `npm test` | Vitest |
| `npm run lint` | ESLint |
| `npm run build:win:local` | 本地打 Windows 包（**已固定本地 electronDist，见下「已知坑」**） |

## compile 的三步

```
npm run compile
  = node scripts/build-hooks.mjs          # ① 打包 hook + 外置模板
  && tsc -p tsconfig.build.json           # ② TS → out/
  && node scripts/build-tool-api.mjs      # ③ 生成工具契约 + 沙箱注入
```

**顺序不可换**：③ 依赖 ② 的编译产物（读 `out/src/tools/impl/*.js` 的 `apiMetas`）。

### ① build-hooks.mjs

- **hook**：用 esbuild 把 `src/providers/hooks/*.ts` 打包成自包含 IIFE，写入 `src/providers/generated/hook-sources.ts`。
  - 为何要打包？hook 经 `.toString()` 注入 AI 网页主世界，**只能自包含**。写成正常 TS 模块 + 构建期打包，才能 import 共享的 `shared/sse.ts`。
- **覆盖层模板**：读 `src/overlay/template/overlay.html` 与 `overlay.css`，写入 `src/overlay/template.generated.ts`。

### ② tsc

编译 `src/**/*.ts` → `out/`（`rootDir: .`，`outDir: out`）。产物结构镜像 `src/`，即 `out/src/...`。**排除 `src/providers/hooks`**（它们由 esbuild 处理，不需 tsc emit）。

### ③ build-tool-api.mjs

- **工具契约**：收集所有工具的 `apiMetas`，按 `order` 排序、按 `category` 分组，生成 `src/tools/api.d.ts`（给 AI 看的 TS 声明）。
- **沙箱注入**：收集所有工具的 `bootstrap()` 函数，`.toString()` 提取函数体，生成 `src/tools/runtime/bootstrap.generated.ts`。

## 自动生成物清单（⚠️ 别手改）

| 文件 | 真源 |
|---|---|
| `src/providers/generated/hook-sources.ts` | `src/providers/hooks/*.ts` |
| `src/overlay/template.generated.ts` | `src/overlay/template/overlay.{html,css}` |
| `src/tools/api.d.ts` | 各工具的 `apiMetas` |
| `src/tools/runtime/bootstrap.generated.ts` | 各工具的 `bootstrap()` |

**生成物已提交到 git**（便于 diff 与直接运行），但**改动应改真源**。

## 两套 tsconfig

| 配置 | 范围 | strict | 用途 |
|---|---|---|---|
| `tsconfig.json` | `src/**` + `test/**`（排除 hooks） | ✅ | 主应用类型检查 |
| `tsconfig.hooks.json` | `src/providers/hooks/**` | ❌ | hook 独立环境 |
| `tsconfig.build.json` | `src/**`（排除 hooks、test） | 继承 | 编译到 out/ |

**为什么 hook 单独一套**：hook 是注入浏览器主世界的动态脚本（大量 DOM/fetch/XHR 无类型回调），用 strict 会逼出一堆形式主义的 `: any`。单独环境既保留基础检查，又不污染主应用。

## 启动链

```
npm start
  → node start.js
      → tsc -p tsconfig.build.json（编译）
      → electron .
          → 读 package.json 的 main = out/src/app/entry.js
              → src/app/entry.ts 的 app.whenReady() → createWindow()
```

## ⚠️ 已知坑（打包相关，血泪教训）

### 坑 1（最严重）：构建日志绝不能落在项目目录内

**症状**：打包成功、exit code 0、安装后**双击无反应**（进程启动即退出，无任何日志）。

**根因**：`package.json` 的 `build.files` 含 `"**/*"`，会把项目根的所有文件打进 `app.asar`。
若用 `npm run build:win:local > build.log` 把日志写在项目根，asar 打包器读取该文件时
它是 N 字节，**打包期间日志继续增长**到 M 字节 —— 数据区整体偏移 `M - N` 字节，
导致该文件之后的所有文件内容**全部错位**（源码变成 sourcemap 的 base64 碎片）。

**实测证据**（2026-10-23）：`build-rebuild.log` 记录 1410 字节、磁盘实际 3268 字节，
偏移 1858 字节 → 其后 1286 个文件哈希错，`out/` + `src/` 的 **1118 个文件全坏**（1118/1118）。
而 `node_modules/` 排在其前面，5422 个文件全部正常 —— 极易误判为"只有源码有问题"。

**正确做法**：
- 构建日志一律写 `%TEMP%`：`npm run build:win:local > %TEMP%\build.log 2>&1`
- 或直接在前台跑（构建耗时长，可拆成"后台启动"+"轮询日志"两步）
- **绝不要**在项目根留 `.log` 文件后构建

**诊断方法**：用 asar header 里记录的 SHA256 与实际数据区字节比对：

```js
// 读 header → 遍历 entries → 按 offset/size 读原始字节 → 算 SHA256 与 integrity.hash 比对
// BAD=0 才算健康；只要有一批连续文件 BAD，就是数据区错位
```

注意：`@electron/asar` 的 `extractFile()` 会**按 header 的 offset 读**，
所以它读出来的内容同样是错的 —— 用它是**发现不了**"数据区偏移"的，
必须自己按 offset 读 + 校验哈希。

### 坑 2：electron 下载会无限重试卡死构建

**症状**：构建卡在 `downloaded label=electron progress=100%` 之后不再前进，
进程 CPU 冻结（几十秒零增长），`%TEMP%` 下堆积几十个 `electron-download-*` 空目录。

**根因**：网络抖动导致 `connect ETIMEDOUT`（如 `20.205.243.166:443` 是 GitHub 的 IP），
electron-builder 内部会反复重试下载，不报错、不退出。

**解决**：`package.json` 的 `build:win*` 系列脚本已加
`--config.electronDist=node_modules/electron/dist`，
直接复用已安装的 Electron（`npm install` 已下载过），**完全跳过网络下载**。

日志里应看到：
```
• using custom unpacked Electron distribution  electronDist=node_modules\electron\dist
```

若换了 Electron 大版本，确保 `node_modules/electron/dist/electron.exe` 存在（`electron` 包的 postinstall 会下载）。

### 坑 3：不要并发跑两个构建

两个 `electron-builder` 同时写 `dist/win-unpacked` 会互相覆盖，产物损坏且难以定位。
启动前确认无残留进程：

```bat
tasklist /FI "IMAGENAME eq node.exe"
```

### 坑 4：`win-unpacked\Cuckoo-Code.exe` 双击"无反应"是正常的

Electron 的 `requestSingleInstanceLock()`（`src/app/entry.ts`）按**应用身份**加锁，
`win-unpacked` 版与已安装版共享同一把锁。已安装版在跑时，双击 `win-unpacked` 的新进程
抢锁失败 → `app.quit()` 静默退出 → 表现为"双击无反应"。

**要单独试跑**：先退出已安装版，或设独立 userData：

```bat
set CUCKOO_SESSION_DIR=cuckoo-test
"D:\...\dist\win-unpacked\Cuckoo-Code.exe"
```

### 坑 5：打包后的窗口可能开在副屏

窗口位置存在 `%APPDATA%\cuckoo-ai-pro-session\profile-list.json` 的 `bounds.x/y`。
多显示器切换后可能落在不可见的坐标上。用 Win+Shift+左/右 把窗口移回当前屏幕。

### 坑 6：`EBUSY ... unlink 'app.asar'` —— 旧产物被占用

**已观察到的事实**：

- 构建报错 `EBUSY: resource busy or locked, unlink '...\dist\win-unpacked\resources\app.asar'`
- 用 `[System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None')` 独占打开该文件失败，说明**确有进程持有独占句柄**
- 遍历进程检查：**没有任何进程从 `win-unpacked` 启动**，也没有残留的 `electron-builder` / `makensis` / `7za`
- 等待 3 分钟以上仍未释放
- 当时 `MsMpEng.exe`（Windows Defender 实时保护）在运行

**推测（未证实）**：最可能的原因是**杀毒软件/索引服务正在扫描那个 300MB+ 的新 asar**。
但没有用 Restart Manager API 成功列出持有者，也没有查看 Defender 排除列表（需管理员权限），
所以**不能断言就是 Defender**。同理，也不能排除其他安全软件或系统服务。

**也不要**为了绕过这个问题就去加宽泛的 Defender 排除项——那会削弱真实防护。

**恢复策略（推荐）**：

1. **换一个输出目录**，不要动被锁的旧产物：
   ```bash
   npx electron-builder --win --publish never \
     --config.electronDist=node_modules/electron/dist \
     --config.directories.output=dist-build-1
   ```
   `.gitignore` 已含 `dist-*/`，这类目录不会进仓库。

2. **构建成功后必须验证 asar 完整性**（见下方自检清单第 3 项，`BAD` 必须为 0），
   不要凭"构建 exit code 0"就认为产物健康。

3. 若要清理旧目录，先确认没有进程持有句柄；实在删不掉就留着（它在 `.gitignore` 内）。

### 构建脚本 `scripts/build-dist.bat`

一键构建 Windows 安装包，把常见坑固化进流程。

**它会做这些事（**都是破坏性操作，运行前请确认**）**：

| 步骤 | 操作 |
|---|---|
| 1 | `taskkill /F /IM Cuckoo-Code.exe /T` —— **强制结束所有 Cuckoo 进程**，未保存内容会丢失 |
| 2 | 删除 `dist`（删不掉则中止） |
| 3 | 删除所有 `dist-*` 目录（删不掉则中止，防止残留被打进 asar） |
| 4 | `npm run compile` |
| 5 | `electron-builder`（用本地 `node_modules/electron/dist`，不联网下载） |
| 6 | 校验：asar 体积上限 450 MB、asar 根目录不得含 `1`/`reference`/`update`/`dist-*` |

**调用者必须先确认**：`dist` 与所有 `dist-*` 都是可丢弃的构建产物。

**日志**：`%TEMP%\cc-build-dist.log`

**为什么需要它**：

- 残留的 `dist-*` 目录会被 `build.files` 的 `"**/*"` 打进 asar，曾导致 asar 膨胀到 1.4 GB（见「坑 7」）
- 步骤 3 的失败即中止，就是防止这个问题重现
- 步骤 6 的根目录检查会在 asar 含禁用目录时让构建失败，而不是产出坏包

> **编码注意**：该脚本必须是**纯 ASCII**。`cmd.exe` 按系统 ANSI（中文 Windows 为 GBK）解析 `.bat` 文件本身，
> UTF-8 中文会被读成乱码，其中某些字节恰好是 `&` / `|` / 引号等元字符，导致命令被截断成碎片。
> `chcp 65001` 只改**输出**代码页，改不了解析编码。若需修改脚本，保持全英文输出。

### 坑 7：残留 `dist-*` 目录导致 asar 膨胀

**症状**：`npm run build:win:local` 成功，但安装包 648 MB（正常约 213 MB），asar 1.4 GB（正常约 357 MB）。

**根因**：`package.json` 的 `build.files` 含 `"**/*"`，而排除规则只写了 `"!dist"`
（仅匹配名字正好是 `dist` 的目录）。若之前用 `--config.directories.output=dist-031` 构建过，
残留的 `dist-031`（300 MB+）会被打进 asar。

**实测**：一次事故中 asar 根目录含 `dist-031 = 105 条目`、`reference = 16 条目`，总大小 1427 MB。

**修复**（已生效）：

```json
"files": [
  "**/*",
  "!dist",
  "!dist-*",
  "!1${/*}",
  "!reference${/*}",
  "!update${/*}",
  ...
]
```

- `!dist-*` 覆盖所有前缀变体
- `!xxx${/*}` 是 electron-builder 官方语法，排除目录的同时不留空目录
- `1` / `reference` / `update` 是开发资料与脚本，不含运行时资源

**自检**：构建后用 `npx asar list <asar> | findstr /I "dist- reference update"` 确认无残留；
或用 `scripts/build-dist.bat` 的第 6 步自动拦截。

### 打包后的自检清单

```bash
# 1. 产物时间戳是本次构建
powershell "Get-Item 'dist/win-unpacked/resources/app.asar' | Select LastWriteTime"

# 2. asar 内容包含关键模块
npx asar list "dist/win-unpacked/resources/app.asar" | findstr "cc-safety-net"

# 3. 哈希完整性（关键！BAD 必须为 0）
node <审计脚本>

# 4. 项目根无遗留 .log
dir /b *.log

# 5. 若本次用了非默认输出目录（如 dist-031），确认 .gitignore 已覆盖（dist-*/）
git check-ignore -v dist-031
```
