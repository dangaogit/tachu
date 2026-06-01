# Security Policy

## ⚠️ Release Candidate Disclaimer
**IMPORTANT:** `tachu` is currently at **`1.0.0-rc.0`**. This is a stabilization candidate for `1.0.0`, not a final stable release.

As such:
- The codebase has not yet undergone a formal security audit.
- Security vulnerabilities may still exist.
- We **strongly advise against** using this version in production environments or for handling sensitive, mission-critical data without your own review.

---

## Supported Versions

During the release-candidate phase, we only provide security updates for the most recent release.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.0-rc.x | :white_check_mark: Yes |
| < 1.0.0-rc.0 | :x: No                |

---

## Reporting a Vulnerability

We value the work of security researchers and the community in improving the security of `tachu`. To protect our users, we ask that you **do not report security vulnerabilities via public GitHub issues.**

### How to Report
Please report security-related issues by following these steps:

1.  **Email Us:** Send a detailed report to `dangaogm@gmail.com`.
2.  **Information Needed:** - A description of the vulnerability.
    - Potential impact and attack vectors.
    - Steps to reproduce (including scripts or screenshots if possible).
3.  **Encrypted Communication:** If you wish to encrypt your report, please contact us at the email above to request a PGP key.

### Our Response Process
- **Acknowledgment:** You will receive an acknowledgment of your report within **48–72 hours**.
- **Investigation:** We will investigate the issue and keep you informed of our progress.
- **Fix:** For valid vulnerabilities, we will prioritize a fix in the next release or via a direct commit to the `main` branch.
- **Disclosure:** Once the fix is released, we will coordinate with you to publicly disclose the vulnerability if necessary.

---

## Our Commitment
If you follow this policy and report vulnerabilities responsibly:
- We will work with you to understand and resolve the issue quickly.
- We will not pursue any legal action against you.
- We will provide credit in our `CHANGELOG` or release notes to recognize your contribution (unless you prefer to remain anonymous).

---

## Security Best Practices for Early Adopters
While we work on hardening the project, we recommend that early adopters:
- Run the application in an isolated environment (e.g., Docker, VM, or Sandbox).
- Apply the "Principle of Least Privilege" (PoLP) when granting system permissions.
- Regularly check for updates and sync with the latest `main` branch changes.

---

*This policy is subject to change as the project moves toward a stable 1.0.0 release.*
