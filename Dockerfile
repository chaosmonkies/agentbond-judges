FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production \
    AGENTBOND_DATA_DIR=/data \
    AGENTBOND_KEY_DIR=/run/agentbond
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --legacy-peer-deps --include=dev --ignore-scripts && npm cache clean --force
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY apps/verifier apps/verifier
COPY packages packages
COPY scripts/hosted.ts scripts/hosted-env.ts scripts/hosted-seed.ts scripts/
COPY apps/web/data/public.json bootstrap/public.json
ENV AGENTBOND_HISTORY_FILE=/app/bootstrap/public.json
COPY tsconfig.json ./
RUN mkdir -p /data /run/agentbond && chmod 700 /data /run/agentbond && chown node:node /data /run/agentbond
USER node
EXPOSE 4100
CMD ["node", "--import", "tsx", "scripts/hosted.ts"]
