# Production Multi-Stage Dockerfile for VOID Music Player
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code and pre-built client bundles
COPY . .

# Expose standard web port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
