# Home Assistant app image for portal-met-bridge.
# Built on the device by the Supervisor (no `image:` in config.yaml) or by
# .github/workflows/ha-app.yml for GHCR. The app files come from the release
# tag that matches config.yaml's version, so the folder stays a thin wrapper.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
FROM ${BUILD_FROM}

ARG BUILD_VERSION
ARG APP_VERSION=${BUILD_VERSION}
# APP_REF overrides the tag: a branch name (main) or a commit, for testing unreleased code.
ARG APP_REF=v${APP_VERSION}

RUN apk add --no-cache nodejs openssl \
  && mkdir -p /opt/app \
  && curl -fsSL "https://github.com/privaterra/portal-met-bridge/archive/${APP_REF}.tar.gz" | tar -xz -C /opt/app --strip-components=1 \
  && rm -rf /opt/app/docs/*.png /opt/app/tests /opt/app/tools /opt/app/.github /opt/app/homeassistant

COPY run.sh /
RUN chmod a+x /run.sh

WORKDIR /opt/app
CMD ["/run.sh"]
