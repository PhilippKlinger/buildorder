from django.db import connection
from django.http import JsonResponse
from django.views.decorators.http import require_safe


@require_safe
def health(request):
    """Liveness and database check for the container platform and load balancers."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
    return JsonResponse({"status": "ok"})
