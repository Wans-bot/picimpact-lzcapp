# 上游来源与改动说明（PicImpact v3.3.8 / LPK 3.3.8-1）

本目录保存打包所依据的上游原始文件，供许可证合规与复核取证。

- 上游仓库：https://github.com/besscroft/PicImpact
- 版本：tag `v3.3.8`（2026-09-23）；镜像 `besscroft/picimpact:latest`（随 tag 由官方
  CI 构建推送），中转后为 `registry.lazycat.cloud/wans/besscroft/picimpact:954337d376d1f336`
- 许可证：MIT（见本目录 `LICENSE`；页面与代码中的版权信息保留不动）

文件对照：

- `Dockerfile.upstream`：上游仓库原始构建文件（Next.js standalone 多阶段构建）；
- `script.sh.upstream`：镜像内置启动脚本原文（migrate deploy / db seed / node server.js），
  本包 `content/picimpact-init/boot.sh` 复刻该启动链并追加幂等种子。

本包运行期改动原则：不改上游源码，全部通过环境变量、启动包装、注入脚本与配置表完成。

1. 启动链：`command` 覆盖为 `boot.sh`（等价上游 script.sh + 种子脚本，见内容目录注释）；
2. 存储接入：`configs` 表写入内置对象存储（RustFS）参数（seed 脚本「仅空值填充」，
   不改用户后续修改）；endpoint 使用应用自身域名，nginx 将 `/picimpact/*` 原样转发到对象存储；
3. 免密登录：`picimpact-autologin.js`（browser 注入，账号固定值随包公开）；
4. 网盘文件选择器：官方 `lzc-file-chooser-inject.js` + request 侧同源桥接（见 manifest 注释）。
