# ReportHub document exporter: Node + Playwright Chromium.
FROM mcr.microsoft.com/playwright:v1.60.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
ENV PORT=3200 NODE_ENV=production
EXPOSE 3200
USER pwuser
CMD ["node", "server.js"]
