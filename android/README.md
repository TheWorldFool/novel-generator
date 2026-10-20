# 叙事工坊 Android

安卓版在应用私有目录保存作品。Chaquopy 嵌入 Python 3.13；应用启动时将 `static/` 中的界面复制到私有运行目录，使用随机端口运行仅监听 `127.0.0.1` 的服务，由原生 WebView 展示。

桌面端和安卓端共用根目录的 `app.py`、`novel.py`、`outline.py`，由 Gradle 构建时同步，避免出现两套人物状态或大纲规则。数据库独立于打包资源，覆盖安装不会重置作品。

## 安装

下载 [Releases](https://github.com/TheWorldFool/novel-generator/releases) 的 APK，在 Android 7.0+ 的64位系统安装。包含 `arm64-v8a` 和 `x86_64`；界面使用系统 WebView，请更新 WebView 后使用。发布版包名 `io.github.theworldfool.novelgenerator`。

应用不依赖电脑和外部 Python 安装。AI 功能仍需作者配置模型 API，断网时可使用本地编辑和管理功能。首次打开示例作品后，可点击作品选择器旁的「+」新建。

## 本机构建

需要 JDK 17 或更新版本、Python 3.13；运行应用本身不需要手机额外安装它们。

Windows 在项目根目录执行：

```powershell
python tools/build_android.py --setup
```

首次会下载并校验 Android command-line tools 19.0、Gradle 8.13，并安装 SDK 35。SDK 工具要求接受其许可证。工具缓存位于 `%LOCALAPPDATA%\NovelGenerator\toolchain`，不会写进 Git。以后可省略 `--setup`。

输出为 `dist/novel-generator-0.2.1-android.apk` 与 SHA-256 校验文件，版本号从构建产物读取。脚本先执行 `assembleRelease` 和 `lintRelease`，成功后才复制 APK。

签名首次生成在 `%LOCALAPPDATA%\NovelGenerator\signing`，包括 `.jks` 和保存随机密码的 `.json`。**请私下备份整个签名目录**：后续更新必须使用同一密钥。这些文件不在仓库里；不要上传 GitHub。构建过程通过环境变量把密码交给工具，不把密码放在命令参数中。

已有 Android SDK/Android Studio 的开发者，也可设置 `ANDROID_HOME` 后在 `android/` 运行：

```sh
./gradlew assembleDebug lintDebug
./gradlew connectedDebugAndroidTest
```

第二条需要连接设备或启动模拟器。调试版包名带 `.debug`，可与发布版共存，数据互相独立。无签名环境变量时 `assembleRelease` 只产生未签名包，安装请用上述 Python 构建脚本。

## 验证与持续构建

```powershell
python -m unittest discover -s tests -v
node --test tests/mobile_autosave.test.js
```

Python 测试包含手机会话鉴权、静态资源目录、独立存储、保存导出以及原有创作流程。JavaScript 测试检查自动保存期间继续输入、串行保存、失败保留草稿和 AI 操作隔离。

GitHub Actions 构建调试 APK、运行 Lint，并在 Android API 35 模拟器执行 `RuntimeSmokeTest`，检查 APK 内的 Python、SQLite、资源和会话鉴权。测试不调用真实收费模型。流程产物中的 debug APK 仅用于开发；用户安装请使用 Releases 中持续沿用同一签名的 APK。

## 数据与平台行为

- 只申请联网权限。文件导入导出使用系统文档选择器，由作者指定文件；无后台常驻服务、全盘读写或相册权限。
- WebView 只加载当前应用内地址，禁止任意网站跳转；无 JavaScript 到 Java 的通用桥接接口。
- 本地服务每次进程启动创建随机会话令牌，用 HttpOnly Cookie 鉴权。其他手机应用即使访问同一个回环端口，也不能在无令牌时读取小说或修改数据。桌面端原有 Host/Origin 检查保留。
- API 密钥只在 Python 进程内存保留；作品、图片、非秘密设置存于应用私有 SQLite。禁用自动云备份和设备迁移；请主动导出作品。
- 停止输入后自动保存草稿，仍由作者确认正文、人物变化和大纲。活动弹窗、模型设置、参考文件采用等操作需点击相应按钮提交。
- Android 可以回收后台进程；这版不承诺后台持续生成。请在生成结束后再切换应用。
- 暂无电脑同步、JSON 导入、应用内自动升级和商店分发。

实现依据：[Chaquopy Gradle 文档](https://chaquo.com/chaquopy/doc/current/android.html)、[Android 系统文件选择器](https://developer.android.com/training/data-storage/shared/documents-files)、[Android 网络安全配置](https://developer.android.com/privacy-and-security/security-config)。
