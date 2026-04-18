FROM node:20.19.0

WORKDIR /app

COPY package*.json ./

RUN npm install --unsafe-perm

COPY . .

CMD ["node", "index.js"]
