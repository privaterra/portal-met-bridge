#!/command/with-contenv bashio
# Start portal-met-bridge's server on every interface of the container with the
# app's files in the configured folder (default /share/portal-met-bridge, which
# the Samba app exposes as \\homeassistant\share\portal-met-bridge).
set -e
data_dir="$(bashio::config 'data_dir')"
level="$(bashio::config 'log_level')"
bashio::log.level "${level:-info}"
mkdir -p "${data_dir}"
bashio::log.info "portal-met-bridge $(node -p "require('/opt/app/package.json').version") → http://$(bashio::info.hostname 2>/dev/null || hostname):8787 · files in ${data_dir}"
bashio::log.info "Open it in Chrome on your computer; Bluetooth needs the chrome://flags exception for this address (see the Documentation tab)."
cd /opt/app
exec env HOST=0.0.0.0 PORT=8787 DATA_DIR="${data_dir}" node serve.mjs
