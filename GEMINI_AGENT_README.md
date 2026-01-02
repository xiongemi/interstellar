# Interstellar Project Overview for Gemini Agent

This document provides a summary of the Interstellar project, its structure, and its CI/CD optimization strategies, based on the user-provided blog post.

## Project Overview

*   **Name:** Interstellar
*   **Type:** Large-scale Nx monorepo.
*   **Structure:**
    *   115 projects in total.
    *   5 Next.js applications (`/apps`).
    *   5 Cypress E2E test applications (`/apps`).
    *   105 shared TypeScript libraries (`/libs`).
*   **CI Commands:** The pipeline uses `nx affected` to run tasks only for projects impacted by changes:
    *   `yarn nx affected -t lint`
    *   `yarn nx affected -t test`
    *   `yarn nx affected -t build`
    *   `yarn nx affected -t e2e`

## Goal: CI Optimization

The primary goal is to significantly reduce CI runtime and cost by leveraging the built-in caching mechanisms of the tools used in the repository, without relying on paid SaaS or remote caching services.

## Caching Strategies

### 1. ESLint

*   **Technique:** Use ESLint's built-in caching to avoid re-linting unchanged files.
*   **Implementation:**
    *   Enable the `--cache` flag.
    *   Set `--cache-strategy` to `content` to base the cache on file content hashes, not timestamps.
    *   Persist the `.eslintcache` file(s) across CI runs using `actions/cache`.
*   **Nx Configuration (`nx.json`):**
    ```json
    "lint": {
      "options": {
        "cache": true,
        "cache-strategy": "content"
      }
    }
    ```

### 2. Jest

*   **Technique:** Use Jest's cache to reuse transformation results and test outcomes.
*   **Implementation:**
    *   Enable the `--cache` flag.
    *   Specify a consistent `cacheDirectory` (e.g., `<rootDir>/.jest/cache`).
    *   Persist this directory across CI runs using `actions/cache`.
*   **Jest Configuration (`jest.preset.js`):**
    ```javascript
    module.exports = {
      // ...
      cacheDirectory: '<rootDir>/.jest/cache',
    };
    ```

### 3. Cypress & Playwright (E2E Tests)

*   **Technique:** Cache the browser binaries to avoid downloading them on every CI run.
*   **Implementation:**
    *   **Cypress:** Cache the `~/.cache/Cypress` directory.
    *   **Playwright:** Cache the `~/.cache/ms-playwright` directory.

### Monorepo-Specific Challenges

*   Simple Git-based change detection (like `jest --changedSince` or `find-cypress-specs`) is **not reliable** in this monorepo. It doesn't understand the deep dependency graph and can miss running tests for projects affected by a change in a shared library.
*   The correct approach is to use `nx affected`, which accurately determines the projects impacted by a change.