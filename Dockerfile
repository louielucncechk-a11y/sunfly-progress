FROM node:22-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=8765 NODE_ENV=production
EXPOSE 8765
CMD ["node", "server.js"]
