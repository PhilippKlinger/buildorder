"""Django settings: everything that differs between environments comes from environment variables.

Required: DJANGO_SECRET_KEY. Optional: DJANGO_DEBUG, DJANGO_ALLOWED_HOSTS (comma-separated),
DATABASE_URL (postgres://user:password@host:5432/name, or sqlite:///db.sqlite3 for local work),
DJANGO_SECURE_SSL_REDIRECT, DJANGO_SECURE_HSTS_SECONDS.
"""

import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name, default):
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


def env_list(name):
    return [item.strip() for item in os.environ.get(name, "").split(",") if item.strip()]


def database(url):
    """The DATABASES setting for a DATABASE_URL; without one, Django refuses every query."""
    if not url:
        return {}
    parts = urlsplit(url)
    if parts.scheme == "sqlite":
        return {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": parts.path.lstrip("/")}}
    if parts.scheme in {"postgres", "postgresql"}:
        return {
            "default": {
                "ENGINE": "django.db.backends.postgresql",
                "NAME": unquote(parts.path.lstrip("/")),
                "USER": unquote(parts.username or ""),
                "PASSWORD": unquote(parts.password or ""),
                "HOST": parts.hostname or "",
                "PORT": str(parts.port or ""),
                "CONN_MAX_AGE": 60,
            }
        }
    raise ImproperlyConfigured(f"DATABASE_URL: unsupported scheme '{parts.scheme}'")


SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
DEBUG = env_bool("DJANGO_DEBUG", False)
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS")

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "health",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

DATABASES = database(os.environ.get("DATABASE_URL", ""))
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# HTTPS behind a reverse proxy that terminates TLS and sets X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", not DEBUG)
# The health check of the container platform calls plain HTTP.
SECURE_REDIRECT_EXEMPT = [r"^healthz/$"]
SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_SECURE_HSTS_SECONDS", 0 if DEBUG else 31536000))
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
# HSTS preload is a separate opt-in (hstspreload.org), so its reminder is silenced.
SILENCED_SYSTEM_CHECKS = ["security.W021"]
