FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

ENV NODE_ENV=production
RUN npm ci --only=production && npm cache clean --force

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
