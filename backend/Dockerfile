FROM python:3

WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1 \
    SP_DB_PATH=/data/starpi.db

VOLUME [ "/data" ]
EXPOSE 8000

ENTRYPOINT [ "python", "src/main.py" ]
