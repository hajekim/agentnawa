FROM python:3.12-slim

WORKDIR /app

# Install deps first so the layer caches across app-only changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Then the app.
COPY . .

# Cloud Run injects PORT; default to 8080 for local `docker run`.
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
