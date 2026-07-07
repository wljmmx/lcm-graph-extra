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
fi

if [ -z "$SNAPSHOT_SHUTDOWN_TOKEN" ]; then
  echo "  ⚠️  WARNING: SNAPSHOT_SHUTDOWN_TOKEN not set — /internal/shutdown is unprotected."
else
  echo "  ✅ SNAPSHOT_SHUTDOWN_TOKEN is set."
fi

echo "============================================"
echo ""
