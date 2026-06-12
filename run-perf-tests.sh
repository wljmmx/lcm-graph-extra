#!/usr/bin/env bash
# lcm-graph-extra Performance Test Suite Runner
# Usage: bash run-perf-tests.sh [--skip-neo4j] [--skip-qmd]
#
# Requirements:
#   - Neo4j accessible via config in openclaw.json (default: bolt://192.168.50.89:7687)
#   - QMD MCP server at http://127.0.0.1:8081
#   - NODE_PATH=./node_modules (or npm install done)

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

SKIP_NEO4J=false
SKIP_QMD=false
SKIP_CE=false
for arg in "$@"; do
  case "$arg" in
    --skip-neo4j) SKIP_NEO4J=true ;;
    --skip-qmd) SKIP_QMD=true ;;
    --skip-ce) SKIP_CE=true ;;
  esac
done

echo "==================================="
echo " lcm-graph-extra Performance Tests"
echo "==================================="
echo ""
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Node: $(node --version)"
echo ""

# Phase 1: Unit Tests (pure functions, no deps needed)
echo "--- Phase 1: Unit Tests ---"
echo ""
# Unit tests are integrated into the per-module scripts

# Phase 2: Neo4j Tests
if [ "$SKIP_NEO4J" = false ]; then
  echo "--- Phase 2: Neo4j Integration Tests ---"
  echo ""
  echo "Testing Neo4j at $(grep -oP 'bolt://[^"]+' openclaw.plugin.json 2>/dev/null || echo 'bolt://192.168.50.89:7687')..."
  NODE_PATH=./node_modules node test/perf/test-neo4j.cjs 2>&1 || echo "Neo4j tests failed (use --skip-neo4j to bypass)"
  echo ""
else
  echo "--- Phase 2: Neo4j Integration Tests (SKIPPED) ---"
  echo ""
fi

# Phase 3: QMD MCP Tests
if [ "$SKIP_QMD" = false ]; then
  echo "--- Phase 3: QMD MCP Tests ---"
  echo ""
  echo "Testing QMD MCP at http://127.0.0.1:8081..."
  node test/perf/test-qmd.cjs 2>&1 || echo "QMD tests failed (use --skip-qmd to bypass)"
  echo ""
else
  echo "--- Phase 3: QMD MCP Tests (SKIPPED) ---"
  echo ""
fi

# Phase 4: Graph-native Tests
if [ "$SKIP_NEO4J" = false ]; then
  echo "--- Phase 4: Graph-Native Cypher Tests ---"
  echo ""
  NODE_PATH=./node_modules node test/perf/test-graph-native.cjs 2>&1 || echo "Graph-native tests failed"
  echo ""
fi

# Phase 6: OpenClaw CE (Context Engine) Tests
if [ "$SKIP_CE" = false ]; then
  echo "--- Phase 6: OpenClaw CE Performance Tests ---"
  echo ""
  python3 test/perf/test-ce.py 2>&1 || echo "CE tests failed (use --skip-ce to bypass)"
  echo ""
else
  echo "--- Phase 6: OpenClaw CE Performance Tests (SKIPPED) ---"
  echo ""
fi

# Phase 7: Generate Final Report
echo "--- Phase X: Generating Report ---"
echo ""
NODE_PATH=./node_modules node test/perf/generate-report.cjs 2>&1
echo ""
echo "Reports written to: test/perf/REPORT-latest.md and test/perf/CE-report.md"
echo ""
echo "Done."
