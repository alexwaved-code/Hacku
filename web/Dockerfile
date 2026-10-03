FROM python:3.12-slim-bookworm
WORKDIR /app
COPY . /app
ENV PYTHONUNBUFFERED=1
ENV HACKU_HOST=0.0.0.0
EXPOSE 8765
CMD ["python3", "server.py"]
