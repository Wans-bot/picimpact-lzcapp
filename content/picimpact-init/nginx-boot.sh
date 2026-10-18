#!/bin/sh
# PicImpact 入口 nginx 启动脚本：从包内容目录复制配置后启动。
set -e
cp /lzcapp/pkg/content/picimpact-init/nginx.conf /etc/nginx/nginx.conf
exec nginx -g 'daemon off;'
