# Angular image: the app is built in a Node stage (same version as CI, see .nvmrc), then served as static files by
# unprivileged Nginx. Both base images are pinned by tag and digest; Dependabot keeps both current.
# The site lives in /usr/share/nginx/html, which the webspace deployment also reads.
FROM node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.7-alpine3.24@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
# The pinned base image ages between Dependabot updates: apply Alpine security fixes as root, then drop to the
# unprivileged nginx user (uid 101).
USER root
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/app/browser /usr/share/nginx/html
USER 101
EXPOSE 8080
