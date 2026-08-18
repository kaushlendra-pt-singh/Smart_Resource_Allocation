export const RedisKeys = {
    ngoDetails: (ngoId: string) => `ngo:${ngoId}:details`,//name, verificationStatus, location, adminId, ngoAdmins, ngoWorkers
    pendingNgoCount: () => `ngos:pending:count`,// Integer count of unverified NGOs.
    ngoLocations: ()=> "ngos:locations" //<longitude> <latitude> & <ngoId>
};