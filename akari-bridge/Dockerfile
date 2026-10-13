ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
FROM ${BUILD_FROM}

# Node.js aus Alpine (22 oder neuer): bringt fetch und WebSocket mit, sonst braucht die Brücke nichts
RUN apk add --no-cache nodejs

COPY bridge.mjs /opt/akari-bridge/bridge.mjs
# with-contenv: gibt SUPERVISOR_TOKEN (Zugang zu Home Assistant) an das Programm weiter
CMD ["/command/with-contenv", "node", "/opt/akari-bridge/bridge.mjs"]
