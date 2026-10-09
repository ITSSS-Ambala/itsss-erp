import { workspaceDatabase } from './hostinger/database.ts';
import { privateBucket } from './hostinger/storage.ts';
// Private configuration and disk storage initialize only at runtime.
export const env = {
  DB: workspaceDatabase,
  BUCKET: privateBucket,
  get ERP_VAULT_KEY() { return process.env.ERP_VAULT_KEY; },
};
