"""
Per-NGO permissions from the JWT issued by auth_svc.

Token fields used:
  role        global role (SUPER_ADMIN / NGO_ADMIN / NGO_WORKER / ...)
  ngoId       the NGO this user OWNS (registered), or null
  joinedNGOs  [{ngoId, roleInNGO}]  every NGO the user belongs to and their role THERE

Rights for a specific NGO always come from joinedNGOs (any admin of an NGO has admin rights for it),
never from the global role alone.
"""
from typing import Any, Dict, List, Optional, Set

User = Dict[str, Any]


def uid(user: User) -> str:
    return str(user.get("_id") or user.get("userId") or "unknown")


def role(user: User) -> str:
    return str(user.get("role", "")).upper()


def is_super(user: User) -> bool:
    return role(user) == "SUPER_ADMIN"


def owned_ngo(user: User) -> str:
    return str(user.get("ngoId") or "")


def _memberships(user: User) -> List[Dict[str, Any]]:
    joined = user.get("joinedNGOs") or []
    return [j for j in joined if isinstance(j, dict) and j.get("ngoId")]


def role_in(user: User, ngo_id: Optional[str]) -> Optional[str]:
    if not ngo_id:
        return None
    for j in _memberships(user):
        if str(j["ngoId"]) == str(ngo_id):
            return str(j.get("roleInNGO", "")).upper()
    return None


def is_admin_of(user: User, ngo_id: Optional[str]) -> bool:
    """Any admin of this NGO, or a super admin."""
    return is_super(user) or role_in(user, ngo_id) == "NGO_ADMIN"


def is_staff_of(user: User, ngo_id: Optional[str]) -> bool:
    """Admin or worker of this NGO, or a super admin."""
    return is_super(user) or role_in(user, ngo_id) in {"NGO_ADMIN", "NGO_WORKER"}


def staff_ngo_ids(user: User) -> Set[str]:
    """NGOs where the user is admin or worker (the NGOs they can act for)."""
    return {
        str(j["ngoId"])
        for j in _memberships(user)
        if str(j.get("roleInNGO", "")).upper() in {"NGO_ADMIN", "NGO_WORKER"}
    }
