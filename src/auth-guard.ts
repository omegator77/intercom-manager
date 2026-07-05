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
