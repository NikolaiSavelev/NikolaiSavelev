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
RUN curl -fsSL https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer -o /tmp/russian_trusted_root_ca.cer \
  && curl -fsSL https://gu-st.ru/content/Other/doc/russian_trusted_sub_ca.cer -o /tmp/russian_trusted_sub_ca.cer \
  && (openssl x509 -inform DER -in /tmp/russian_trusted_root_ca.cer -out /usr/local/share/ca-certificates/russian_trusted_root_ca.crt || cp /tmp/russian_trusted_root_ca.cer /usr/local/share/ca-certificates/russian_trusted_root_ca.crt) \
  && (openssl x509 -inform DER -in /tmp/russian_trusted_sub_ca.cer -out /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt || cp /tmp/russian_trusted_sub_ca.cer /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt) \
  && update-ca-certificates

ENV NODE_OPTIONS=--use-system-ca

CMD ["npm","start"]
