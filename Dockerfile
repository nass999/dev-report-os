# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --production
COPY . .

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app .
RUN mkdir -p /app/data /app/sessions && chown -R 1001:1001 /app/data /app/sessions
ENV NODE_ENV=production
EXPOSE 5174
USER 1001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5174/ || exit 1
CMD ["node", "server.js"]
