#!/bin/sh
# v1.0.1-2: Docker 启动前安全检查
# 验证 DASHBOARD_AUTH 已设置；未设置时打印 CRITICAL 警告（不阻止启动，但醒目提示）

set -e

echo "============================================"
echo "  LCM Graph Extra - Docker Security Check"
echo "============================================"

if [ -z "$DASHBOARD_AUTH" ]; then
  echo ""
  echo "  ╔══════════════════════════════════════════════════════════╗"
  echo "  ║  ⚠️  CRITICAL: DASHBOARD_AUTH is NOT set!               ║"
  echo "  ║                                                          ║"
  echo "  ║  The dashboard is running WITHOUT authentication.       ║"
  echo "  ║  Anyone with network access can read/modify your data.  ║"
  echo "  ║                                                          ║"
  echo "  ║  Set DASHBOARD_AUTH=\"user:pass\" before production use.  ║"
  echo "  ╚══════════════════════════════════════════════════════════╝"
  echo ""
  # 在严格模式下退出
  if [ "$REQUIRE_DASHBOARD_AUTH" = "1" ] || [ "$REQUIRE_DASHBOARD_AUTH" = "true" ]; then
    echo "  REQUIRE_DASHBOARD_AUTH=true → refusing to start."
    exit 1
  fi
  echo "  (Set REQUIRE_DASHBOARD_AUTH=true to enforce and refuse startup without auth.)"
  echo ""
else
  echo "  ✅ DASHBOARD_AUTH is set (auth enabled)."
  # security: 众所周知的弱口令检测 —— 默认口令若保持不变，等同于未启用认证。
  # 命中且开启 REQUIRE_DASHBOARD_AUTH 时直接拒绝启动；否则醒目告警。
  case "$DASHBOARD_AUTH" in
    *"changeme-docker-default"*|*":admin"*|*":root"*|*":password"*|*":123456"*)
      echo ""
      echo "  ⚠️  WARNING: DASHBOARD_AUTH uses a well-known weak credential: \"$DASHBOARD_AUTH\""
      echo "  ⚠️  This password is publicly documented and can be guessed by attackers."
      echo ""
      if [ "$REQUIRE_DASHBOARD_AUTH" = "1" ] || [ "$REQUIRE_DASHBOARD_AUTH" = "true" ]; then
        echo "  REQUIRE_DASHBOARD_AUTH=true → refusing to start with a weak credential."
        exit 1
      fi
      echo "  (Set REQUIRE_DASHBOARD_AUTH=true to refuse startup on weak credentials.)"
      echo ""
      ;;
  esac
fi

# security: Neo4j 弱口令提示（只告警不阻断，dashboard 容器通常不直接暴露 Neo4j 端口）
if [ -n "$NEO4J_PASSWORD" ]; then
  case "$NEO4J_PASSWORD" in
    "neo4j"|"lcmgraphextra"|"password"|"admin"|"changeme"*)
      echo "  ⚠️  WARNING: NEO4J_PASSWORD is a well-known default (\"$NEO4J_PASSWORD\"). Use a strong random password in production (set in .env)."
      ;;
  esac
fi

if [ -z "$SNAPSHOT_SHUTDOWN_TOKEN" ]; then
  echo "  ⚠️  WARNING: SNAPSHOT_SHUTDOWN_TOKEN not set — /internal/shutdown is unprotected."
else
  echo "  ✅ SNAPSHOT_SHUTDOWN_TOKEN is set."
fi

echo "============================================"
echo ""
