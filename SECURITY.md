# Security Policy

## Supported versions

Security fixes land on the latest minor release.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | Yes       |
| < 0.3   | No        |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

The preferred channel is GitHub's private vulnerability reporting. On this
repository, open the **Security** tab, choose **Report a vulnerability**, and
file a private advisory. No email is required, and the report stays
confidential until a fix is published.

If you cannot use GitHub Security Advisories, email
<SECURITY_CONTACT_EMAIL> instead.

Please include enough detail to reproduce: affected version, runtime, a minimal
proof of concept, and the impact you observed.

We aim to acknowledge reports within **72 hours** and will keep you updated as
we investigate and prepare a fix. We will coordinate disclosure timing with you.

## Dependency attack surface

This SDK has **zero runtime dependencies**, so it ships no third-party code to
consumers. Its dependency attack surface is **build-time only** (the `oxlint`,
`oxfmt`, and `typescript` tooling in `devDependencies`).
