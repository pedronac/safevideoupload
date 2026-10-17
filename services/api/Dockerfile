FROM python:3.12-slim-bookworm

WORKDIR /app
COPY common/registry.py /app/common/registry.py
COPY api/server.py /app/api/server.py

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["python", "-u", "/app/api/server.py"]
