#!/command/with-contenv bashio
# Start portal-met-bridge's server on every interface of the container with the
# app's files in the configured folder (default /share/portal-met-bridge, which
# the Samba app exposes as \\homeassistant\share\portal-met-bridge), on
# http://…:8787 and — unless ssl is "off" — https://…:8788, which is the address
# that makes the Portal's Web Bluetooth available in Chrome.
set -e
data_dir="$(bashio::config 'data_dir')"
level="$(bashio::config 'log_level')"
ssl_mode="$(bashio::config 'ssl')"
bashio::log.level "${level:-info}"
mkdir -p "${data_dir}"
host="$(bashio::info.hostname 2>/dev/null || hostname)"
version="$(node -p "require('/opt/app/package.json').version")"

tls=()
case "${ssl_mode}" in
  home-assistant)
    # Home Assistant's own certificate (Let's Encrypt via DuckDNS, Nabu Casa, …) from /ssl
    cert="/ssl/$(bashio::config 'certfile')"
    key="/ssl/$(bashio::config 'keyfile')"
    if [ -f "${cert}" ] && [ -f "${key}" ]; then
      tls=(TLS_PORT=8788 TLS_CERT="${cert}" TLS_KEY="${key}")
      bashio::log.info "https on 8788 with Home Assistant's certificate ${cert}"
    else
      bashio::log.warning "ssl is 'home-assistant' but ${cert} / ${key} are missing — serving http only"
    fi
    ;;
  self-signed)
    # A certificate made here on first start (kept in /data), valid for the names this host answers to.
    mkdir -p /data/tls
    if [ ! -f /data/tls/cert.pem ] || [ ! -f /data/tls/key.pem ]; then
      ip="$(bashio::network.ipv4_address 2>/dev/null | head -1 | cut -d/ -f1 || true)"
      san="DNS:${host},DNS:${host}.local,DNS:homeassistant,DNS:homeassistant.local,DNS:localhost,IP:127.0.0.1"
      [ -n "${ip}" ] && san="${san},IP:${ip}"
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
        -keyout /data/tls/key.pem -out /data/tls/cert.pem -days 3650 \
        -subj "/CN=portal-met-bridge on ${host}" -addext "subjectAltName=${san}" \
        -addext "basicConstraints=critical,CA:FALSE" -addext "extendedKeyUsage=serverAuth" 2>/dev/null
      bashio::log.info "made a self-signed certificate for ${san}"
    fi
    tls=(TLS_PORT=8788 TLS_CERT=/data/tls/cert.pem TLS_KEY=/data/tls/key.pem TLS_SELF_SIGNED=1)
    ;;
  *)
    bashio::log.info "ssl is 'off': http only — Bluetooth then needs the chrome://flags exception for http://${host}.local:8787"
    ;;
esac

bashio::log.info "portal-met-bridge ${version} → http://${host}.local:8787${tls:+ and https://${host}.local:8788} · files in ${data_dir}"
bashio::log.info "Open it in Chrome on your computer. For the Portal's Bluetooth use the https address (trust its certificate once — the page explains how), or set the chrome://flags exception."
cd /opt/app
exec env HOST=0.0.0.0 PORT=8787 ALLOW_QUIT=1 DATA_DIR="${data_dir}" "${tls[@]}" node serve.mjs
