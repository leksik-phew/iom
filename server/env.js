import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Resolve relative to the project, even when Node starts from another directory.
// Existing process variables take precedence over values in the optional file.
try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
