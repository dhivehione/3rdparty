FROM node:22

WORKDIR /app

COPY package*.json ./

# Rebuild better-sqlite3 to match container's glibc
RUN npm install && npm rebuild better-sqlite3

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
