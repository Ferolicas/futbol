import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import { schemaTypes } from './sanity/schemaTypes';

export default defineConfig({
  name: 'cfanalisis',
  title: 'CFanalisis Studio',
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || '2fawn0zp',
  dataset: process.env.SANITY_DATASET || 'production',
  basePath: '/studio',

  plugins: [structureTool()],

  schema: {
    types: schemaTypes,
  },
});
