
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared shared
COPY server server
COPY client client
RUN mkdir -p server/assets/grareco
RUN npm run build
RUN npm prune --omit=dev && mkdir -p server/node_modules

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared shared
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/assets server/assets
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
