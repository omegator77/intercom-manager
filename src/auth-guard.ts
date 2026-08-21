import { FastifyReply, FastifyRequest } from 'fastify';
import './auth-types';
import { DbManager } from './db/interface';
import { User, UserRole } from './models';

export async function getRequestUser(
  dbManager: DbManager,
  request: FastifyRequest
): Promise<User | undefined> {
  if (!request.user) return undefined;
  return dbManager.getUserById(request.user.userId);
}

/** Only the bootstrap admin account (and anyone later promoted) may create productions or manage roles across productions. */
export function requireSuperAdmin(dbManager: DbManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await getRequestUser(dbManager, request);
    if (!user) {
      return reply.code(401).send({ message: 'Login required' });
    }
    if (!user.isSuperAdmin) {
      return reply.code(403).send({ message: 'Requires admin account' });
    }
  };
}

/** Requires the caller to hold one of `roles` on the production identified by `getProductionId`, or be a super admin. */
export function requireProductionRole(
  dbManager: DbManager,
  roles: UserRole[],
  getProductionId: (request: FastifyRequest) => number
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await getRequestUser(dbManager, request);
    if (!user) {
      return reply.code(401).send({ message: 'Login required' });
    }
    if (user.isSuperAdmin) return;

    const productionId = getProductionId(request);
    const membership = await dbManager.getMembership(user._id, productionId);
    if (!membership || !roles.includes(membership.role)) {
      return reply.code(403).send({ message: 'Insufficient permissions' });
    }
  };
}

const ALL_ROLES: UserRole[] = ['admin', 'producer', 'participant'];

/** Requires the caller to hold ANY role on the production (i.e. be a member), or be a super admin. Used to gate browsing/joining. */
export function requireProductionMembership(
  dbManager: DbManager,
  getProductionId: (request: FastifyRequest) => number
) {
  return requireProductionRole(dbManager, ALL_ROLES, getProductionId);
}

/**
 * Requires the caller to be a member of the production that owns the
 * `:sessionId` route param, or be a super admin. The production isn't known
 * upfront (unlike POST /session, which is guarded by productionId in the
 * body) so it's looked up from the session record itself. Mirrors the same
 * membership check POST /session already enforces when the session was
 * created, so no legitimate caller of PATCH/DELETE /session/:sessionId is
 * affected. If the session doesn't exist, membership can't be checked here;
 * the route handler is left to report "not found" as it already does.
 */
export function requireSessionAccess(dbManager: DbManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await getRequestUser(dbManager, request);
    if (!user) {
      return reply.code(401).send({ message: 'Login required' });
    }
    if (user.isSuperAdmin) return;

    const { sessionId } = request.params as { sessionId: string };
    const session = await dbManager.getSession(sessionId);
    if (!session) return;

    const productionId = parseInt(session.productionId, 10);
    const membership = await dbManager.getMembership(user._id, productionId);
    if (!membership) {
      return reply.code(403).send({ message: 'Insufficient permissions' });
    }
  };
}
