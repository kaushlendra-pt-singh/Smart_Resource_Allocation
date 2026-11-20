import type { Request } from "express";

type User = NonNullable<Request["user"]>;

// Per-NGO permissions come from the token's joinedNGOs (set by auth_svc), NOT from the global role:
// a user can be NGO_ADMIN of one NGO and only a worker (or nothing) in another.

export const isSuperAdmin = (user?: User | null): boolean => user?.role === "SUPER_ADMIN";

const roleIn = (user: User | null | undefined, ngoId: string): string | null => {
    if (!user || !ngoId) return null;
    const m = (user.joinedNGOs ?? []).find((j) => String(j.ngoId) === String(ngoId));
    return m ? m.roleInNGO : null;
};

/** Admin of this NGO (any admin, not only the owner) or a super admin. */
export const isAdminOf = (user: User | null | undefined, ngoId: string): boolean =>
    isSuperAdmin(user) || roleIn(user, ngoId) === "NGO_ADMIN";

/** Admin or worker of this NGO, or a super admin. */
export const isStaffOf = (user: User | null | undefined, ngoId: string): boolean =>
    isSuperAdmin(user) || ["NGO_ADMIN", "NGO_WORKER"].includes(roleIn(user, ngoId) ?? "");

/** NGO ids where the user is an admin. */
export const adminNgoIds = (user: User | null | undefined): string[] =>
    (user?.joinedNGOs ?? []).filter((j) => j.roleInNGO === "NGO_ADMIN").map((j) => String(j.ngoId));
