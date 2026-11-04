import { Config } from '@stencil/core';
import path from 'path';

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
      copy: [
        {
          src: path.resolve(
            __dirname,
            'node_modules/lido-player/dist/collection/assets/offline-assets/fonts/Baloo-Bhai-2',
          ),
          dest: 'assets/offline-assets/fonts/Baloo-Bhai-2',
        },
      ],
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
