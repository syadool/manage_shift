export type SessionUser = { id: string; displayName: string };

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser | null };
};
