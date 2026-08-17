export const RedisKeys = {
    ngoDetails: (ngoId: string) => `ngo:${ngoId}:details`,
    pendingNgoCount: () => `ngos:pending:count`,
};