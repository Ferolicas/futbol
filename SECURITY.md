# Security policy

## Reporting a vulnerability

Do not open a public issue with exploit details, credentials, personal data or
payment information. Use GitHub's private vulnerability reporting for this
repository. Include the affected route or component, reproduction steps and
the impact you observed.

The owner triages reports within 2 business days. Confirmed critical issues
target containment within 4 hours and remediation or a compensating control
within 24 hours. These are operational targets, not a bug-bounty promise.

## Supported version

Only the revision deployed from the `main` branch is supported. Secrets must
never be committed; leaked credentials are revoked and rotated even if the
commit is later removed.
