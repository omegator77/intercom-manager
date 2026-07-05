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

export interface DbManager {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getProduction(id: number): Promise<Production | undefined>;
  getProductions(limit: number, offset: number): Promise<Production[]>;
  getProductionsLength(): Promise<number>;
  updateProduction(production: Production): Promise<Production | undefined>;
  addProduction(name: string, lines: Line[]): Promise<Production>;
  deleteProduction(productionId: number): Promise<boolean>;
  setLineConferenceId(
    productionId: number,
    lineId: string,
    conferenceId: string
  ): Promise<void>;
  addIngest(newIngest: NewIngest): Promise<Ingest>;
  getIngest(id: number): Promise<Ingest | undefined>;
  getIngestsLength(): Promise<number>;
  getIngests(limit: number, offset: number): Promise<Ingest[]>;
  updateIngest(ingest: Ingest): Promise<Ingest | undefined>;
  deleteIngest(ingestId: number): Promise<boolean>;
  saveUserSession(sessionId: string, userSession: UserSession): Promise<void>;
  getSession(sessionId: string): Promise<UserSession | null>;
  deleteUserSession(sessionId: string): Promise<boolean>;
  updateSession(
    sessionId: string,
    updates: Partial<UserSession>
  ): Promise<boolean>;
  getSessionsByQuery(q: Partial<UserSession>): Promise<UserSession[]>;

  createUser(user: Omit<User, '_id'>): Promise<User>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserById(userId: string): Promise<User | undefined>;
  updateUserAlias(
    userId: string,
    alias: string | undefined
  ): Promise<User | undefined>;
  getUsersCount(): Promise<number>;

  createMembership(
    membership: Omit<ProductionMembership, '_id'>
  ): Promise<ProductionMembership>;
  getMembership(
    userId: string,
    productionId: number
  ): Promise<ProductionMembership | undefined>;
  getMembershipsForUser(userId: string): Promise<ProductionMembership[]>;

  createInvite(invite: Omit<Invite, '_id'>): Promise<Invite>;
  getInviteByToken(token: string): Promise<Invite | undefined>;
  markInviteUsed(token: string, userId: string): Promise<void>;
}
