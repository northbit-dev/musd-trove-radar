FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY LICENSE ./
USER node
ENTRYPOINT ["node", "src/cli.mjs", "keeper"]
CMD ["--loop", "--interval", "60"]
