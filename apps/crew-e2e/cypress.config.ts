import { nxE2EPreset } from '@nx/cypress/plugins/cypress-preset';
import { defineConfig } from 'cypress';

const preset = nxE2EPreset(__filename, {
  cypressDir: 'src',
  webServerCommands: { default: 'nx run crew:start' },
  ciWebServerCommand: 'nx run crew:serve-static',
});

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3001',
    ...preset,
    // Please ensure you use `cy.origin()` when navigating between domains and remove this option.
    // See https://docs.cypress.io/app/references/migration-guide#Changes-to-cyorigin
    injectDocumentDomain: true,
    retries: {
      runMode: 2, // Retries failed tests up to 2 additional times in CLI runs (total 3 attempts)
      openMode: 0, // No retries when running via the Cypress Test Runner GUI
    },
    // Disable video to reduce resource usage and I/O during cleanup
    video: false,
    // Browser launch arguments to handle X server cleanup more gracefully
    setupNodeEvents(on, config) {
      // Call preset's setupNodeEvents if it exists
      if (preset.setupNodeEvents) {
        preset.setupNodeEvents(on, config);
      }
      
      // Add our custom browser launch options
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.family === 'chromium' && browser.name !== 'electron') {
          launchOptions.args.push('--disable-gpu');
          launchOptions.args.push('--no-sandbox');
          launchOptions.args.push('--disable-dev-shm-usage');
          // Suppress X connection errors during cleanup
          launchOptions.args.push('--disable-background-networking');
          launchOptions.args.push('--disable-background-timer-throttling');
          launchOptions.args.push('--disable-renderer-backgrounding');
        }
        if (browser.name === 'electron') {
          // Electron-specific options to handle cleanup
          launchOptions.preferences = {
            ...launchOptions.preferences,
            'disable-gpu-sandbox': true,
          };
        }
        return launchOptions;
      });
      return config;
    },
  },
});
