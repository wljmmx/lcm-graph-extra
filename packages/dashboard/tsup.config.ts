import { defineConfig } from "tsup";

// 后端打包配置：将 server/index.ts 及其相对 import 打包为单文件 ESM
// 解决 tsc 编译后 import 无 .js 扩展名导致 node ESM 无法加载的问题
export default defineConfig({
  entry: ["server/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist-server",
  clean: true,
  sourcemap: false,
  splitting: false,
  // 排除所有 node_modules 依赖（bare import），仅 bundle 项目内相对 import
  // 这样 fastify/neo4j-driver 等保持为外部 import，运行时从 node_modules 解析
  external: [/^[^./]/],
  // 保留 import.meta.url（ESM 专有，tsup 默认保留）
  keepNames: true,
});
