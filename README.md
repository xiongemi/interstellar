# Nx Agents Demo

#### On how to make your CI 10 times faster with a single line change

This repo shows how using Nx Managed Agents you can distribute your CI reducing its time from hours to minutes.

## Video

<br>
<a href="https://youtu.be/KPCMg_Dn0EoE">
<img src="readme-resources/video-thumbnail.png" alt='video' width="600">
</a>
<br>

## Repository Structure

This repository is a monorepo built with [Nx](https://nx.dev) to demonstrate the capabilities of Nx Agents for distributed CI. It is structured with a set of applications and shared libraries, simulating a real-world, large-scale project.

The repository contains:
- **5 Next.js Applications**: These are the main front-end applications of the project, found under the `apps` directory.
- **5 Cypress Applications**: Each Next.js app has a corresponding end-to-end testing suite under the `apps` directory, built with Cypress.
- **6 Shared Libraries**: These are located in the `libs` directory and contain shared components and logic used across the different applications.

## Baseline

The CI for this repo is implemented as follows:

```bash
yarn nx affected -t lint --parallel=3 && \
yarn nx affected -t test --parallel=3 && \
yarn nx affected -t build --parallel=3 && \
yarn nx affected -t e2e --parallel=1
```

The job takes 87 minutes.

<br>
<img src="readme-resources/one-agent-time.png" alt='diagram showing github actions' width="600">
<br>

## Enabling Distribution

### Distribution

To enable distribution we need to make sure our repo is connected to Nx Cloud (which we can do by running `nx connect`). After that we need to add the following line to our CI config:

```
npx nx-cloud start-ci-run --distributes-on="15 linux-medium-plus-js" --stop-agents-after="e2e-ci"
```

This informs Nx that we can distribute commands using 15 linux VMs.

### Splitting E2E tests

Some Nx plugins (e.g., Cypress and Playwright) can automatically split expensive tasks into smaller, cheaper tasks, than can run in parallel. This means that even if you have a single suite of Cypress tests that takes, say, 10 minutes to run. Nx is able to split it into smaller tasks, which can take, say 1 minute to run each.

We enable that we need to change `npx nx affected -t e2e --parallel 1` to `npx nx affected -t e2e-ci --parallel 1`.

The updated job takes 9 minutes.

<br>
<img src="readme-resources/cipe.png" alt='diagram showing cipe' width="600">
<br>

Machine utilization was even:

<br>
<img src="readme-resources/utilization.png" alt='diagram showing cipe' width="600">
<br>

### Advanced Caching Strategy

In addition to distributing tasks, this repository employs an advanced caching strategy for build and test artifacts to further optimize CI performance.

The standard `actions/cache` in GitHub Actions is often used to cache dependencies based on lock files (e.g., `yarn.lock`). While useful, this approach doesn't work well for caching the *outputs* of build, lint, or test runs, as the cache would be invalidated too frequently by source code changes.

To address this, we use a custom caching mechanism that saves caches only when their content has actually changed. This is implemented via a reusable composite action located at `.github/actions/save-cache-with-hash`.

#### How It Works

1.  **Restore Cache**: At the beginning of a job, we restore the caches for `eslint`, `jest`, `next`, and `tsconfig` build info using `actions/cache/restore@v4`.
2.  **Run Tasks**: The `lint`, `test`, and `build` jobs are executed. These tasks may or may not modify the cached artifacts.
3.  **Compute Hash and Save**: After the tasks run, our custom `save-cache-with-hash` action computes a hash of the contents of the directories/files to be cached. If this hash is different from what's stored, it means the content has changed, and a new version of the cache is saved.

This is what a step using the composite action looks like in `.github/workflows/actions.yml`:

```yaml
      - name: Save Jest cache
        uses: ./.github/actions/save-cache-with-hash
        with:
          path: '**/.jest/cache'
          key: jest-${{ hashFiles('**/jest.config.js') }}
```

This strategy ensures that we are not re-uploading large cache artifacts on every run, saving time and network bandwidth, while still ensuring that subsequent jobs have access to the latest built outputs when they do change.

## What About Remote Caching?

Nx supports remote computation caching, but it doesn't help this particular case. Remote caching ONLY helps with the average case, where some tasks are cached and some are not. In the worst case scenario nothing is cached. The only way to make the worst case scenario fast is to distribute. **And you have to distribute.** If you average CI time is 10 mins, but your worst case CI time (which say happens every couple of days) is 4 hours, it is still unusable.

## Intelligent Distribution

Nx knows what commands your CI is running. It also knows how many agents you typically use, and how long each task in
your workspace typically takes. Nx uses this information to create an execution plan. For instance, it knows that tests
do not depend on each other, whereas we need to build the shared libraries first. Nx knows that the theoretical limit of
how fast your CI can get is `slowest build of shared lib + slowest build of app`, so it will prioritize building shared
libs to unblock the apps.

After you run your CI a couple of times, Nx will learn stats about your workspace, and your CI will be more or less as
fast as it can be given the provided agents. If you change the number of agents, Nx will rebalance the work. As you keep
changing your repo, Nx will keep its understanding of it up to date and will keep your CI fast.

Nx can also size your PR to see how many agents will be required to run the CI and use an appropriate number of agents.

**This all happens without you having to do anything.**

## Other Benchmarks

This is a complementary benchmark to [this one measuring local workspace analysis and cache restoration of Nx and Turborepo](https://github.com/vsavkin/large-monorepo/)
. Nx is 6 times faster.

The reason why this repo isn’t a comparison to, say, Turborepo or any other monorepo tool is that no other tool used by the JS community (including Turborepo) supports distribution.

Comparisons are easy to understand. If Tool A is 9 times faster than Tool B, then A is better. But if there is no B, it’s hard to explain why A is really cool.

Local and remote caching are useful, but distribution is truly transformative. Unfortunately, unless you worked at Google/Facebook/etc you won't know that that's the case. This repo is my attempt to show why distribution is a gamer changer for a lot of projects.
