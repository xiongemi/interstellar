# Interstellar

## Repository Structure

This repository is a monorepo built with [Nx](https://nx.dev). It is structured with a set of applications and shared libraries, simulating a real-world, large-scale project.

The repository contains:
- **5 Next.js Applications**: These are the main front-end applications of the project, found under the `apps` directory.
- **5 Cypress Applications**: Each Next.js app has a corresponding end-to-end testing suite under the `apps` directory, built with Cypress.
- **6 Shared Library Folders (95 Libraries)**: These are located in the `libs` directory and contain shared components and logic used across the different applications.

## Baseline

The CI for this repo is implemented as follows:

```bash
yarn nx affected -t lint --parallel=3
yarn nx affected -t test --parallel=3
yarn nx affected -t build --parallel=3
yarn nx affected -t e2e --parallel=1
```