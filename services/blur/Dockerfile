FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY blur/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY common/registry.py /app/common/registry.py
COPY blur/blur_utils.py blur/processor.py /app/blur/

ENV PYTHONUNBUFFERED=1

CMD ["python", "-u", "/app/blur/processor.py"]
