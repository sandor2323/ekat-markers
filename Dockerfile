FROM node:18-alpine

WORKDIR /app

# Копируем только нужное для работы приложения
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
