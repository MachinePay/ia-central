# Servico "correio" (IMAP/SMTP/CalDAV) para o ambiente local. No Render ele roda dentro do conteiner do n8n.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY servidor.js ./
ENV CORREIO_HOST=0.0.0.0 CORREIO_PORTA=5690
USER node
CMD ["node", "servidor.js"]
