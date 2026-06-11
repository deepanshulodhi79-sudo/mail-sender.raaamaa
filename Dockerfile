# Node.js 18 Alpine (chhota aur fast)
FROM node:18-alpine

# Working directory
WORKDIR /app

# Dependencies copy & install
COPY package*.json ./
RUN npm install --production

# Source code copy
COPY . .

# Port expose
EXPOSE 3000

# Server start
CMD ["node", "server.js"]
