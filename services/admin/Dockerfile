FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY common/registry.py /app/common/registry.py
COPY admin/server.py /app/admin/server.py

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["python", "-u", "/app/admin/server.py"]
