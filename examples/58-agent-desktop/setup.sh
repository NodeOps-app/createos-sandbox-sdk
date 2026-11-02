#!/bin/sh
# Run only in a disposable Ubuntu 24.04 x86_64 desktop sandbox.
set -eu
[ "$(uname -m)" = x86_64 ] || { echo 'This example requires x86_64' >&2; exit 1; }
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  at-spi2-core libatk-adaptor gnome-calculator
archive=/tmp/createos-agent-desktop-1.0.2.tar.gz
curl -fsSL --retry 2 \
  https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-x86_64-unknown-linux-gnu.tar.gz \
  -o "$archive"
echo "ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4  $archive" | sha256sum -c -
install -d /opt/createos-agent-desktop
tar -xzf "$archive" -C /opt/createos-agent-desktop
install -m 0755 /opt/createos-agent-desktop/agent-desktop \
  /opt/createos-agent-desktop/agent-desktop-linux-clipboard-owner /usr/local/bin/
if ! pgrep -u desktop -x xfce4-session >/dev/null; then
  start-fc-desktop
fi
