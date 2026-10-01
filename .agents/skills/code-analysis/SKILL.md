---
name: code-analysis
description: Guidelines and workflow for auditing codebases, analyzing architecture, and identifying potential security or performance issues.
---

# Code Analysis Guidelines

Follow this step-by-step workflow when auditing or reviewing code:
1. Identify the entry point, architecture, and core modules.
2. Check for security vulnerabilities (e.g. unvalidated inputs, command injection risks, exposed secrets).
3. Check for performance bottlenecks, uncaught asynchronous promises, and resource cleanup.
4. Verify error handling and graceful fallbacks.
5. Provide structured, prioritized recommendations (High, Medium, Low).
