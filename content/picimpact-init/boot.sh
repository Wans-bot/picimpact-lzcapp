#!/bin/sh
# PicImpact 应用容器启动脚本（懒猫微服 · 自持启动链）
#
# 镜像原 CMD 为 ./script.sh（prisma migrate deploy / db seed / node server.js）。
# 这里复刻该启动链并在其后追加幂等种子（lzc-seed.mjs）：
#   1) 创建审核账号（应用自身的 better-auth 注册接口）；
#   2) 写入内置对象存储的接入配置（configs 表，只在为空时写入）；
#   3) 创建存储桶并设置「匿名只读」桶策略（写操作仍需预签名）。
# 种子脚本失败不阻塞应用启动（应用可用，图片存储可能未就绪，日志中可见）。
set -e
cd /app

# 1) 等数据库就绪并执行迁移（幂等；上限 60 次重试 ≈ 3 分钟）
i=0
until npx prisma@6.19.3 migrate deploy; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[lzc-boot] migrate deploy failed after retries"
    break
  fi
  echo "[lzc-boot] waiting for database ($i)"
  sleep 3
done

# 2) 初始化默认配置项（上游脚本同款，幂等）
npx prisma@6.19.3 db seed || echo "[lzc-boot] db seed warn"

# 3) 启动应用（后台），随后执行种子脚本
node server.js &
SERVER_PID=$!

node /lzcapp/pkg/content/picimpact-init/lzc-seed.mjs || echo "[lzc-boot] lzc seed failed"

# 4) 保持容器主进程
wait "$SERVER_PID"
