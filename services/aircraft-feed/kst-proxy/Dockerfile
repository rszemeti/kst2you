FROM python:3.12-alpine

RUN pip install --no-cache-dir websockets==15.0.1 \
    && adduser -D -H kstproxy \
    && mkdir /data && chown kstproxy /data

WORKDIR /app
COPY kst_ws_proxy.py .

USER kstproxy
EXPOSE 8766
CMD ["python", "kst_ws_proxy.py", "--listen-host", "0.0.0.0", "--listen-port", "8766", "--state-file", "/data/kst_ws_proxy_state.json"]
