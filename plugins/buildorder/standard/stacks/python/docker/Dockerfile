# Image for a Python service (a library needs none: Buildorder proposes the deviation "no Docker").
# Dependencies and the package go into a venv in a build stage, then a slim runtime runs it as a non-root user.
# The base image is pinned by tag and digest; Dependabot keeps both current.
FROM python:3.14.10-slim-trixie@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /src
COPY . .
# The venv is created without pip; the build stage's pip installs into it, so /venv ships no pip.
RUN python -m venv --without-pip /venv \
    && pip --python /venv/bin/python install .

FROM python:3.14.10-slim-trixie@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f
ENV PATH="/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
# The pinned base image ages between Dependabot updates: apply Debian security fixes, and drop pip (and its
# vendored packages), which the running container does not need.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip uninstall -y pip
COPY --from=build /venv /venv
USER app
# Replace with your service's entry point (the console script from [project.scripts] or a server command).
CMD ["python", "-m", "example_package"]
