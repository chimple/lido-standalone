import { Config } from '@stencil/core';

// https://stenciljs.com/docs/config

export const config: Config = {
  namespace: 'lido-standalone',
  extras: {
    enableImportInjection: true,
  },
  outputTargets: [
    {
      type: 'dist',
      esmLoaderPath: '../loader',
    },
    {
      type: 'dist-custom-elements',
      customElementsExportBehavior: 'auto-define-custom-elements',
      externalRuntime: false,
    },
    {
      type: 'docs-readme',
    },
    {
      type: 'www',
      // comment the following line to disable service workers in production
      serviceWorker: null,
    },
  ],
  testing: {
    browserHeadless: 'new',
  },
};
