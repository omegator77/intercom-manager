import '@fastify/jwt';

// Populated by @fastify/jwt from the auth cookie, when present and valid.
// Requests without one stay unauthenticated (request.user is null) so that
// share links and WHIP/WHEP devices keep working without an account.
export interface AuthenticatedUser {
  userId: string;
  username: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthenticatedUser;
    user: AuthenticatedUser | null;
  }
}
