import { Log } from '../log';
import {
  Ingest,
  Invite,
  Line,
  NewIngest,
  Production,
  ProductionMembership,
  User,
  UserSession
} from '../models';
import { assert } from '../utils';
import { DbManager } from './interface';
import nano from 'nano';

const SESSION_PRUNE_SECONDS = 7_200;

// Documents that live in the same database but are not productions/ingests,
// so they must be excluded from the whole-database scans used below.
const RESERVED_ID_PREFIXES = [
  'counter',
  'session_',
  'user_',
  'membership_',
  'invite_'
];
const isReservedId = (id: string): boolean => {
  const lower = id.toLowerCase();
  return RESERVED_ID_PREFIXES.some((prefix) => lower.indexOf(prefix) !== -1);
};

export class DbManagerCouchDb implements DbManager {
  private client;
  private nanoDb: nano.DocumentScope<unknown> | undefined;
  private dbConnectionUrl: URL;

  constructor(dbConnectionUrl: URL) {
    this.dbConnectionUrl = dbConnectionUrl;
    const server = new URL('/', this.dbConnectionUrl).toString();
    this.client = nano(server);
  }

  async connect(): Promise<void> {
    if (!this.nanoDb) {
      const dbList = await this.client.db.list();
      Log().debug('List of databases', dbList);
      const dbName = this.dbConnectionUrl.pathname.replace(/^\//, '');
      if (!dbList.includes(dbName)) {
        Log().info('Creating database', dbName);
        await this.client.db.create(dbName);
      }
      Log().info('Using database', dbName);
      this.nanoDb = this.client.db.use(
        this.dbConnectionUrl.pathname.replace(/^\//, '')
      );
      await this.ensureSessionIndexes();
      this.sessionPruneInterval();
    }
  }

  // This interval is used to track and remove sessions based on 'isExpired' flag, set in production_manager.
  // Deviates from mongoDB, which handles session pruning based on internal TTL index. This isn't supported by CouchDB.
  private sessionPruneInterval() {
    setInterval(async () => {
      try {
        const cutoff = new Date(
          Date.now() - SESSION_PRUNE_SECONDS * 1000
        ).toISOString();
        const sessions = await this.getSessionsByQuery({
          lastSeenAt: { $lt: cutoff } as any
        });
        for (const session of sessions) {
          const sessionId = session._id;
          await this.deleteUserSession(sessionId);
          Log().info(`Terminated session ${sessionId}`);
        }
      } catch (error: any) {
        Log().error(error);
      }
    }, 300_000); // runs every 5th minute
  }

  async disconnect(): Promise<void> {
    // CouchDB does not require a disconnection
  }

  private async getNextSequence(collectionName: string): Promise<number> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const counterDocId = `counter_${collectionName}`;
    interface CounterDoc {
      _id: string;
      _rev?: string;
      value: string;
    }
    let counterDoc: CounterDoc;

    try {
      counterDoc = (await this.nanoDb.get(counterDocId)) as CounterDoc;
      counterDoc.value = (parseInt(counterDoc.value) + 1).toString();
    } catch (error) {
      counterDoc = { _id: counterDocId, value: '1' };
    }
    await this.nanoDb.insert(counterDoc);
    return parseInt(counterDoc.value, 10);
  }

  /** Get all productions from the database in reverse natural order, limited by the limit parameter */
  async getProductions(limit: number, offset: number): Promise<Production[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const productions: Production[] = [];
    const response = await this.nanoDb.list({
      include_docs: true
    });
    // eslint-disable-next-line
    response.rows.forEach((row: any) => {
      if (!isReservedId(row.doc._id)) productions.push(row.doc);
    });

    // Apply offset and limit
    const result = productions.slice(offset, offset + limit);
    return result as any as Production[];
  }

  async getProductionsLength(): Promise<number> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const productions = await this.nanoDb.list({ include_docs: false });
    // Filter out counter, session and account related documents
    const filteredRows = productions.rows.filter(
      (row: any) => !isReservedId(row.id)
    );
    return filteredRows.length;
  }

  async getProduction(id: number): Promise<Production | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const production = await this.nanoDb.get(id.toString());
    // eslint-disable-next-line
    return production as any | undefined;
  }

  async updateProduction(
    production: Production
  ): Promise<Production | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const existingProduction = await this.nanoDb.get(production._id.toString());
    const updatedProduction = {
      ...existingProduction,
      ...production,
      _id: production._id.toString()
    };
    const response = await this.nanoDb.insert(updatedProduction);
    return response.ok ? production : undefined;
  }

  async addProduction(name: string, lines: Line[]): Promise<Production> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const _id = await this.getNextSequence('productions');
    if (_id === -1) {
      throw new Error('Failed to get next sequence');
    }
    const insertProduction = { name, lines, _id: _id.toString() };
    const response = await this.nanoDb.insert(
      insertProduction as unknown as nano.MaybeDocument
    );
    if (!response.ok) throw new Error('Failed to insert production');
    return { name, lines, _id } as Production;
  }

  async deleteProduction(productionId: number): Promise<boolean> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const production = await this.nanoDb.get(productionId.toString());
    const response = await this.nanoDb.destroy(production._id, production._rev);
    return response.ok;
  }

  async setLineConferenceId(
    productionId: number,
    lineId: string,
    conferenceId: string
  ): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const production = await this.getProduction(productionId);
    assert(production, `Production with id "${productionId}" does not exist`);
    const line = production.lines.find((line) => line.id === lineId);
    assert(
      line,
      `Line with id "${lineId}" does not exist for production with id "${productionId}"`
    );
    line.smbConferenceId = conferenceId;
    const existingProduction = await this.nanoDb.get(productionId.toString());
    const updatedProduction = {
      ...existingProduction,
      lines: production.lines
    };
    const response = await this.nanoDb.insert(updatedProduction);
    assert(
      response.ok,
      `Failed to update production with id "${productionId}"`
    );
  }

  async addIngest(newIngest: NewIngest): Promise<Ingest> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const _id = await this.getNextSequence('ingests');
    if (_id === -1) {
      throw new Error('Failed to get next sequence');
    }
    const insertIngest = {
      ...newIngest,
      _id: _id.toString()
    };
    const response = await this.nanoDb.insert(
      insertIngest as unknown as nano.MaybeDocument
    );
    if (!response.ok) throw new Error('Failed to insert ingest');
    return { ...newIngest, _id } as any;
  }

  /** Get all ingests from the database in reverse natural order, limited by the limit parameter */
  async getIngests(limit: number, offset: number): Promise<Ingest[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const ingests: Ingest[] = [];
    const response = await this.nanoDb.list({
      include_docs: true
    });
    // eslint-disable-next-line
    response.rows.forEach((row: any) => {
      if (!isReservedId(row.doc._id)) ingests.push(row.doc);
    });

    // Apply offset and limit
    const result = ingests.slice(offset, offset + limit);
    return result as any as Ingest[];
  }

  async getIngestsLength(): Promise<number> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const ingests = await this.nanoDb.list({ include_docs: false });
    // Filter out counter, session and account related documents
    const filteredRows = ingests.rows.filter(
      (row: any) => !isReservedId(row.id)
    );
    return filteredRows.length;
  }

  async getIngest(id: number): Promise<Ingest | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const ingest = await this.nanoDb.get(id.toString());
    // eslint-disable-next-line
    return ingest as any | undefined;
  }

  async updateIngest(ingest: Ingest): Promise<Ingest | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const existingIngest = await this.nanoDb.get(ingest._id.toString());
    const updatedIngest = {
      ...existingIngest,
      ...ingest,
      _id: ingest._id.toString()
    };
    const response = await this.nanoDb.insert(updatedIngest);
    return response.ok ? ingest : undefined;
  }

  async deleteIngest(ingestId: number): Promise<boolean> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const ingest = await this.nanoDb.get(ingestId.toString());
    const response = await this.nanoDb.destroy(ingest._id, ingest._rev);
    return response.ok;
  }

  // Session management methods

  // Helper method, to avoid condlicting _revs on simultaneous update requests
  private async insertWithRetry(doc: any, maxRetries = 3): Promise<any> {
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    // retries 3 times to fetch the latets doc and _rev, if all fail then throw error
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.nanoDb.insert(doc);
      } catch (error: any) {
        if (error.statusCode === 409 && attempt < maxRetries - 1) {
          const latestDoc = await this.nanoDb.get(doc._id);
          doc = { ...latestDoc, ...doc, _rev: latestDoc._rev };
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * Math.pow(2, attempt))
          );
        } else {
          throw error;
        }
      }
    }
  }

  async saveUserSession(
    sessionId: string,
    userSession: UserSession
  ): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    if (!sessionId.startsWith('session')) {
      sessionId = `session_${sessionId}`;
    }

    let existingDoc: any;

    // Check if document exists, if not creates new session
    try {
      existingDoc = await this.nanoDb.get(sessionId);
    } catch (error: any) {
      if (error.statusCode === 404) {
        existingDoc = { _id: sessionId };
      } else {
        throw error;
      }
    }
    const updatedSession = {
      ...existingDoc,
      ...userSession,
      lastSeenAt: new Date(Date.now()).toISOString(),
      _id: sessionId
    };
    await this.insertWithRetry(updatedSession);
  }

  async deleteUserSession(sessionId: string): Promise<boolean> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    if (!sessionId.startsWith('session')) {
      sessionId = `session_${sessionId}`;
    }
    const session = await this.nanoDb.get(sessionId);
    const response = await this.nanoDb.destroy(session._id, session._rev);
    return response.ok;
  }

  async getSession(sessionId: string): Promise<UserSession | null> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    if (!sessionId.startsWith('session')) {
      sessionId = `session_${sessionId}`;
    }
    const session = await this.nanoDb.get(sessionId);
    return session as any as UserSession;
  }

  async updateSession(
    sessionId: string,
    updates: Partial<UserSession>
  ): Promise<boolean> {
    await this.connect();

    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    if (!sessionId.startsWith('session')) {
      sessionId = `session_${sessionId}`;
    }
    const doc = await this.nanoDb.get(sessionId);

    const updateData: any = { ...updates };

    // converts lastSeen to a timestamp
    if ('lastSeen' in updates && typeof updates.lastSeen === 'number') {
      updateData.lastSeenAt = new Date(updates.lastSeen).toISOString();
    }

    // to ensure lastSeenAt is an ISO string Date object.
    if ('lastSeenAt' in updates && updates.lastSeenAt !== 'undefined') {
      const v = updates.lastSeenAt as any;
      updateData.lastSeenAt =
        v instanceof Date ? v.toISOString() : new Date(v).toISOString();
    }
    const updated = { ...doc, ...updateData };
    const res = await this.insertWithRetry(updated);
    return res.ok;
  }

  async getSessionsByQuery(q: Partial<UserSession>): Promise<UserSession[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const selector: any = { ...q };
    const response = await this.nanoDb.find({ selector, limit: 10000 }); // limit to 10000 sessions being queried
    return response.docs as unknown as UserSession[]; // could also expand type UserSession to avoid unknown
  }

  async ensureSessionIndexes(): Promise<void> {
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    // index for toInactivate, toReactivate, toExpire
    await (this.nanoDb as any).createIndex({
      index: {
        fields: ['isExpired', 'isActive']
      },
      name: 'idx_isExpired_isActive',
      ddoc: 'idx_isExpired_isActive',
      type: 'json'
    });

    // index for getUsersForLine()
    await (this.nanoDb as any).createIndex({
      index: {
        fields: ['isWhip', 'isExpired']
      },
      name: 'idx_isWhip_isExpired',
      ddoc: 'idx_isWhip_isExpired',
      type: 'json'
    });

    // index for getUsersForLine()
    await (this.nanoDb as any).createIndex({
      index: {
        fields: ['productionId', 'lineId', 'isExpired']
      },
      name: 'idx_prod_line_isExpired',
      ddoc: 'idx_prod_line_isExpired',
      type: 'json'
    });

    // index for getActiveUsers()
    await (this.nanoDb as any).createIndex({
      index: {
        fields: ['productionId', 'isActive']
      },
      name: 'idx_prod_isActive',
      ddoc: 'idx_prod_isActive',
      type: 'json'
    });
  }

  // Accounts, memberships and invites use a deterministic doc _id (a prefix
  // plus a natural or random unique key) so CouchDB's own doc-id uniqueness
  // guarantee enforces uniqueness, instead of a Mango index + racy read-check.

  async createUser(user: Omit<User, '_id'>): Promise<User> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const _id = `user_${user.username.toLowerCase()}`;
    const response = await this.nanoDb.insert({
      ...user,
      _id
    } as unknown as nano.MaybeDocument);
    if (!response.ok) throw new Error('Failed to insert user');
    return { ...user, _id };
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    try {
      const doc = await this.nanoDb.get(`user_${username.toLowerCase()}`);
      return doc as any as User;
    } catch (error: any) {
      if (error.statusCode === 404) return undefined;
      throw error;
    }
  }

  async getUserById(userId: string): Promise<User | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    try {
      const doc = await this.nanoDb.get(userId);
      return doc as any as User;
    } catch (error: any) {
      if (error.statusCode === 404) return undefined;
      throw error;
    }
  }

  async updateUserAlias(
    userId: string,
    alias: string | undefined
  ): Promise<User | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const existing = await this.nanoDb.get(userId);
    const updated = { ...existing, alias };
    if (!alias) delete (updated as any).alias;
    await this.insertWithRetry(updated);
    return this.getUserById(userId);
  }

  async getUsersCount(): Promise<number> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const response = await this.nanoDb.list({
      startkey: 'user_',
      endkey: 'user_￰'
    });
    return response.rows.length;
  }

  async createMembership(
    membership: Omit<ProductionMembership, '_id'>
  ): Promise<ProductionMembership> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const _id = `membership_${membership.userId}_${membership.productionId}`;
    const response = await this.nanoDb.insert({
      ...membership,
      _id
    } as unknown as nano.MaybeDocument);
    if (!response.ok) throw new Error('Failed to insert membership');
    return { ...membership, _id };
  }

  async getMembership(
    userId: string,
    productionId: number
  ): Promise<ProductionMembership | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    try {
      const doc = await this.nanoDb.get(`membership_${userId}_${productionId}`);
      return doc as any as ProductionMembership;
    } catch (error: any) {
      if (error.statusCode === 404) return undefined;
      throw error;
    }
  }

  async getMembershipsForUser(userId: string): Promise<ProductionMembership[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const response = await this.nanoDb.list({
      startkey: `membership_${userId}_`,
      endkey: `membership_${userId}_￰`,
      include_docs: true
    });
    return response.rows.map((row: any) => row.doc) as ProductionMembership[];
  }

  async getMembershipsForProduction(
    productionId: number
  ): Promise<ProductionMembership[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    // The doc id is keyed by userId first, so a production-scoped lookup
    // has to scan the membership_ prefix and filter in memory.
    const response = await this.nanoDb.list({
      startkey: 'membership_',
      endkey: 'membership_￰',
      include_docs: true
    });
    return response.rows
      .map((row: any) => row.doc as ProductionMembership)
      .filter((doc) => doc.productionId === productionId);
  }

  async updateMembershipRole(
    userId: string,
    productionId: number,
    role: ProductionMembership['role']
  ): Promise<ProductionMembership | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const existing = await this.nanoDb.get(
      `membership_${userId}_${productionId}`
    );
    await this.insertWithRetry({ ...existing, role });
    return this.getMembership(userId, productionId);
  }

  async deleteMembership(
    userId: string,
    productionId: number
  ): Promise<boolean> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const doc = await this.nanoDb.get(`membership_${userId}_${productionId}`);
    const response = await this.nanoDb.destroy(doc._id, doc._rev);
    return response.ok;
  }

  async createInvite(invite: Omit<Invite, '_id'>): Promise<Invite> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const _id = `invite_${invite.token}`;
    const response = await this.nanoDb.insert({
      ...invite,
      _id
    } as unknown as nano.MaybeDocument);
    if (!response.ok) throw new Error('Failed to insert invite');
    return { ...invite, _id };
  }

  async getInviteByToken(token: string): Promise<Invite | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    try {
      const doc = await this.nanoDb.get(`invite_${token}`);
      return doc as any as Invite;
    } catch (error: any) {
      if (error.statusCode === 404) return undefined;
      throw error;
    }
  }

  async markInviteUsed(token: string, userId: string): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const existing = await this.nanoDb.get(`invite_${token}`);
    await this.insertWithRetry({
      ...existing,
      usedBy: userId,
      usedAt: new Date().toISOString()
    });
  }
}
