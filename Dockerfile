FROM node:22.21.1-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22.21.1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY db ./db
COPY src/agents/prompts ./dist/src/agents/prompts
# api por padrao; o worker usa: node dist/src/workers/index.js
CMD ["node", "dist/src/api/index.js"]
