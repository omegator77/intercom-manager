import api from './api';
import { CoreFunctions } from './api_productions_core_functions';
import { ConnectionQueue } from './connection_queue';
import { hashPassword } from './password';

jest.mock('./db/interface', () => ({
  getIngests: jest.fn().mockResolvedValue([]),
  connect: jest.fn()
}));

jest.mock('./ingest_manager', () => {
  return {
    IngestManager: jest.fn().mockImplementation(() => ({
      load: jest.fn().mockResolvedValue(undefined),
      startPolling: jest.fn()
    }))
  };
});

jest.mock('./db/mongodb');

const mockDbManager = {
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  getProduction: jest.fn().mockResolvedValue(undefined),
  getProductions: jest.fn().mockResolvedValue([]),
  getProductionsLength: jest.fn().mockResolvedValue(0),
  updateProduction: jest.fn().mockResolvedValue(undefined),
  addProduction: jest.fn().mockResolvedValue({}),
  deleteProduction: jest.fn().mockResolvedValue(true),
  setLineConferenceId: jest.fn().mockResolvedValue(undefined),
  addIngest: jest.fn().mockResolvedValue({}),
  getIngest: jest.fn().mockResolvedValue(undefined),
  getIngestsLength: jest.fn().mockResolvedValue(0),
  getIngests: jest.fn().mockResolvedValue([]),
  updateIngest: jest.fn().mockResolvedValue(undefined),
  deleteIngest: jest.fn().mockResolvedValue(true),
  saveUserSession: jest.fn().mockResolvedValue(undefined),
  getSession: jest.fn().mockResolvedValue(null),
  deleteUserSession: jest.fn().mockResolvedValue(true),
  updateSession: jest.fn().mockResolvedValue(true),
  getSessionsByQuery: jest.fn().mockResolvedValue([]),
  createUser: jest.fn(),
  getUserByUsername: jest.fn().mockResolvedValue(undefined),
  getUserById: jest.fn().mockResolvedValue(undefined),
  updateUserAlias: jest.fn(),
  getUsersCount: jest.fn().mockResolvedValue(0),
  createMembership: jest.fn(),
  getMembership: jest.fn().mockResolvedValue(undefined),
  getMembershipsForUser: jest.fn().mockResolvedValue([]),
  createInvite: jest.fn(),
  getInviteByToken: jest.fn().mockResolvedValue(undefined),
  markInviteUsed: jest.fn().mockResolvedValue(undefined),
  getMembershipsForProduction: jest.fn().mockResolvedValue([]),
  updateMembershipRole: jest.fn().mockResolvedValue(undefined),
  deleteMembership: jest.fn().mockResolvedValue(true)
};

const mockProductionManager = {
  checkUserStatus: jest.fn(),
  load: jest.fn().mockResolvedValue(undefined),
  createProduction: jest.fn().mockResolvedValue({}),
  getProductions: jest.fn().mockResolvedValue([]),
  getNumberOfProductions: jest.fn().mockResolvedValue(0),
  requireProduction: jest.fn().mockResolvedValue({}),
  updateProduction: jest.fn().mockResolvedValue({}),
  addProductionLine: jest.fn().mockResolvedValue(undefined),
  getLine: jest.fn().mockResolvedValue(undefined),
  getUsersForLine: jest.fn().mockResolvedValue([]),
  updateProductionLine: jest.fn().mockResolvedValue({}),
  deleteProductionLine: jest.fn().mockResolvedValue(undefined),
  deleteProduction: jest.fn().mockResolvedValue(true),
  removeUserSession: jest.fn().mockResolvedValue('session-id'),
  getUser: jest.fn().mockResolvedValue(undefined),
  requireLine: jest.fn().mockResolvedValue({}),
  updateUserLastSeen: jest.fn().mockResolvedValue(true),
  getProduction: jest.fn().mockResolvedValue(undefined),
  setLineId: jest.fn().mockResolvedValue(undefined),
  createUserSession: jest.fn(),
  updateUserEndpoint: jest.fn().mockResolvedValue(true),
  on: jest.fn(),
  once: jest.fn(),
  emit: jest.fn()
} as any;

const mockIngestManager = {
  load: jest.fn().mockResolvedValue(undefined),
  startPolling: jest.fn()
} as any;

describe('auth api', () => {
  let server: any;

  beforeAll(async () => {
    server = await api({
      title: 'my awesome service',
      smbServerBaseUrl: 'http://localhost',
      endpointIdleTimeout: '60',
      publicHost: 'https://example.com',
      jwtSecret: 'test-secret',
      dbManager: mockDbManager,
      productionManager: mockProductionManager,
      ingestManager: mockIngestManager,
      coreFunctions: new CoreFunctions(
        mockProductionManager,
        new ConnectionQueue()
      )
    });
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function cookieFor(userId: string, username: string): string {
    return `auth_token=${server.jwt.sign({ userId, username })}`;
  }

  describe('POST /auth/login', () => {
    test('logs in with correct credentials and sets a cookie', async () => {
      mockDbManager.getUserByUsername.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: await hashPassword('correct-horse'),
        displayName: 'Alice',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: 'unused',
        displayName: 'Alice',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembershipsForUser.mockResolvedValueOnce([
        { _id: 'm1', userId: 'user-1', productionId: 1, role: 'producer' }
      ]);

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        body: { username: 'alice', password: 'correct-horse' }
      });

      expect(response.statusCode).toBe(200);
      expect(response.cookies.some((c: any) => c.name === 'auth_token')).toBe(
        true
      );
      const body = JSON.parse(response.body);
      expect(body.user).toEqual({
        id: 'user-1',
        username: 'alice',
        displayName: 'Alice',
        alias: undefined,
        isSuperAdmin: undefined
      });
      expect(body.memberships).toEqual([{ productionId: 1, role: 'producer' }]);
    });

    test('rejects wrong password', async () => {
      mockDbManager.getUserByUsername.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: await hashPassword('correct-horse'),
        displayName: 'Alice',
        createdAt: '2024-01-01T00:00:00.000Z'
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        body: { username: 'alice', password: 'wrong' }
      });

      expect(response.statusCode).toBe(401);
    });

    test('rejects unknown username', async () => {
      mockDbManager.getUserByUsername.mockResolvedValueOnce(undefined);

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        body: { username: 'ghost', password: 'whatever' }
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    test('returns 401 without a login cookie', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/me'
      });
      expect(response.statusCode).toBe(401);
    });

    test('returns the logged in user', async () => {
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: 'unused',
        displayName: 'Alice',
        alias: 'Al',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembershipsForUser.mockResolvedValueOnce([]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: cookieFor('user-1', 'alice') }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user.alias).toBe('Al');
    });
  });

  describe('PATCH /auth/me', () => {
    test('updates the alias for the logged in user', async () => {
      // The handler calls updateUserAlias, then builds the response from a
      // single getUserById call - only one mock value should be queued here.
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: 'unused',
        displayName: 'Alice',
        alias: 'Ally',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembershipsForUser.mockResolvedValueOnce([]);

      const response = await server.inject({
        method: 'PATCH',
        url: '/api/v1/auth/me',
        headers: { cookie: cookieFor('user-1', 'alice') },
        body: { alias: 'Ally' }
      });

      expect(response.statusCode).toBe(200);
      expect(mockDbManager.updateUserAlias).toHaveBeenCalledWith(
        'user-1',
        'Ally'
      );
    });
  });

  describe('POST /auth/invite', () => {
    test('rejects when not logged in', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        body: { productionId: 1, role: 'participant' }
      });
      expect(response.statusCode).toBe(401);
    });

    test('rejects a participant trying to create an invite', async () => {
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-2',
        username: 'bob',
        passwordHash: 'unused',
        displayName: 'Bob',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembership.mockResolvedValueOnce({
        _id: 'm2',
        userId: 'user-2',
        productionId: 1,
        role: 'participant'
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { cookie: cookieFor('user-2', 'bob') },
        body: { productionId: 1, role: 'participant' }
      });

      expect(response.statusCode).toBe(403);
    });

    test('lets a production admin create an invite link', async () => {
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: 'unused',
        displayName: 'Alice',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembership.mockResolvedValueOnce({
        _id: 'm1',
        userId: 'user-1',
        productionId: 1,
        role: 'admin'
      });
      mockDbManager.createInvite.mockResolvedValueOnce({
        _id: 'i1',
        token: 'abc123',
        productionId: 1,
        role: 'participant',
        createdBy: 'user-1',
        expiresAt: '2099-01-01T00:00:00.000Z'
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { cookie: cookieFor('user-1', 'alice') },
        body: { productionId: 1, role: 'participant' }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.token).toBe('abc123');
      expect(body.url).toBe('https://example.com/invite/abc123');
    });
  });

  describe('GET /auth/invite/:token', () => {
    test('returns 404 for an unknown token', async () => {
      mockDbManager.getInviteByToken.mockResolvedValueOnce(undefined);
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/invite/does-not-exist'
      });
      expect(response.statusCode).toBe(404);
    });

    test('returns 410 for an already used invite', async () => {
      mockDbManager.getInviteByToken.mockResolvedValueOnce({
        _id: 'i1',
        token: 'used',
        productionId: 1,
        role: 'participant',
        createdBy: 'user-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        usedBy: 'someone'
      });
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/invite/used'
      });
      expect(response.statusCode).toBe(410);
    });

    test('returns invite metadata for a valid token', async () => {
      mockDbManager.getInviteByToken.mockResolvedValueOnce({
        _id: 'i1',
        token: 'abc123',
        productionId: 1,
        role: 'participant',
        createdBy: 'user-1',
        expiresAt: '2099-01-01T00:00:00.000Z'
      });
      mockDbManager.getProduction.mockResolvedValueOnce({
        _id: 1,
        name: 'prod-1',
        lines: []
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/invite/abc123'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        productionId: 1,
        productionName: 'prod-1',
        role: 'participant'
      });
    });
  });

  describe('POST /auth/invite/:token/accept', () => {
    test('rejects an already used invite', async () => {
      mockDbManager.getInviteByToken.mockResolvedValueOnce({
        _id: 'i1',
        token: 'used',
        productionId: 1,
        role: 'participant',
        createdBy: 'user-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        usedBy: 'someone'
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/invite/used/accept',
        body: { username: 'carol', password: 'pw', displayName: 'Carol' }
      });

      expect(response.statusCode).toBe(410);
    });

    test('rejects a taken username', async () => {
      mockDbManager.getInviteByToken.mockResolvedValueOnce({
        _id: 'i1',
        token: 'abc123',
        productionId: 1,
        role: 'participant',
        createdBy: 'user-1',
        expiresAt: '2099-01-01T00:00:00.000Z'
      });
      mockDbManager.getUserByUsername.mockResolvedValueOnce({
        _id: 'existing',
        username: 'carol'
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/invite/abc123/accept',
        body: { username: 'carol', password: 'pw', displayName: 'Carol' }
      });

      expect(response.statusCode).toBe(400);
    });

    test('creates the account, membership and logs in on success', async () => {
      mockDbManager.getInviteByToken.mockResolvedValueOnce({
        _id: 'i1',
        token: 'abc123',
        productionId: 1,
        role: 'producer',
        createdBy: 'user-1',
        expiresAt: '2099-01-01T00:00:00.000Z'
      });
      mockDbManager.getUserByUsername.mockResolvedValueOnce(undefined);
      mockDbManager.createUser.mockResolvedValueOnce({
        _id: 'new-user',
        username: 'carol',
        displayName: 'Carol',
        passwordHash: 'hashed',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'new-user',
        username: 'carol',
        displayName: 'Carol',
        passwordHash: 'hashed',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembershipsForUser.mockResolvedValueOnce([
        { _id: 'm3', userId: 'new-user', productionId: 1, role: 'producer' }
      ]);

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/invite/abc123/accept',
        body: { username: 'carol', password: 'pw', displayName: 'Carol' }
      });

      expect(response.statusCode).toBe(200);
      expect(mockDbManager.createMembership).toHaveBeenCalledWith({
        userId: 'new-user',
        productionId: 1,
        role: 'producer'
      });
      expect(mockDbManager.markInviteUsed).toHaveBeenCalledWith(
        'abc123',
        'new-user'
      );
      expect(response.cookies.some((c: any) => c.name === 'auth_token')).toBe(
        true
      );
    });
  });

  describe('GET /production/:productionId/members', () => {
    test('rejects when not logged in', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/production/1/members'
      });
      expect(response.statusCode).toBe(401);
    });

    test('rejects a producer (only admins manage members)', async () => {
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-2',
        username: 'bob',
        passwordHash: 'unused',
        displayName: 'Bob',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembership.mockResolvedValueOnce({
        _id: 'm2',
        userId: 'user-2',
        productionId: 1,
        role: 'producer'
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/production/1/members',
        headers: { cookie: cookieFor('user-2', 'bob') }
      });
      expect(response.statusCode).toBe(403);
    });

    test('lets a production admin list the members', async () => {
      mockDbManager.getUserById
        .mockResolvedValueOnce({
          _id: 'user-1',
          username: 'alice',
          passwordHash: 'unused',
          displayName: 'Alice',
          createdAt: '2024-01-01T00:00:00.000Z'
        })
        .mockResolvedValueOnce({
          _id: 'user-2',
          username: 'bob',
          passwordHash: 'unused',
          displayName: 'Bob',
          alias: 'Bobby',
          createdAt: '2024-01-01T00:00:00.000Z'
        });
      mockDbManager.getMembership.mockResolvedValueOnce({
        _id: 'm1',
        userId: 'user-1',
        productionId: 1,
        role: 'admin'
      });
      mockDbManager.getMembershipsForProduction.mockResolvedValueOnce([
        { _id: 'm2', userId: 'user-2', productionId: 1, role: 'producer' }
      ]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/production/1/members',
        headers: { cookie: cookieFor('user-1', 'alice') }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.members).toEqual([
        {
          userId: 'user-2',
          username: 'bob',
          displayName: 'Bob',
          alias: 'Bobby',
          role: 'producer'
        }
      ]);
    });
  });

  describe('PATCH /production/:productionId/members/:userId', () => {
    test('changes a member role', async () => {
      mockDbManager.getUserById
        .mockResolvedValueOnce({
          _id: 'user-1',
          username: 'alice',
          passwordHash: 'unused',
          displayName: 'Alice',
          createdAt: '2024-01-01T00:00:00.000Z'
        })
        .mockResolvedValueOnce({
          _id: 'user-2',
          username: 'bob',
          passwordHash: 'unused',
          displayName: 'Bob',
          createdAt: '2024-01-01T00:00:00.000Z'
        });
      mockDbManager.getMembership
        .mockResolvedValueOnce({
          _id: 'm1',
          userId: 'user-1',
          productionId: 1,
          role: 'admin'
        })
        .mockResolvedValueOnce({
          _id: 'm2',
          userId: 'user-2',
          productionId: 1,
          role: 'participant'
        });
      mockDbManager.updateMembershipRole.mockResolvedValueOnce({
        _id: 'm2',
        userId: 'user-2',
        productionId: 1,
        role: 'admin'
      });

      const response = await server.inject({
        method: 'PATCH',
        url: '/api/v1/production/1/members/user-2',
        headers: { cookie: cookieFor('user-1', 'alice') },
        body: { role: 'admin' }
      });

      expect(response.statusCode).toBe(200);
      expect(mockDbManager.updateMembershipRole).toHaveBeenCalledWith(
        'user-2',
        1,
        'admin'
      );
    });

    test('returns 404 when the membership does not exist', async () => {
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: 'unused',
        displayName: 'Alice',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembership
        .mockResolvedValueOnce({
          _id: 'm1',
          userId: 'user-1',
          productionId: 1,
          role: 'admin'
        })
        .mockResolvedValueOnce(undefined);

      const response = await server.inject({
        method: 'PATCH',
        url: '/api/v1/production/1/members/ghost',
        headers: { cookie: cookieFor('user-1', 'alice') },
        body: { role: 'admin' }
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /production/:productionId/members/:userId', () => {
    test('removes a member from the production', async () => {
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: 'unused',
        displayName: 'Alice',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembership
        .mockResolvedValueOnce({
          _id: 'm1',
          userId: 'user-1',
          productionId: 1,
          role: 'admin'
        })
        .mockResolvedValueOnce({
          _id: 'm2',
          userId: 'user-2',
          productionId: 1,
          role: 'participant'
        });

      const response = await server.inject({
        method: 'DELETE',
        url: '/api/v1/production/1/members/user-2',
        headers: { cookie: cookieFor('user-1', 'alice') }
      });

      expect(response.statusCode).toBe(200);
      expect(mockDbManager.deleteMembership).toHaveBeenCalledWith('user-2', 1);
    });

    test('returns 404 when the membership does not exist', async () => {
      mockDbManager.getUserById.mockResolvedValueOnce({
        _id: 'user-1',
        username: 'alice',
        passwordHash: 'unused',
        displayName: 'Alice',
        createdAt: '2024-01-01T00:00:00.000Z'
      });
      mockDbManager.getMembership
        .mockResolvedValueOnce({
          _id: 'm1',
          userId: 'user-1',
          productionId: 1,
          role: 'admin'
        })
        .mockResolvedValueOnce(undefined);

      const response = await server.inject({
        method: 'DELETE',
        url: '/api/v1/production/1/members/ghost',
        headers: { cookie: cookieFor('user-1', 'alice') }
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
