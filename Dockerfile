FROM ghcr.io/puppeteer/puppeteer:22.6.0

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "index.js"]
