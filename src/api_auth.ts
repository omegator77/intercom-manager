import { randomBytes } from 'node:crypto';
import { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  AcceptInviteRequest,
  CreateInviteRequest,
  ErrorResponse,
  InviteInfoResponse,
  InviteResponse,
  LoginRequest,
  MeResponse,
  MemberInfo,
  MembersListResponse,
  MembershipInfo,
  PublicUser,
  UpdateMeRequest,
  UpdateMemberRoleRequest
} from './models';
import { DbManager } from './db/interface';
import { hashPassword, verifyPassword } from './password';
import { requireProductionRole } from './auth-guard';
import { Log } from './log';
import './auth-types';

const AUTH_COOKIE_NAME = 'auth_token';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function productionIdFromParams(request: FastifyRequest): number {
  return Number((request.params as { productionId: string }).productionId);
}

export interface ApiAuthOptions {
  dbManager: DbManager;
  publicHost: string;
}

function toPublicUser(user: {
  _id: string;
  username: string;
  displayName: string;
  alias?: string;
  isSuperAdmin?: boolean;
}): PublicUser {
  return {
    id: user._id,
    username: user.username,
    displayName: user.displayName,
    alias: user.alias,
    isSuperAdmin: user.isSuperAdmin
  };
}

const apiAuth: FastifyPluginCallback<ApiAuthOptions> = (
  fastify,
  opts,
  next
) => {
  const { dbManager } = opts;

  async function buildMeResponse(userId: string): Promise<MeResponse> {
    const user = await dbManager.getUserById(userId);
    if (!user) {
      throw new Error(`User with id "${userId}" no longer exists`);
    }
    const memberships = await dbManager.getMembershipsForUser(userId);
    const membershipInfo: MembershipInfo[] = memberships.map((m) => ({
      productionId: m.productionId,
      role: m.role
    }));
    return { user: toPublicUser(user), memberships: membershipInfo };
  }

  fastify.post<{
    Body: LoginRequest;
    Reply: MeResponse | ErrorResponse;
  }>(
    '/auth/login',
    {
      schema: {
        description: 'Log in with username and password.',
        body: LoginRequest,
        response: { 200: MeResponse, 401: ErrorResponse }
      }
    },
    async (request, reply) => {
      const { username, password } = request.body;
      const user = await dbManager.getUserByUsername(username);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return reply.code(401).send({ message: 'Invalid credentials' });
      }

      const token = fastify.jwt.sign(
        { userId: user._id, username: user.username },
        { expiresIn: '7d' }
      );
      reply.cookie(AUTH_COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 60 * 60 * 24 * 7
      });

      return reply.send(await buildMeResponse(user._id));
    }
  );

  fastify.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    reply.code(204).send();
  });

  fastify.get<{
    Reply: MeResponse | ErrorResponse;
  }>(
    '/auth/me',
    {
      schema: {
        description: 'Get the currently logged in user and their roles.',
        response: { 200: MeResponse, 401: ErrorResponse }
      }
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ message: 'Login required' });
      }
      return reply.send(await buildMeResponse(request.user.userId));
    }
  );

  fastify.patch<{
    Body: UpdateMeRequest;
    Reply: MeResponse | ErrorResponse;
  }>(
    '/auth/me',
    {
      schema: {
        description: "Update the current user's display alias.",
        body: UpdateMeRequest,
        response: { 200: MeResponse, 401: ErrorResponse }
      }
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ message: 'Login required' });
      }
      await dbManager.updateUserAlias(request.user.userId, request.body.alias);
      return reply.send(await buildMeResponse(request.user.userId));
    }
  );

  fastify.post<{
    Body: CreateInviteRequest;
    Reply: InviteResponse | ErrorResponse;
  }>(
    '/auth/invite',
    {
      preHandler: requireProductionRole(
        dbManager,
        ['admin', 'producer'],
        (request) => (request.body as CreateInviteRequest).productionId
      ),
      schema: {
        description:
          'Create an invite link for a production, scoped to a role.',
        body: CreateInviteRequest,
        response: {
          200: InviteResponse,
          401: ErrorResponse,
          403: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      const { productionId, role } = request.body;
      const token = randomBytes(24).toString('base64url');

      const invite = await dbManager.createInvite({
        token,
        productionId,
        role,
        createdBy: request.user?.userId ?? '',
        expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString()
      });

      return reply.send({
        token: invite.token,
        url: new URL(`/invite/${invite.token}`, opts.publicHost).toString()
      });
    }
  );

  fastify.get<{
    Params: { token: string };
    Reply: InviteInfoResponse | ErrorResponse;
  }>(
    '/auth/invite/:token',
    {
      schema: {
        description: 'Get metadata about an invite link (no login required).',
        response: {
          200: InviteInfoResponse,
          404: ErrorResponse,
          410: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      const invite = await dbManager.getInviteByToken(request.params.token);
      if (!invite) {
        return reply.code(404).send({ message: 'Invite not found' });
      }
      if (invite.usedBy || new Date(invite.expiresAt).getTime() < Date.now()) {
        return reply.code(410).send({ message: 'Invite is no longer valid' });
      }

      const production = await dbManager.getProduction(invite.productionId);
      if (!production) {
        return reply.code(404).send({ message: 'Production not found' });
      }

      return reply.send({
        productionId: invite.productionId,
        productionName: production.name,
        role: invite.role
      });
    }
  );

  fastify.post<{
    Params: { token: string };
    Body: AcceptInviteRequest;
    Reply: MeResponse | ErrorResponse;
  }>(
    '/auth/invite/:token/accept',
    {
      schema: {
        description:
          'Accept an invite: create an account and join the production.',
        body: AcceptInviteRequest,
        response: {
          200: MeResponse,
          400: ErrorResponse,
          404: ErrorResponse,
          410: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      const invite = await dbManager.getInviteByToken(request.params.token);
      if (!invite) {
        return reply.code(404).send({ message: 'Invite not found' });
      }
      if (invite.usedBy || new Date(invite.expiresAt).getTime() < Date.now()) {
        return reply.code(410).send({ message: 'Invite is no longer valid' });
      }

      const { username, password, displayName } = request.body;
      const existing = await dbManager.getUserByUsername(username);
      if (existing) {
        return reply.code(400).send({ message: 'Username already taken' });
      }

      const passwordHash = await hashPassword(password);
      const user = await dbManager.createUser({
        username,
        passwordHash,
        displayName,
        createdAt: new Date().toISOString()
      });

      await dbManager.createMembership({
        userId: user._id,
        productionId: invite.productionId,
        role: invite.role
      });
      await dbManager.markInviteUsed(invite.token, user._id);

      const token = fastify.jwt.sign(
        { userId: user._id, username: user.username },
        { expiresIn: '7d' }
      );
      reply.cookie(AUTH_COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 60 * 60 * 24 * 7
      });

      Log().info(
        `New user "${username}" joined production ${invite.productionId}`
      );
      return reply.send(await buildMeResponse(user._id));
    }
  );

  fastify.get<{
    Params: { productionId: string };
    Reply: MembersListResponse | ErrorResponse;
  }>(
    '/production/:productionId/members',
    {
      preHandler: requireProductionRole(
        dbManager,
        ['admin'],
        productionIdFromParams
      ),
      schema: {
        description: 'List the members of a production and their role.',
        response: {
          200: MembersListResponse,
          401: ErrorResponse,
          403: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      const productionId = productionIdFromParams(request);
      const memberships = await dbManager.getMembershipsForProduction(
        productionId
      );

      const members: MemberInfo[] = [];
      for (const membership of memberships) {
        // eslint-disable-next-line no-await-in-loop
        const user = await dbManager.getUserById(membership.userId);
        if (!user) continue;
        members.push({
          userId: user._id,
          username: user.username,
          displayName: user.displayName,
          alias: user.alias,
          role: membership.role
        });
      }

      return reply.send({ members });
    }
  );

  fastify.patch<{
    Params: { productionId: string; userId: string };
    Body: UpdateMemberRoleRequest;
    Reply: MemberInfo | ErrorResponse;
  }>(
    '/production/:productionId/members/:userId',
    {
      preHandler: requireProductionRole(
        dbManager,
        ['admin'],
        productionIdFromParams
      ),
      schema: {
        description: "Change a member's role for a production.",
        body: UpdateMemberRoleRequest,
        response: {
          200: MemberInfo,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      const productionId = productionIdFromParams(request);
      const { userId } = request.params;

      const existing = await dbManager.getMembership(userId, productionId);
      if (!existing) {
        return reply.code(404).send({ message: 'Membership not found' });
      }

      const updated = await dbManager.updateMembershipRole(
        userId,
        productionId,
        request.body.role
      );
      const user = await dbManager.getUserById(userId);
      if (!updated || !user) {
        return reply.code(404).send({ message: 'Membership not found' });
      }

      return reply.send({
        userId: user._id,
        username: user.username,
        displayName: user.displayName,
        alias: user.alias,
        role: updated.role
      });
    }
  );

  fastify.delete<{
    Params: { productionId: string; userId: string };
    Reply: string | ErrorResponse;
  }>(
    '/production/:productionId/members/:userId',
    {
      preHandler: requireProductionRole(
        dbManager,
        ['admin'],
        productionIdFromParams
      ),
      schema: {
        description: 'Remove a member from a production.',
        response: {
          200: Type.String(),
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      const productionId = productionIdFromParams(request);
      const { userId } = request.params;

      const existing = await dbManager.getMembership(userId, productionId);
      if (!existing) {
        return reply.code(404).send({ message: 'Membership not found' });
      }

      await dbManager.deleteMembership(userId, productionId);
      return reply.send('removed');
    }
  );

  next();
};

export default apiAuth;
export { AUTH_COOKIE_NAME };
