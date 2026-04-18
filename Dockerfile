FROM node:22

RUN apt-get update && apt-get install -y \
    chromium-browser \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libxss1 \
    fonts-liberation \
    libappindicator1 \
    libindicator7 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "index.js"]
