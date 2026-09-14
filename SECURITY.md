# security

This is experimental software with financial and code-execution boundaries. No independent security audit is claimed.

Do not put private keys, seed phrases, API tokens, personal credentials, tunnel tokens, operator journals or private browsing data in issues, pull requests or source files.

Use GitHub's private vulnerability reporting for sensitive reports when enabled. If unavailable, open a non-sensitive issue asking for a private reporting channel without disclosing an exploit or credential.

Public HTTP routes must remain read only. Model output and web content are untrusted input. They cannot authorize spending, change launch identity or access personal resources.

Cloning or starting the preview must not create credentials or move funds. Keep the operator engine disabled until configuration, isolation, budgeting and recovery have been independently verified.
