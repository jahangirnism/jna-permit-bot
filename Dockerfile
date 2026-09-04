FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify fluxbox \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x /app/start.sh

ENV NODE_ENV=production
ENV DISPLAY=:99

CMD ["/app/start.sh"]
