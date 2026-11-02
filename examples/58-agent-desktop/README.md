# 58 - agent-desktop semantic automation

Run Vercel Labs agent-desktop inside a disposable CreateOS desktop sandbox
using the SDK's existing `runCommand` transport. No SDK runtime dependency
or new server endpoint is needed.

## Run

From this directory, copy `.env.example` to `.env`, supply your sandbox API
key, and run `bun index.ts`. The example imports the repository source so
it tests local SDK changes. It creates and destroys its own sandbox.

The setup installs AT-SPI and GNOME Calculator, downloads the pinned Linux
x86_64 agent-desktop 1.0.2 archive, checks its SHA-256, and starts XFCE if
needed. The checksum records the archive used for this compatibility test;
it is not an independent verification of publisher identity.

`session.py` joins the existing `desktop` user's XFCE session instead of
creating a separate D-Bus session. This proof targets `screen-0` and one
XFCE session per sandbox. The launcher rejects multiple sessions because it
cannot yet select a particular screen.

## Assertions

- Accessibility permission is granted and window surfaces are supported.
- The binary's embedded desktop and platform skills load successfully.
- A dedicated agent-desktop session scopes references across SDK calls.
- Fresh accessibility snapshots locate Calculator buttons by role/name.
- Semantic clicks and independent value reads verify every step of
  `C`, `7`, `+`, `5`, `=` through the final result `12`.
- UI commands disable SDK transport retries: a delivered action must not
  be replayed automatically. The example stops on failure.
- The agent-desktop session is ended and the sandbox is destroyed.

## Live findings (2026-11-02)

Tested using the user's CreateOS CLI account and the local SDK source on
Ubuntu 24.04, Xvfb, and XFCE. Without AT-SPI, `status` reported denied
accessibility and no supported surfaces. Installing `at-spi2-core` and
joining the desktop user's existing session enabled semantic automation.
The finished example also passed on a second, fresh sandbox with automatic
setup and cleanup; the complete scripted run took 27 seconds including
provisioning and package installation. This is not a performance benchmark.

The deployed image also needed an explicit desktop start. Its screen-state
directory differed from the running agent's expected directory: the SDK
screen list was empty and screenshots returned `screen_not_found` despite
the running desktop. That separate image mismatch is not patched here;
this example exercises semantic automation through command execution.

This is a scripted compatibility proof, not a model-driven agent benchmark.
It does not establish coverage for other applications, pause/resume,
multiple screens, or Chromium/Electron CDP integration. Production work
should bake the dependencies into a versioned image and repair screen
registration before combining semantic automation with noVNC/screenshots.

Upstream guides: [Introduction](https://agent-browser.dev/desktop),
[Skills](https://agent-browser.dev/desktop/skills), and
[Linux](https://agent-browser.dev/desktop/platforms/linux).
