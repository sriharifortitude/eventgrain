import { existsSync } from 'node:fs';

// Local development keeps settings in .env; deployments and CI set real
// environment variables and have no file. Imported first by every entry point.
if (existsSync('.env')) process.loadEnvFile('.env');
