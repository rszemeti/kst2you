FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Copy application files
COPY Audit.py .
COPY config.json .

# Install dependencies
RUN pip install --no-cache-dir requests

# Set environment variables
ENV PYTHONUNBUFFERED=1

# Run the script
CMD ["python", "Audit.py"]
