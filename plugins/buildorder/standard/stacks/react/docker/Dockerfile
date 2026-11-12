# React image: the Vite build runs in a Node stage, then unprivileged Nginx serves dist/ on port 8080 as a non-root user.
# Both base images are pinned by tag and digest (the Node tag matches .nvmrc); Dependabot keeps them current.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

FROM nginxinc/nginx-unprivileged:1.31.7-alpine3.24@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
USER root
# The pinned base image ages between Dependabot updates: apply Alpine security fixes.
RUN apk upgrade --no-cache
USER nginx
# Single-page app: unknown paths fall back to index.html; the security headers are set once, at server level.
COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    server_tokens off;
    add_header Content-Security-Policy "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    location / {
        try_files $uri /index.html;
    }
}
NGINX
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
