import { nxE2EPreset } from '@nx/cypress/plugins/cypress-preset';
import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3003',
    ...nxE2EPreset(__filename, {
      cypressDir: 'src',
      webServerCommands: { default: 'nx run navigation:start' },
      ciWebServerCommand: 'nx run navigation:serve-static',
    }),
    // Please ensure you use `cy.origin()` when navigating between domains and remove this option.
    // See https://docs.cypress.io/app/references/migration-guide#Changes-to-cyorigin
    injectDocumentDomain: true,
    retries: {
      runMode: 2, // Retries failed tests up to 2 additional times in CLI runs (total 3 attempts)
      openMode: 0, // No retries when running via the Cypress Test Runner GUI
    },
  },
});
