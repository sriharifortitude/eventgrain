# One image, three roles: api (default), worker, and one-off commands
# (migrate, cli). The role is the command; the image is the same bytes.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 4200
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -qO- http://127.0.0.1:4200/api/health || exit 1
CMD ["node", "dist/server.js"]
