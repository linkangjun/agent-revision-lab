FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund --no-audit
COPY . .
RUN npm run build && chown -R node:node /app
USER node
EXPOSE 4317
CMD ["node", "--import", "tsx", "scripts/demo.ts"]
