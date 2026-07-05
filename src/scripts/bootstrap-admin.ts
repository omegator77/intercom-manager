/**
 * One-time setup: creates the first super admin account.
 * Refuses to run once any account already exists, since every account after
 * the first is meant to be created through an invite link, not this script.
 *
 * Usage: npm run bootstrap-admin -- <username> <password> <displayName>
 */
import '../config/load-env';
import { DbManagerCouchDb } from '../db/couchdb';
import { DbManagerMongoDb } from '../db/mongodb';
import { hashPassword } from '../password';

async function main() {
  const [username, password, displayName] = process.argv.slice(2);
  if (!username || !password || !displayName) {
    console.error(
      'Usage: npm run bootstrap-admin -- <username> <password> <displayName>'
    );
    process.exit(1);
  }

  const dbConnectionString =
    process.env.DB_CONNECTION_STRING ??
    process.env.MONGODB_CONNECTION_STRING ??
    'mongodb://localhost:27017/intercom-manager';
  const dbUrl = new URL(dbConnectionString);
  const dbManager =
    dbUrl.protocol === 'mongodb:' || dbUrl.protocol === 'mongodb+srv:'
      ? new DbManagerMongoDb(dbUrl)
      : new DbManagerCouchDb(dbUrl);

  await dbManager.connect();

  const existingUsers = await dbManager.getUsersCount();
  if (existingUsers > 0) {
    console.error(
      `Refusing to bootstrap: ${existingUsers} account(s) already exist. ` +
        'Create additional accounts through an invite link instead.'
    );
    await dbManager.disconnect();
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const user = await dbManager.createUser({
    username,
    passwordHash,
    displayName,
    isSuperAdmin: true,
    createdAt: new Date().toISOString()
  });

  console.log(`Created super admin "${user.username}" (id: ${user._id})`);
  await dbManager.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
