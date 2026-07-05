# LCM Graph Extra 多阶段构建
# 阶段 1：构建主插件 + dashboard 前端
# 阶段 2：运行时镜像（仅含 dist 产物 + 运行时依赖）

FROM node:20-alpine AS builder

WORKDIR /workspace

# 复制 package 清单（利用 docker 层缓存）
COPY package.json package-lock.json* ./
COPY packages/dashboard/package.json packages/dashboard/
COPY tsconfig.json ./

# 安装依赖（npm workspaces 会同时安装主包与 dashboard 子包）
RUN npm ci --ignore-scripts

# 复制源码
COPY . .

# 构建主插件
RUN npm run build

# 构建 dashboard 前端
RUN cd packages/dashboard && npm run build


# ──────────────────────────────────────────────────────────────────────────
# 运行时镜像
FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="lcm-graph-extra"
LABEL org.opencontainers.image.description="OpenClaw Context Engine 插件 — 四层检索上下文注入引擎"
LABEL org.opencontainers.image.source="https://github.com/wljmmx/lcm-graph-extra"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 仅复制运行时必需文件
COPY --from=builder /workspace/dist ./dist
COPY --from=builder /workspace/package.json ./package.json
COPY --from=builder /workspace/package-lock.json* ./package-lock.json*
COPY --from=builder /workspace/openclaw.plugin.json ./openclaw.plugin.json
COPY --from=builder /workspace/packages/dashboard/dist-client ./packages/dashboard/dist-client
COPY --from=builder /workspace/packages/dashboard/package.json ./packages/dashboard/package.json
COPY --from=builder /workspace/packages/dashboard/server ./packages/dashboard/server
COPY --from=builder /workspace/packages/dashboard/dist-server ./packages/dashboard/dist-server

# 安装运行时依赖（仅 production deps）
RUN npm ci --omit=dev --ignore-scripts

# 默认环境变量
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV DASHBOARD_PORT=7421
ENV DASHBOARD_HOST=0.0.0.0
ENV PLUGIN_SNAPSHOT_URL=http://127.0.0.1:7423
ENV OPENCLAW_MCP_URL=http://127.0.0.1:18789

# 健康检查（dashboard 后端 ping）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:7421/api/ping || exit 1

EXPOSE 7421

# 默认启动 dashboard 后端；插件本体由 OpenClaw host 加载
CMD ["node", "packages/dashboard/dist-server/index.js"]
