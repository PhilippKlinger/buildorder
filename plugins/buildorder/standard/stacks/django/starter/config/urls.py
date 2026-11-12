from django.urls import path

from health.views import health

urlpatterns = [
    path("healthz/", health, name="health"),
]
