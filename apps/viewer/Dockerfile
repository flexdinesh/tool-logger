FROM node:26-slim AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/viewer/package.json ./apps/viewer/package.json
RUN pnpm install --frozen-lockfile --filter viewer...
COPY tsconfig.json ./
COPY apps/viewer/ ./apps/viewer/
RUN pnpm --filter viewer build

FROM node:26-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    TOOL_LOGGER_STATE_DIR=/logs

# Backend remains native TypeScript; React and CSS are bundled frontend assets.
COPY --from=build /workspace/apps/viewer/package.json ./
COPY --from=build /workspace/apps/viewer/src/ ./src/
COPY --from=build /workspace/apps/viewer/dist/ ./dist/

EXPOSE 4317
CMD ["node", "src/server.ts"]
