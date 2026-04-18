FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

USER root

COPY package*.json ./

RUN npm install

COPY . .

RUN chown -R pptruser:pptruser /app

USER pptruser

CMD ["node", "index.js"]
