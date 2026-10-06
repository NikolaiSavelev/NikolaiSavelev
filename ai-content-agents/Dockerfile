FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# MAX API platform-api2.max.ru uses the Russian Ministry of Digital Development CA chain.
# Install official certificates into the container trust store without disabling TLS verification.
RUN curl -fsSL https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer -o /usr/local/share/ca-certificates/russian_trusted_root_ca.crt \
  && curl -fsSL https://gu-st.ru/content/Other/doc/russian_trusted_sub_ca.cer -o /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt \
  && update-ca-certificates

# Node 20 supports extending its default CA set with a PEM bundle via NODE_EXTRA_CA_CERTS.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

CMD ["npm","start"]
