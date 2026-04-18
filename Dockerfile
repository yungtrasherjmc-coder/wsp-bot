FROM ghcr.io/puppeteer/puppeteer:22.6.0

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN rm -rf .wwebjs_auth .wwebjs_cache
CMD ["node", "index.js"]
