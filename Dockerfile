# ===== 构建阶段：安装全部依赖并编译 TS =====
FROM node:22-slim AS build
WORKDIR /app
# 原生依赖（@discordjs/opus 等）若无预编译产物会回退本地编译，先装好工具链
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# 先拷贝清单文件，利用 Docker 层缓存加速重复构建
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# 移除开发依赖，缩小最终镜像体积
RUN npm prune --omit=dev

# ===== 运行阶段：仅含生产依赖与构建产物 =====
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# COPY --chown 在拷贝时直接指定归属，避免 chown -R 生成的超大重复层
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node assets ./assets
# /app 目录本身交给 node 用户（state.json 默认写在此处）；/data 供外部卷挂载 state
RUN mkdir -p /data && chown node:node /app /data
USER node
CMD ["node", "dist/index.js"]
