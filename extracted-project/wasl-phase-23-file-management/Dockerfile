FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 UPLOAD_DIR=/app/uploads DATA_DIR=/app/data
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && groupadd --system wasl \
 && useradd --system --gid wasl --home-dir /app wasl \
 && mkdir -p /app/uploads /app/data \
 && chown -R wasl:wasl /app
COPY --chown=wasl:wasl server ./server
COPY --chown=wasl:wasl website ./website
COPY --chown=wasl:wasl migrations ./migrations
USER wasl
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
