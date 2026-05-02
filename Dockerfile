FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

# Install build deps for better-sqlite3, then remove them
RUN apk add --no-cache python3 make g++ && \
    npm ci --only=production && \
    npm cache clean --force && \
    apk del python3 make g++

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
